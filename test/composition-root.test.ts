import { createSecretKey, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAiProvider, compose } from '../src/composition-root.js';
import { AiProviderUnavailableError } from '../src/secure-inquiry/application/errors.js';
import type { RedactedText } from '../src/secure-inquiry/domain/redacted-text.js';
import { InvalidUserRefKeyError } from '../src/secure-inquiry/infrastructure/hmac-user-pseudonymizer.js';
import { InvalidEncryptionKeyError } from '../src/secure-inquiry/infrastructure/invalid-encryption-key-error.js';
import { alwaysFail } from '../src/secure-inquiry/infrastructure/ai-provider/outcome-schedule.js';
import { loadConfig } from '../src/shared/config/app-config.js';
import { createLogger } from '../src/shared/logging/logger.js';
import { errnoError, fakeAuditFileSystem } from './secure-inquiry/infrastructure/audit/fake-audit-file-system.js';

function requiredKeys() {
  return {
    AUDIT_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AUDIT_USER_REF_KEY: randomBytes(32).toString('base64'),
  };
}

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempAuditFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'guardian-compose-'));
  tempDirectories.push(directory);
  return join(directory, 'audit.jsonl');
}

function composeForTest() {
  const config = loadConfig({
    NODE_ENV: 'test',
    ...requiredKeys(),
    AUDIT_FILE_PATH: tempAuditFile(),
    AI_PROVIDER_DELAY_MS: '0',
  });
  return compose(config, createLogger({ level: 'silent' }));
}

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const logger = createLogger({
    level: 'info',
    destination: {
      write: (line: string) => {
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  return { logger, lines, raw };
}

function composeCapturingLogs(env: Record<string, string>) {
  const { logger, lines } = capturingLogger();
  compose(loadConfig({ ...requiredKeys(), AUDIT_FILE_PATH: tempAuditFile(), ...env }), logger);
  return lines;
}

describe('compose', () => {
  it('wires a working application', async () => {
    const { app } = composeForTest();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('validates input before reaching the use case', async () => {
    const { app } = composeForTest();

    const response = await request(app).post('/secure-inquiry').send({ userId: 'user-123' });

    expect(response.status).toBe(400);
  });

  it('routes valid inquiries through the real use case', async () => {
    const { app, shutdown } = composeForTest();

    const response = await request(app).post('/secure-inquiry').send({ userId: 'user-123', message: 'hello' });
    await shutdown();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'COMPLETED', reply: 'Generated Answer: hello' });
  });

  it('warns once at startup when AI provider failure injection is enabled', () => {
    const warnings = composeCapturingLogs({ AI_PROVIDER_FAILURES: 'first:3' }).filter(
      (line) => line.msg === 'AI provider failure injection is enabled',
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 40, aiProviderFailures: { kind: 'first', count: 3 } });
  });

  it('does not warn when failure injection is disabled', () => {
    const warnings = composeCapturingLogs({ AI_PROVIDER_FAILURES: 'never' }).filter((line) => line.level === 40);

    expect(warnings).toHaveLength(0);
  });

  it('fails fast on an invalid user reference key even if configuration validation was bypassed', () => {
    const config = loadConfig({ NODE_ENV: 'test', ...requiredKeys() });
    const weakened = { ...config, audit: { ...config.audit, userRefKey: createSecretKey(randomBytes(16)) } };

    expect(() => compose(weakened, createLogger({ level: 'silent' }))).toThrow(InvalidUserRefKeyError);
  });

  it('honours test overrides for time, ids, the provider schedule and delay, and the audit filesystem', async () => {
    const { fileSystem, writes } = fakeAuditFileSystem();
    const delays: number[] = [];
    const fixedNow = new Date('2026-10-27T12:00:00.000Z');
    const config = loadConfig({ NODE_ENV: 'test', ...requiredKeys(), AUDIT_FILE_PATH: tempAuditFile() });
    const { app } = compose(config, createLogger({ level: 'silent' }), {
      clock: { now: () => fixedNow },
      idGenerator: { next: () => 'audit-fixed' },
      aiOutcomeSchedule: alwaysFail(),
      aiDelay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      auditFileSystem: fileSystem,
    });

    const response = await request(app).post('/secure-inquiry').send({ userId: 'user-123', message: 'hello' });

    expect(response.body).toMatchObject({ inquiryId: 'audit-fixed', status: 'DEGRADED', reason: 'PROVIDER_ERROR' });
    expect(delays).toEqual([config.aiProvider.delayMs]);
    expect(writes.map((line) => JSON.parse(line) as { createdAt: string; outcome: string })).toEqual([
      expect.objectContaining({ createdAt: fixedNow.toISOString(), outcome: 'PENDING' }),
      expect.objectContaining({ outcome: 'PROVIDER_FAILURE' }),
    ]);
  });

  it('logs an outcome revision that could not be persisted', async () => {
    let appends = 0;
    const { fileSystem } = fakeAuditFileSystem({
      appendDurably: () => {
        appends += 1;
        return appends === 2 ? Promise.reject(errnoError('ENOSPC')) : Promise.resolve();
      },
    });
    const { logger, lines } = capturingLogger();
    const config = loadConfig({
      NODE_ENV: 'test',
      ...requiredKeys(),
      AUDIT_FILE_PATH: tempAuditFile(),
      AI_PROVIDER_DELAY_MS: '0',
    });
    const { app } = compose(config, logger, { auditFileSystem: fileSystem });

    const response = await request(app).post('/secure-inquiry').send({ userId: 'user-123', message: 'hello' });

    expect(response.status).toBe(200);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 50,
        msg: 'Audit outcome could not be recorded',
        auditId: (response.body as { inquiryId: string }).inquiryId,
        outcome: 'COMPLETED',
        error: expect.objectContaining({ rootCode: 'ENOSPC' }) as unknown,
      }),
    );
  });

  it('exposes a read-only view of the circuit that follows provider failures', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      ...requiredKeys(),
      AUDIT_FILE_PATH: tempAuditFile(),
      AI_PROVIDER_DELAY_MS: '0',
    });
    const { app, circuit, shutdown } = compose(config, createLogger({ level: 'silent' }), {
      aiOutcomeSchedule: alwaysFail(),
    });
    expect({ state: circuit.state, consecutiveFailures: circuit.consecutiveFailures }).toEqual({
      state: 'CLOSED',
      consecutiveFailures: 0,
    });

    await request(app).post('/secure-inquiry').send({ userId: 'user-123', message: 'hello' });
    await shutdown();

    expect(circuit.consecutiveFailures).toBe(1);
    expect(Object.keys(circuit).sort()).toEqual(['consecutiveFailures', 'state']);
    expect(() => {
      (circuit as { state: string }).state = 'OPEN';
    }).toThrow(TypeError);
    expect(circuit.state).toBe('CLOSED');
  });

  it('exposes a shutdown that drains the audit store', async () => {
    const { shutdown } = composeForTest();

    await expect(shutdown()).resolves.toBeUndefined();
  });

  it('fails fast on an invalid encryption key even if configuration validation was bypassed', () => {
    const config = loadConfig({ NODE_ENV: 'test', ...requiredKeys() });
    const weakened = { ...config, audit: { ...config.audit, encryptionKey: createSecretKey(randomBytes(16)) } };

    expect(() => compose(weakened, createLogger({ level: 'silent' }))).toThrow(InvalidEncryptionKeyError);
  });
});

describe('buildAiProvider', () => {
  const PROMPT = 'Secret detail <REDACTED: EMAIL>' as RedactedText;

  function failingProviderConfig() {
    return loadConfig({
      ...requiredKeys(),
      AI_PROVIDER_FAILURES: 'always',
      AI_PROVIDER_DELAY_MS: '0',
    });
  }

  it('shares one breaker across calls: the fourth call short-circuits', async () => {
    const { aiProvider: provider } = buildAiProvider(failingProviderConfig(), createLogger({ level: 'silent' }));

    for (let call = 0; call < 3; call++) {
      await expect(provider.reply(PROMPT)).rejects.toMatchObject({ reason: 'PROVIDER_ERROR' });
    }

    await expect(provider.reply(PROMPT)).rejects.toBeInstanceOf(AiProviderUnavailableError);
    await expect(provider.reply(PROMPT)).rejects.toMatchObject({ reason: 'CIRCUIT_OPEN' });
  });

  it('logs the transition to OPEN once, as a warning, without request data', async () => {
    const { logger, lines, raw } = capturingLogger();
    const { aiProvider: provider } = buildAiProvider(failingProviderConfig(), logger);

    for (let call = 0; call < 5; call++) {
      await provider.reply(PROMPT).catch(() => undefined);
    }

    const transitions = lines.filter((line) => line.msg === 'AI provider circuit state changed');
    expect(transitions).toEqual([expect.objectContaining({ level: 40, circuit: { from: 'CLOSED', to: 'OPEN' } })]);
    expect(raw.join('\n')).not.toContain('Secret detail');
  });
});
