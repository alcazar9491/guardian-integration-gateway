import { createSecretKey, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { compose, type ComposedApplication } from '../../src/composition-root.js';
import { DecryptionError } from '../../src/secure-inquiry/application/errors.js';
import { auditAssociatedData } from '../../src/secure-inquiry/domain/audit-associated-data.js';
import type { AuditOutcome } from '../../src/secure-inquiry/domain/audit-record.js';
import { AesGcmEncryptionService } from '../../src/secure-inquiry/infrastructure/aes-gcm-encryption-service.js';
import { abortableDelay, type Delay } from '../../src/secure-inquiry/infrastructure/ai-provider/abortable-delay.js';
import { failFirst } from '../../src/secure-inquiry/infrastructure/ai-provider/outcome-schedule.js';
import { JsonlAuditRepository } from '../../src/secure-inquiry/infrastructure/audit/jsonl-audit-repository.js';
import { parseAuditLine } from '../../src/secure-inquiry/infrastructure/audit/stored-audit-record.js';
import { loadConfig, type AppConfig } from '../../src/shared/config/app-config.js';
import { createLogger } from '../../src/shared/logging/logger.js';
import type { CircuitState } from '../../src/shared/resilience/circuit-breaker.js';

const PROVIDER_DELAY_MS = 2000;
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 30_000;
// The real provider delay minus a margin for timer jitter: the provider actually ran.
const PROVIDER_RAN_MS = 1900;
// Far below one provider delay: the provider was not awaited.
const FAIL_FAST_MS = 500;

const SERVICE_BUSY = 'Service Busy';
const USER_ID = 'e2e-circuit-user-7731';
const EMAIL = 'ada.lovelace@example.com';
const CARD = '4111 1111 1111 1111';
const SSN = '123-45-6789';
const PHRASE = 'lighthouse maintenance window';
const MESSAGE = `Please email ${EMAIL} about the ${PHRASE}; card ${CARD}, SSN ${SSN}.`;
const SANITIZED = `Please email <REDACTED: EMAIL> about the ${PHRASE}; card <REDACTED: CREDIT_CARD>, SSN <REDACTED: SSN>.`;
/** Never in a response body, a log line, or the audit file. */
const SECRETS = [MESSAGE, EMAIL, CARD, CARD.replaceAll(' ', ''), SSN];

const EXPECTED_OUTCOMES: readonly AuditOutcome[] = [
  'PROVIDER_FAILURE',
  'PROVIDER_FAILURE',
  'PROVIDER_FAILURE',
  'CIRCUIT_OPEN_FALLBACK',
  'CIRCUIT_OPEN_FALLBACK',
  'COMPLETED',
];

class ManualClock {
  private current = Date.parse('2026-10-27T09:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

interface CircuitReading {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
}

interface InquiryResponse {
  readonly requestId: string;
  readonly inquiryId: string;
  readonly status: string;
  readonly source: string;
  readonly reason?: string;
  readonly sanitizedMessage: string;
  readonly reply: string;
}

interface Exchange {
  readonly number: number;
  readonly body: InquiryResponse;
  readonly elapsedMs: number;
  readonly providerCalls: number;
  readonly circuit: CircuitReading;
}

interface Gateway {
  readonly composed: ComposedApplication;
  readonly config: AppConfig;
  readonly clock: ManualClock;
  readonly logLines: readonly string[];
  providerCalls(): number;
}

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startGateway(): Promise<Gateway> {
  const directory = await mkdtemp(join(tmpdir(), 'guardian-e2e-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));

  const config = loadConfig({
    NODE_ENV: 'test',
    AUDIT_FILE_PATH: join(directory, 'audit.jsonl'),
    // Generated per run: no key material is committed or reused across runs.
    AUDIT_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AUDIT_USER_REF_KEY: randomBytes(32).toString('base64'),
    AI_PROVIDER_DELAY_MS: String(PROVIDER_DELAY_MS),
    AI_PROVIDER_TIMEOUT_MS: '5000',
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: String(FAILURE_THRESHOLD),
    CIRCUIT_BREAKER_COOLDOWN_MS: String(COOLDOWN_MS),
  });
  const logLines: string[] = [];
  const logger = createLogger({ level: 'trace', destination: { write: (line: string) => logLines.push(line) } });
  const clock = new ManualClock();
  let providerCalls = 0;
  // The mock provider waits exactly once per invocation, so counting its real delays counts provider calls.
  const countingDelay: Delay = (ms, signal) => {
    providerCalls += 1;
    return abortableDelay(ms, signal);
  };

  const composed = compose(config, logger, {
    clock,
    aiOutcomeSchedule: failFirst(FAILURE_THRESHOLD),
    aiDelay: countingDelay,
  });
  cleanups.push(() => composed.shutdown());

  return { composed, config, clock, logLines, providerCalls: () => providerCalls };
}

const responseIds = () => ({ requestId: expect.any(String) as unknown, inquiryId: expect.any(String) as unknown });

function degraded(reason: string) {
  return {
    ...responseIds(),
    status: 'DEGRADED',
    source: 'FALLBACK',
    reason,
    sanitizedMessage: SANITIZED,
    reply: SERVICE_BUSY,
  };
}

function describeExchange({ number, body, elapsedMs, providerCalls, circuit }: Exchange): string {
  const outcome = body.reason === undefined ? body.status : `${body.status}/${body.reason}`;
  return (
    `request ${number}: ${outcome} reply="${body.reply}" in ${Math.round(elapsedMs)} ms; ` +
    `provider calls ${providerCalls}; circuit ${circuit.state}/${circuit.consecutiveFailures}`
  );
}

function expectFailFast(exchange: Exchange): void {
  expect(exchange.body).toEqual(degraded('CIRCUIT_OPEN'));
  expect(exchange.elapsedMs).toBeLessThan(FAIL_FAST_MS);
  expect(exchange.providerCalls).toBe(FAILURE_THRESHOLD);
  expect(exchange.circuit).toEqual({ state: 'OPEN', consecutiveFailures: FAILURE_THRESHOLD });
}

function expectTransitionLogs(logLines: readonly string[]): void {
  const transitions = logLines
    .map((line) => JSON.parse(line) as { level: number; msg?: string; circuit?: unknown })
    .filter((record) => record.msg === 'AI provider circuit state changed')
    .map(({ level, circuit }) => ({ level, circuit }));

  expect(transitions).toEqual([
    { level: 40, circuit: { from: 'CLOSED', to: 'OPEN' } },
    { level: 30, circuit: { from: 'OPEN', to: 'HALF_OPEN' } },
    { level: 30, circuit: { from: 'HALF_OPEN', to: 'CLOSED' } },
  ]);
  const logText = logLines.join('');
  for (const secret of [...SECRETS, USER_ID]) expect(logText).not.toContain(secret);
}

async function expectAuditTrail(config: AppConfig, inquiryIds: readonly string[]): Promise<string> {
  const auditText = await readFile(config.audit.filePath, 'utf8');
  const lines = auditText.split('\n').filter((line) => line !== '');
  const records = lines.map((line) => parseAuditLine(line)).filter((record) => record !== undefined);
  const { records: latest, invalidLines } = await new JsonlAuditRepository({ filePath: config.audit.filePath }).scan();

  expect(lines).toHaveLength(2 * EXPECTED_OUTCOMES.length);
  expect(records).toHaveLength(lines.length);
  expect(invalidLines).toBe(0);
  expect(latest).toHaveLength(EXPECTED_OUTCOMES.length);

  // Each response's inquiryId is an auditId with exactly two revisions, in request order.
  expect(new Set(inquiryIds).size).toBe(inquiryIds.length);
  expect(new Set(records.map((record) => record.auditId))).toEqual(new Set(inquiryIds));
  const trailOf = (auditId: string) =>
    records.filter((record) => record.auditId === auditId).map((record) => [record.revision, record.outcome]);
  expect(inquiryIds.map(trailOf)).toEqual(
    EXPECTED_OUTCOMES.map((outcome) => [
      [1, 'PENDING'],
      [2, outcome],
    ]),
  );

  for (const record of records) {
    expect(record.sanitizedMessage).toBe(SANITIZED);
    expect(record.redactions).toEqual({ EMAIL: 1, CREDIT_CARD: 1, SSN: 1 });
  }
  // One user, one stable pseudonym.
  expect(new Set(records.map((record) => record.userRef)).size).toBe(1);
  expect(auditText).toContain(PHRASE);
  for (const secret of [...SECRETS, USER_ID]) expect(auditText).not.toContain(secret);

  const decryptor = new AesGcmEncryptionService({ key: config.audit.encryptionKey, keyId: config.audit.keyId });
  const wrongKey = new AesGcmEncryptionService({ key: createSecretKey(randomBytes(32)), keyId: config.audit.keyId });
  for (const { auditId, userRef, encryptedMessage } of records) {
    const associatedData = auditAssociatedData({ auditId, userRef });
    expect(decryptor.decrypt(encryptedMessage, associatedData)).toBe(MESSAGE);
    expect(() => wrongKey.decrypt(encryptedMessage, associatedData)).toThrow(
      new DecryptionError('AUTHENTICATION_FAILED'),
    );
  }

  return (
    `audit: ${lines.length} lines, ${invalidLines} invalid; outcomes ${inquiryIds.map(trailOf).map((trail) => trail[1]?.[1]).join(', ')}; ` +
    `${records.length}/${lines.length} decrypted to the original, wrong key rejected for all`
  );
}

describe('E2E: circuit breaker behind POST /secure-inquiry', () => {
  it(
    'opens after three slow provider failures, answers "Service Busy" without calling the provider, and recovers after the cooldown',
    { timeout: 20_000 },
    async ({ annotate }) => {
      const gateway = await startGateway();
      const { app, circuit } = gateway.composed;
      const readCircuit = (): CircuitReading => ({
        state: circuit.state,
        consecutiveFailures: circuit.consecutiveFailures,
      });
      const exchanges: Exchange[] = [];

      const send = async (): Promise<Exchange> => {
        const startedAt = performance.now();
        const response = await request(app).post('/secure-inquiry').send({ userId: USER_ID, message: MESSAGE });
        const exchange: Exchange = {
          number: exchanges.length + 1,
          body: response.body as InquiryResponse,
          elapsedMs: performance.now() - startedAt,
          providerCalls: gateway.providerCalls(),
          circuit: readCircuit(),
        };
        exchanges.push(exchange);
        await annotate(describeExchange(exchange), 'measurement');

        expect(response.status).toBe(200);
        for (const secret of SECRETS) expect(response.text).not.toContain(secret);
        return exchange;
      };

      // 1. Untouched: CLOSED, no failures, no provider calls.
      expect(readCircuit()).toEqual({ state: 'CLOSED', consecutiveFailures: 0 });
      expect(gateway.providerCalls()).toBe(0);

      // 2. Three failures, each paying the real provider delay; the third opens the circuit.
      const circuitAfterFailure: readonly CircuitReading[] = [
        { state: 'CLOSED', consecutiveFailures: 1 },
        { state: 'CLOSED', consecutiveFailures: 2 },
        { state: 'OPEN', consecutiveFailures: 3 },
      ];
      for (const [index, expectedCircuit] of circuitAfterFailure.entries()) {
        const failed = await send();
        expect(failed.body).toEqual(degraded('PROVIDER_ERROR'));
        expect(failed.elapsedMs).toBeGreaterThanOrEqual(PROVIDER_RAN_MS);
        expect(failed.providerCalls).toBe(index + 1);
        expect(failed.circuit).toEqual(expectedCircuit);
      }

      // 3. OPEN: the fallback comes back immediately and the provider is not called.
      expectFailFast(await send());

      // 4. One millisecond before the cooldown ends the circuit still fails fast.
      gateway.clock.advance(COOLDOWN_MS - 1);
      expectFailFast(await send());

      // 5. Cooldown elapsed: a single probe reaches the provider, succeeds, and closes the circuit.
      gateway.clock.advance(1);
      const probe = await send();
      expect(probe.body).toEqual({
        ...responseIds(),
        status: 'COMPLETED',
        source: 'AI_PROVIDER',
        sanitizedMessage: SANITIZED,
        reply: `Generated Answer: ${SANITIZED}`,
      });
      expect(probe.elapsedMs).toBeGreaterThanOrEqual(PROVIDER_RAN_MS);
      expect(probe.providerCalls).toBe(FAILURE_THRESHOLD + 1);
      expect(probe.circuit).toEqual({ state: 'CLOSED', consecutiveFailures: 0 });

      // 6. Transitions are logged in order, and no log line carries the message, its PII, or the raw userId.
      expectTransitionLogs(gateway.logLines);
      await annotate('transitions: CLOSED->OPEN (warn), OPEN->HALF_OPEN (info), HALF_OPEN->CLOSED (info)', 'measurement');

      // 7. Every inquiry is audited, pseudonymized, encrypted, and free of plaintext PII.
      const auditSummary = await expectAuditTrail(
        gateway.config,
        exchanges.map((exchange) => exchange.body.inquiryId),
      );
      await annotate(auditSummary, 'measurement');
    },
  );
});
