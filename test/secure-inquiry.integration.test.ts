import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compose, type CompositionOverrides } from '../src/composition-root.js';
import { SERVICE_BUSY_REPLY } from '../src/secure-inquiry/application/ai-fallback.js';
import { auditAssociatedData } from '../src/secure-inquiry/domain/audit-associated-data.js';
import type { PersistedAuditRecord } from '../src/secure-inquiry/domain/audit-record.js';
import { AesGcmEncryptionService } from '../src/secure-inquiry/infrastructure/aes-gcm-encryption-service.js';
import { abortableDelay, type Delay } from '../src/secure-inquiry/infrastructure/ai-provider/abortable-delay.js';
import { failFirst } from '../src/secure-inquiry/infrastructure/ai-provider/outcome-schedule.js';
import { JsonlAuditRepository } from '../src/secure-inquiry/infrastructure/audit/jsonl-audit-repository.js';
import { loadConfig, type AppConfig } from '../src/shared/config/app-config.js';
import { createLogger } from '../src/shared/logging/logger.js';
import { errnoError, fakeAuditFileSystem } from './secure-inquiry/infrastructure/audit/fake-audit-file-system.js';

const USER_ID = 'jane.doe@example.com';
const EMAIL = 'jane.doe@example.com';
const CARD = '4111 1111 1111 1111';
const SSN = '123-45-6789';
const PII_MESSAGE = `Email ${EMAIL}, card ${CARD}, SSN ${SSN}.`;
const SANITIZED_PII = 'Email <REDACTED: EMAIL>, card <REDACTED: CREDIT_CARD>, SSN <REDACTED: SSN>.';
const PLAIN_MESSAGE = 'What are your opening hours?';
const COOLDOWN_MS = 30_000;

/** Never in any response body: raw PII, the raw userId, stack traces, or encryption internals. */
const FORBIDDEN_IN_RESPONSES = [EMAIL, CARD, SSN, '"stack"', '    at ', 'ciphertext', 'authTag', '"iv"', 'userRef', 'encryptedMessage'];

class FakeClock {
  private current = Date.parse('2026-10-27T12:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

interface ResponseBody {
  requestId: string;
  inquiryId: string;
  status: string;
  source: string;
  reason?: string;
  sanitizedMessage: string;
  reply: string;
  error?: { code: string; message: string; details?: unknown[] };
}

interface Harness {
  readonly app: Express;
  readonly config: AppConfig;
  readonly auditFile: string;
  readonly clock: FakeClock;
  providerCalls(): number;
  logs(): string;
  auditLines(): Promise<PersistedAuditRecord[]>;
  auditText(): Promise<string>;
  decrypt(record: PersistedAuditRecord): string;
}

interface HarnessOptions {
  readonly env?: Record<string, string>;
  readonly overrides?: CompositionOverrides;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startHarness({ env = {}, overrides = {} }: HarnessOptions = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'guardian-integration-'));
  const auditFile = join(directory, 'audit.jsonl');
  const config = loadConfig({
    NODE_ENV: 'test',
    AUDIT_FILE_PATH: auditFile,
    AUDIT_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AUDIT_USER_REF_KEY: randomBytes(32).toString('base64'),
    AI_PROVIDER_DELAY_MS: '20',
    AI_PROVIDER_TIMEOUT_MS: '2000',
    CIRCUIT_BREAKER_COOLDOWN_MS: String(COOLDOWN_MS),
    ...env,
  });
  const lines: string[] = [];
  const logger = createLogger({ level: 'trace', destination: { write: (line: string) => lines.push(line) } });
  const clock = new FakeClock();
  let providerCalls = 0;
  // The mock provider waits once per invocation, so counting delays counts provider calls.
  const countingDelay: Delay = (ms, signal) => {
    providerCalls += 1;
    return abortableDelay(ms, signal);
  };
  const { app, shutdown } = compose(config, logger, { clock, aiDelay: countingDelay, ...overrides });
  const decryptor = new AesGcmEncryptionService({ key: config.audit.encryptionKey, keyId: config.audit.keyId });

  cleanups.push(async () => {
    await shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  const auditText = async () => {
    try {
      return await readFile(auditFile, 'utf8');
    } catch {
      return '';
    }
  };

  return {
    app,
    config,
    auditFile,
    clock,
    providerCalls: () => providerCalls,
    logs: () => lines.join(''),
    auditText,
    auditLines: async () =>
      (await auditText())
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as PersistedAuditRecord),
    decrypt: (record) => decryptor.decrypt(record.encryptedMessage, auditAssociatedData(record)),
  };
}

function bodyOf(response: { body: unknown }): ResponseBody {
  return response.body as ResponseBody;
}

function expectNoLeak(text: string): void {
  for (const forbidden of FORBIDDEN_IN_RESPONSES) expect(text).not.toContain(forbidden);
}

function post(app: Express, body: unknown) {
  return request(app).post('/secure-inquiry').send(body as object);
}

async function timedPost(app: Express, body: unknown) {
  const startedAt = performance.now();
  const response = await post(app, body);
  return { response, elapsedMs: performance.now() - startedAt };
}

async function latestOutcomes(harness: Harness): Promise<string[]> {
  const latest = new Map<string, PersistedAuditRecord>();
  for (const record of await harness.auditLines()) latest.set(record.auditId, record);
  return [...latest.values()].map((record) => record.outcome);
}

describe('POST /secure-inquiry: valid requests', () => {
  it('returns the generated answer and audits PENDING then COMPLETED', async () => {
    const harness = await startHarness();

    const response = await post(harness.app, { userId: 'user-123', message: PLAIN_MESSAGE });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      requestId: response.headers['x-request-id'],
      inquiryId: expect.any(String) as unknown,
      status: 'COMPLETED',
      source: 'AI_PROVIDER',
      sanitizedMessage: PLAIN_MESSAGE,
      reply: `Generated Answer: ${PLAIN_MESSAGE}`,
    });
    const records = await harness.auditLines();
    expect(records.map((record) => [record.auditId, record.revision, record.outcome])).toEqual([
      [bodyOf(response).inquiryId, 1, 'PENDING'],
      [bodyOf(response).inquiryId, 2, 'COMPLETED'],
    ]);
    expect(harness.decrypt(records[1] as PersistedAuditRecord)).toBe(PLAIN_MESSAGE);
    expect(harness.providerCalls()).toBe(1);
    expectNoLeak(response.text);
  });
});

describe('POST /secure-inquiry: PII redaction', () => {
  it('sends only redacted text to the provider and never exposes PII in the response, audit file, or logs', async () => {
    const harness = await startHarness();

    const response = await post(harness.app, { userId: USER_ID, message: PII_MESSAGE });

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      sanitizedMessage: SANITIZED_PII,
      // The mock echoes its prompt, so the reply shows exactly what the provider received.
      reply: `Generated Answer: ${SANITIZED_PII}`,
    });
    expectNoLeak(response.text);

    const auditText = await harness.auditText();
    expect(auditText).toContain(SANITIZED_PII);
    for (const value of [EMAIL, CARD, SSN, USER_ID]) {
      expect(auditText).not.toContain(value);
      expect(harness.logs()).not.toContain(value);
    }

    const reader = new JsonlAuditRepository({ filePath: harness.auditFile });
    const record = await reader.findById(bodyOf(response).inquiryId);
    expect(record).toMatchObject({ outcome: 'COMPLETED', redactions: { EMAIL: 1, CREDIT_CARD: 1, SSN: 1 } });
    expect(harness.decrypt(record as PersistedAuditRecord)).toBe(PII_MESSAGE);
  });
});

describe('POST /secure-inquiry: invalid bodies', () => {
  it.each([
    ['missing fields', {}],
    ['missing message', { userId: 'user-123' }],
    ['missing userId', { message: PLAIN_MESSAGE }],
    ['non-string userId', { userId: 42, message: PLAIN_MESSAGE }],
    ['non-string message', { userId: 'user-123', message: { text: PLAIN_MESSAGE } }],
    ['empty userId', { userId: '', message: PLAIN_MESSAGE }],
    ['empty message', { userId: 'user-123', message: '' }],
    ['whitespace-only message', { userId: 'user-123', message: ' \n\t ' }],
    ['unknown field', { userId: 'user-123', message: PLAIN_MESSAGE, isAdmin: true }],
    ['message over 5,000 characters', { userId: 'user-123', message: 'a'.repeat(5001) }],
    ['array body', [{ userId: 'user-123', message: PLAIN_MESSAGE }]],
  ])('rejects %s with 400 without auditing or calling the provider', async (_label, body) => {
    const harness = await startHarness();

    const response = await post(harness.app, body);

    expect(response.status).toBe(400);
    expect(bodyOf(response).error?.code).toBe('VALIDATION_ERROR');
    expect(bodyOf(response).error?.details?.length).toBeGreaterThan(0);
    expect(await harness.auditText()).toBe('');
    expect(harness.providerCalls()).toBe(0);
  });

  it('rejects a body over the size limit with 413', async () => {
    const harness = await startHarness();

    const response = await post(harness.app, { userId: 'user-123', message: `${SSN} ${'a'.repeat(20 * 1024)}` });

    expect(response.status).toBe(413);
    expect(bodyOf(response).error?.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await harness.auditText()).toBe('');
    expect(harness.logs()).not.toContain(SSN);
  });

  it('rejects malformed JSON with 400 without echoing it', async () => {
    const harness = await startHarness();

    const response = await request(harness.app)
      .post('/secure-inquiry')
      .set('Content-Type', 'application/json')
      .send(`{"userId":"user-123","message":"my ssn is ${SSN}"`);

    expect(response.status).toBe(400);
    expect(bodyOf(response).error?.code).toBe('MALFORMED_JSON');
    expectNoLeak(response.text);
    expect(harness.logs()).not.toContain(SSN);
    expect(await harness.auditText()).toBe('');
  });

  it.each([['text/plain'], ['application/json; charset=utf-7']])('rejects Content-Type %s with 415', async (type) => {
    const harness = await startHarness();

    const response = await request(harness.app)
      .post('/secure-inquiry')
      .set('Content-Type', type)
      .send(JSON.stringify({ userId: 'user-123', message: PLAIN_MESSAGE }));

    expect(response.status).toBe(415);
    expect(bodyOf(response).error?.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(harness.providerCalls()).toBe(0);
  });
});

describe('POST /secure-inquiry: provider failures', () => {
  it('returns the Service Busy fallback on a provider error and audits PROVIDER_FAILURE', async () => {
    const harness = await startHarness({ env: { AI_PROVIDER_FAILURES: 'first:1' } });

    const failed = await post(harness.app, { userId: 'user-123', message: PLAIN_MESSAGE });
    const recovered = await post(harness.app, { userId: 'user-123', message: PLAIN_MESSAGE });

    expect(failed.status).toBe(200);
    expect(bodyOf(failed)).toMatchObject({
      status: 'DEGRADED',
      source: 'FALLBACK',
      reason: 'PROVIDER_ERROR',
      sanitizedMessage: PLAIN_MESSAGE,
      reply: SERVICE_BUSY_REPLY,
    });
    expect(bodyOf(recovered).status).toBe('COMPLETED');
    expect(await latestOutcomes(harness)).toEqual(['PROVIDER_FAILURE', 'COMPLETED']);
    expectNoLeak(failed.text);
  });

  it('returns the fallback with reason TIMEOUT when the provider is too slow', async () => {
    const harness = await startHarness({ env: { AI_PROVIDER_DELAY_MS: '500', AI_PROVIDER_TIMEOUT_MS: '50' } });

    const { response, elapsedMs } = await timedPost(harness.app, { userId: 'user-123', message: PLAIN_MESSAGE });

    expect(bodyOf(response)).toMatchObject({ status: 'DEGRADED', reason: 'TIMEOUT', reply: SERVICE_BUSY_REPLY });
    expect(elapsedMs).toBeLessThan(450);
    expect(await latestOutcomes(harness)).toEqual(['PROVIDER_TIMEOUT']);
  });

  it('hides an unexpected provider error behind a generic 500 and audits INTERNAL_ERROR', async () => {
    const harness = await startHarness({
      overrides: { aiDelay: () => Promise.reject(new Error(`socket hang up near ${SSN}`)) },
    });

    const response = await post(harness.app, { userId: 'user-123', message: PLAIN_MESSAGE });

    expect(response.status).toBe(500);
    expect(bodyOf(response).error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    expect(response.text).not.toContain('socket hang up');
    expectNoLeak(response.text);
    expect(await latestOutcomes(harness)).toEqual(['INTERNAL_ERROR']);
    expect(harness.logs()).toContain('Request failed');
    expect(harness.logs()).not.toContain(SSN);
    expect(harness.logs()).not.toContain('socket hang up');
  });
});

describe('POST /secure-inquiry: circuit breaker', () => {
  it('opens after three failures, then answers immediately without calling the provider, then recovers', async () => {
    const harness = await startHarness({
      env: { AI_PROVIDER_DELAY_MS: '300' },
      overrides: { aiOutcomeSchedule: failFirst(3) },
    });
    const body = { userId: 'user-123', message: PLAIN_MESSAGE };

    for (let attempt = 1; attempt <= 3; attempt++) {
      const { response, elapsedMs } = await timedPost(harness.app, body);
      expect(bodyOf(response)).toMatchObject({ status: 'DEGRADED', reason: 'PROVIDER_ERROR' });
      expect(elapsedMs).toBeGreaterThanOrEqual(250);
    }

    const { response: open, elapsedMs: openElapsedMs } = await timedPost(harness.app, body);
    expect(open.status).toBe(200);
    expect(bodyOf(open)).toMatchObject({
      status: 'DEGRADED',
      source: 'FALLBACK',
      reason: 'CIRCUIT_OPEN',
      reply: SERVICE_BUSY_REPLY,
    });
    expect(openElapsedMs).toBeLessThan(150);
    expect(harness.providerCalls()).toBe(3);
    expectNoLeak(open.text);

    harness.clock.advance(COOLDOWN_MS);
    const probe = await post(harness.app, body);
    const afterRecovery = await post(harness.app, body);

    expect(bodyOf(probe).status).toBe('COMPLETED');
    expect(bodyOf(afterRecovery).status).toBe('COMPLETED');
    expect(harness.providerCalls()).toBe(5);
    expect(await latestOutcomes(harness)).toEqual([
      'PROVIDER_FAILURE',
      'PROVIDER_FAILURE',
      'PROVIDER_FAILURE',
      'CIRCUIT_OPEN_FALLBACK',
      'COMPLETED',
      'COMPLETED',
    ]);
  });
});

describe('POST /secure-inquiry: persistence failures', () => {
  it('fails closed with 500 AUDIT_UNAVAILABLE when the PENDING revision cannot be written', async () => {
    const { fileSystem } = fakeAuditFileSystem({ appendDurably: () => Promise.reject(errnoError('ENOSPC')) });
    const harness = await startHarness({ overrides: { auditFileSystem: fileSystem } });

    const response = await post(harness.app, { userId: USER_ID, message: PII_MESSAGE });

    expect(response.status).toBe(500);
    expect(bodyOf(response).error).toEqual({ code: 'AUDIT_UNAVAILABLE', message: 'The inquiry could not be recorded' });
    expect(harness.providerCalls()).toBe(0);
    expectNoLeak(response.text);
  });

  it('fails closed on a real filesystem error (audit path is a directory)', async () => {
    const harness = await startHarness();
    const blocked = await startHarness({ env: { AUDIT_FILE_PATH: join(harness.auditFile, '..') } });

    const response = await post(blocked.app, { userId: 'user-123', message: PLAIN_MESSAGE });

    expect(response.status).toBe(500);
    expect(bodyOf(response).error?.code).toBe('AUDIT_UNAVAILABLE');
    expect(blocked.providerCalls()).toBe(0);
  });

  it('still answers when only the outcome revision fails, and logs the failure without content', async () => {
    let appends = 0;
    const { fileSystem } = fakeAuditFileSystem({
      appendDurably: () => {
        appends += 1;
        return appends === 2 ? Promise.reject(errnoError('EACCES')) : Promise.resolve();
      },
    });
    const harness = await startHarness({ overrides: { auditFileSystem: fileSystem } });

    const response = await post(harness.app, { userId: USER_ID, message: PII_MESSAGE });

    expect(response.status).toBe(200);
    expect(bodyOf(response).status).toBe('COMPLETED');
    expect(harness.logs()).toContain('Audit outcome could not be recorded');
    expect(harness.logs()).toContain(bodyOf(response).inquiryId);
    expect(harness.logs()).toContain('EACCES');
    for (const value of [EMAIL, CARD, SSN]) expect(harness.logs()).not.toContain(value);
  });
});

describe('POST /secure-inquiry: client disconnects', () => {
  it('audits CANCELLED and does not count the cancellation as a provider failure', async () => {
    const harness = await startHarness({
      env: { AI_PROVIDER_DELAY_MS: '1000', CIRCUIT_BREAKER_FAILURE_THRESHOLD: '1' },
    });
    const server = harness.app.listen(0);
    cleanups.push(
      () =>
        new Promise((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    );

    const payload = JSON.stringify({ userId: 'user-123', message: PLAIN_MESSAGE });
    const clientRequest = httpRequest({
      port: (server.address() as AddressInfo).port,
      method: 'POST',
      path: '/secure-inquiry',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    });
    clientRequest.on('error', () => undefined);
    clientRequest.end(payload);
    setTimeout(() => clientRequest.destroy(), 100);

    await vi.waitFor(
      async () => {
        expect(await latestOutcomes(harness)).toEqual(['CANCELLED']);
      },
      { timeout: 3000, interval: 25 },
    );
    await vi.waitFor(() => {
      expect(harness.logs()).toContain('Client disconnected before the response was sent');
    });

    // With a threshold of 1, a counted failure would have opened the circuit.
    const next = await request(harness.app)
      .post('/secure-inquiry')
      .send({ userId: 'user-123', message: PLAIN_MESSAGE });
    expect(bodyOf(next).status).toBe('COMPLETED');
  });
});
