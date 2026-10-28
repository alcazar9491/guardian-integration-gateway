import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/shared/config/app-config.js';

const validKey = randomBytes(32).toString('base64');
const validUserRefKey = randomBytes(32).toString('base64');
const baseEnv = { AUDIT_ENCRYPTION_KEY: validKey, AUDIT_USER_REF_KEY: validUserRefKey };

/** Every shape key bytes take when rendered: base64, hex, Buffer's inspect form and its JSON form. */
function keyRenderings(base64Key: string): string[] {
  const keyBytes = Buffer.from(base64Key, 'base64');
  return [
    base64Key,
    keyBytes.toString('hex'),
    [...keyBytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    [...keyBytes].join(','),
  ];
}

function captureConfigError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('Expected loadConfig to throw a ConfigError');
}

describe('loadConfig', () => {
  it('applies defaults when only the required keys are provided', () => {
    const config = loadConfig(baseEnv);

    expect(config).toMatchObject({
      env: 'development',
      http: { port: 3000, bodyLimitBytes: 16384 },
      log: { level: 'info' },
      audit: { filePath: './data/audit.jsonl', keyId: 'v1' },
      aiProvider: { delayMs: 2000, timeoutMs: 5000, failures: { kind: 'never' } },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 30000 },
    });
  });

  it('exposes the encryption key as an opaque 32-byte secret KeyObject', () => {
    const { encryptionKey } = loadConfig(baseEnv).audit;

    expect(encryptionKey.type).toBe('secret');
    expect(encryptionKey.symmetricKeySize).toBe(32);
    expect(encryptionKey.export().equals(Buffer.from(validKey, 'base64'))).toBe(true);
  });

  it('exposes the user reference key as an opaque 32-byte secret KeyObject', () => {
    const { userRefKey } = loadConfig(baseEnv).audit;

    expect(userRefKey.type).toBe('secret');
    expect(userRefKey.symmetricKeySize).toBe(32);
    expect(userRefKey.export().equals(Buffer.from(validUserRefKey, 'base64'))).toBe(true);
  });

  it('never reveals key material when the configuration is serialized or inspected', () => {
    const config = loadConfig(baseEnv);

    for (const rendered of [JSON.stringify(config), inspect(config, { depth: Infinity })]) {
      for (const keyRendering of [...keyRenderings(validKey), ...keyRenderings(validUserRefKey)]) {
        expect(rendered).not.toContain(keyRendering);
      }
    }
  });

  it('rejects a missing user reference key', () => {
    const error = captureConfigError({ AUDIT_ENCRYPTION_KEY: validKey });

    expect(error.issues.some((issue) => issue.startsWith('AUDIT_USER_REF_KEY'))).toBe(true);
  });

  it('rejects a user reference key that does not decode to 32 bytes', () => {
    const shortKey = randomBytes(16).toString('base64');
    const error = captureConfigError({ ...baseEnv, AUDIT_USER_REF_KEY: shortKey });

    expect(error.issues.some((issue) => issue.startsWith('AUDIT_USER_REF_KEY'))).toBe(true);
    expect(error.message).not.toContain(shortKey);
  });

  it.each([
    ['missing padding', validUserRefKey.replace(/=+$/, '')],
    ['invalid characters', `${validUserRefKey.slice(0, -2)}!=`],
    ['surrounding whitespace', ` ${validUserRefKey} `],
  ])('rejects a non-canonical user reference key (%s)', (_label, key) => {
    const error = captureConfigError({ ...baseEnv, AUDIT_USER_REF_KEY: key });

    expect(error.issues.some((issue) => issue.startsWith('AUDIT_USER_REF_KEY'))).toBe(true);
  });

  it('rejects a user reference key equal to the encryption key without echoing either', () => {
    const error = captureConfigError({ AUDIT_ENCRYPTION_KEY: validKey, AUDIT_USER_REF_KEY: validKey });

    expect(error.issues).toEqual([expect.stringMatching(/^AUDIT_USER_REF_KEY: .*AUDIT_ENCRYPTION_KEY/)]);
    for (const keyRendering of keyRenderings(validKey)) {
      expect(error.message).not.toContain(keyRendering);
    }
  });

  it('accepts a key id made of letters, digits, dots, underscores and hyphens', () => {
    expect(loadConfig({ ...baseEnv, AUDIT_ENCRYPTION_KEY_ID: 'key-2026.10_a' }).audit.keyId).toBe('key-2026.10_a');
  });

  it.each([
    ['whitespace', 'has space'],
    ['path characters', 'v1/../v2'],
    ['non-ASCII letters', 'clé'],
    ['more than 64 characters', 'k'.repeat(65)],
  ])('rejects a key id with %s without echoing it', (_label, keyId) => {
    const error = captureConfigError({ ...baseEnv, AUDIT_ENCRYPTION_KEY_ID: keyId });

    expect(error.issues.some((issue) => issue.startsWith('AUDIT_ENCRYPTION_KEY_ID'))).toBe(true);
    expect(error.message).not.toContain(keyId);
  });

  it('parses explicit values', () => {
    const config = loadConfig({
      ...baseEnv,
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      REQUEST_BODY_LIMIT_BYTES: '1024',
      AUDIT_FILE_PATH: '/data/audit.jsonl',
      AUDIT_ENCRYPTION_KEY_ID: 'v2',
      AI_PROVIDER_DELAY_MS: '10',
      AI_PROVIDER_FAILURES: 'first:3',
      AI_PROVIDER_TIMEOUT_MS: '100',
      CIRCUIT_BREAKER_FAILURE_THRESHOLD: '5',
      CIRCUIT_BREAKER_COOLDOWN_MS: '1000',
    });

    expect(config).toMatchObject({
      env: 'production',
      http: { port: 8080, bodyLimitBytes: 1024 },
      log: { level: 'warn' },
      audit: { filePath: '/data/audit.jsonl', keyId: 'v2' },
      aiProvider: { delayMs: 10, timeoutMs: 100, failures: { kind: 'first', count: 3 } },
      circuitBreaker: { failureThreshold: 5, cooldownMs: 1000 },
    });
  });

  it('no longer reads the old reset-timeout variable', () => {
    const config = loadConfig({ ...baseEnv, CIRCUIT_BREAKER_RESET_TIMEOUT_MS: '5' });

    expect(config.circuitBreaker).toEqual({ failureThreshold: 3, cooldownMs: 30000 });
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects circuit breaker cooldown %s', (value) => {
    const error = captureConfigError({ ...baseEnv, CIRCUIT_BREAKER_COOLDOWN_MS: value });

    expect(error.issues.some((issue) => issue.startsWith('CIRCUIT_BREAKER_COOLDOWN_MS'))).toBe(true);
  });

  it.each(['0', '2.5', 'abc'])('rejects circuit breaker failure threshold %s', (value) => {
    const error = captureConfigError({ ...baseEnv, CIRCUIT_BREAKER_FAILURE_THRESHOLD: value });

    expect(error.issues.some((issue) => issue.startsWith('CIRCUIT_BREAKER_FAILURE_THRESHOLD'))).toBe(true);
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig({ ...baseEnv, PORT: '', LOG_LEVEL: '', AUDIT_FILE_PATH: '' });

    expect(config.http.port).toBe(3000);
    expect(config.log.level).toBe('info');
    expect(config.audit.filePath).toBe('./data/audit.jsonl');
  });

  it('returns a frozen configuration', () => {
    const config = loadConfig(baseEnv);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.http)).toBe(true);
    expect(Object.isFrozen(config.audit)).toBe(true);
    expect(Object.isFrozen(config.aiProvider.failures)).toBe(true);
  });

  it('rejects a missing encryption key', () => {
    const error = captureConfigError({});

    expect(error.message).toContain('AUDIT_ENCRYPTION_KEY');
  });

  it('rejects an empty encryption key', () => {
    const error = captureConfigError({ AUDIT_ENCRYPTION_KEY: '' });

    expect(error.message).toContain('AUDIT_ENCRYPTION_KEY');
  });

  it('rejects a key that does not decode to 32 bytes', () => {
    const error = captureConfigError({ AUDIT_ENCRYPTION_KEY: randomBytes(16).toString('base64') });

    expect(error.issues.some((issue) => issue.startsWith('AUDIT_ENCRYPTION_KEY'))).toBe(true);
  });

  it.each([
    ['missing padding', validKey.replace(/=+$/, '')],
    ['invalid characters', `${validKey.slice(0, -2)}!=`],
    ['surrounding whitespace', ` ${validKey} `],
  ])('rejects non-canonical base64 (%s)', (_label, key) => {
    const error = captureConfigError({ AUDIT_ENCRYPTION_KEY: key });

    expect(error.issues.some((issue) => issue.startsWith('AUDIT_ENCRYPTION_KEY'))).toBe(true);
  });

  it.each([
    ['never', { kind: 'never' }],
    ['always', { kind: 'always' }],
    ['first:3', { kind: 'first', count: 3 }],
    ['first:1', { kind: 'first', count: 1 }],
  ])('parses AI provider failure injection %s', (value, expected) => {
    expect(loadConfig({ ...baseEnv, AI_PROVIDER_FAILURES: value }).aiProvider.failures).toEqual(expected);
  });

  it.each(['sometimes', 'first:0', 'first:-1', 'first:abc', 'first:', 'first:1.5', 'FIRST:3', ' always', 'first:99999999999999999999'])(
    'rejects AI provider failure injection %j',
    (value) => {
      const error = captureConfigError({ ...baseEnv, AI_PROVIDER_FAILURES: value });

      expect(error.issues.some((issue) => issue.startsWith('AI_PROVIDER_FAILURES'))).toBe(true);
    },
  );

  it('no longer supports a random failure rate', () => {
    const config = loadConfig({ ...baseEnv, AI_PROVIDER_FAILURE_RATE: '0.5' });

    expect(config.aiProvider).not.toHaveProperty('failureRate');
    expect(config.aiProvider.failures).toEqual({ kind: 'never' });
  });

  it.each(['0', '70000', 'abc', '30.5'])('rejects port %s', (port) => {
    const error = captureConfigError({ ...baseEnv, PORT: port });

    expect(error.issues.some((issue) => issue.startsWith('PORT'))).toBe(true);
  });

  it('rejects an unknown log level', () => {
    const error = captureConfigError({ ...baseEnv, LOG_LEVEL: 'verbose' });

    expect(error.issues.some((issue) => issue.startsWith('LOG_LEVEL'))).toBe(true);
  });

  it('reports every invalid variable at once', () => {
    const error = captureConfigError({ PORT: 'abc', AI_PROVIDER_FAILURES: 'sometimes' });

    expect(error.issues.map((issue) => issue.split(':')[0])).toEqual(
      expect.arrayContaining(['PORT', 'AI_PROVIDER_FAILURES', 'AUDIT_ENCRYPTION_KEY']),
    );
  });

  it('never includes provided values in the error message', () => {
    const shortKey = randomBytes(16).toString('base64');
    const error = captureConfigError({ AUDIT_ENCRYPTION_KEY: shortKey, PORT: 'not-a-port-123' });

    expect(error.message).not.toContain(shortKey);
    expect(error.message).not.toContain('not-a-port-123');
  });
});
