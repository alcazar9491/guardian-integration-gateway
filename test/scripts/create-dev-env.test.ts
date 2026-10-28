import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/shared/config/app-config.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/create-dev-env.mjs', import.meta.url));

/** Every variable `loadConfig` reads, with the default it applies when the variable is absent. */
const EXPECTED_DEFAULTS = {
  NODE_ENV: 'development',
  PORT: '3000',
  LOG_LEVEL: 'info',
  REQUEST_BODY_LIMIT_BYTES: '16384',
  AUDIT_FILE_PATH: './data/audit.jsonl',
  AUDIT_ENCRYPTION_KEY_ID: 'v1',
  AI_PROVIDER_DELAY_MS: '2000',
  AI_PROVIDER_FAILURES: 'never',
  AI_PROVIDER_TIMEOUT_MS: '5000',
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: '3',
  CIRCUIT_BREAKER_COOLDOWN_MS: '30000',
} as const;

const KEY_VARIABLES = ['AUDIT_ENCRYPTION_KEY', 'AUDIT_USER_REF_KEY'] as const;

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'guardian-dev-env-'));
  tempDirectories.push(directory);
  return directory;
}

function runScript(args: readonly string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', timeout: 10_000 });
}

function generate(): { target: string; result: SpawnSyncReturns<string>; content: string; vars: NodeJS.Dict<string> } {
  const target = join(tempDirectory(), '.env');
  const result = runScript([target], tempDirectory());
  const content = readFileSync(target, 'utf8');
  return { target, result, content, vars: parseEnv(content) };
}

function keysOf(vars: NodeJS.Dict<string>): { encryptionKey: string; userRefKey: string } {
  const encryptionKey = vars.AUDIT_ENCRYPTION_KEY;
  const userRefKey = vars.AUDIT_USER_REF_KEY;
  if (encryptionKey === undefined || userRefKey === undefined) throw new Error('generated file is missing a key');
  return { encryptionKey, userRefKey };
}

function expectCanonical32ByteBase64(value: string): void {
  const decoded = Buffer.from(value, 'base64');
  expect(decoded).toHaveLength(32);
  expect(decoded.toString('base64')).toBe(value);
}

describe('scripts/create-dev-env.mjs', () => {
  it('writes every configuration variable, with its default, to the target path', () => {
    const { result, vars } = generate();

    expect(result.status).toBe(0);
    expect(Object.keys(vars).sort()).toEqual([...Object.keys(EXPECTED_DEFAULTS), ...KEY_VARIABLES].sort());
    for (const [name, value] of Object.entries(EXPECTED_DEFAULTS)) expect(vars[name], name).toBe(value);
  });

  it('generates two canonical base64 32-byte keys that differ from each other', () => {
    const { encryptionKey, userRefKey } = keysOf(generate().vars);

    expectCanonical32ByteBase64(encryptionKey);
    expectCanonical32ByteBase64(userRefKey);
    expect(userRefKey).not.toBe(encryptionKey);
  });

  it('generates fresh keys on every run', () => {
    const first = keysOf(generate().vars);
    const second = keysOf(generate().vars);

    expect(new Set([first.encryptionKey, first.userRefKey, second.encryptionKey, second.userRefKey]).size).toBe(4);
  });

  it('produces a file loadConfig accepts and that resolves to the built-in defaults', () => {
    const { vars } = generate();
    const keys = keysOf(vars);

    const fromFile = loadConfig(vars);
    const fromDefaults = loadConfig({ AUDIT_ENCRYPTION_KEY: keys.encryptionKey, AUDIT_USER_REF_KEY: keys.userRefKey });

    expect(fromFile.env).toBe(fromDefaults.env);
    expect(fromFile.http).toEqual(fromDefaults.http);
    expect(fromFile.log).toEqual(fromDefaults.log);
    expect(fromFile.aiProvider).toEqual(fromDefaults.aiProvider);
    expect(fromFile.circuitBreaker).toEqual(fromDefaults.circuitBreaker);
    expect(fromFile.audit.filePath).toBe(fromDefaults.audit.filePath);
    expect(fromFile.audit.keyId).toBe(fromDefaults.audit.keyId);
  });

  it('starts with a header marking the file as development only', () => {
    const { content } = generate();
    const header = content.split('\n').filter((line) => line.startsWith('#')).join('\n').toLowerCase();

    expect(content.startsWith('#')).toBe(true);
    expect(header).toContain('development only, never commit, never reuse in production');
  });

  it('prints the path it wrote and never a key', () => {
    const { target, result, vars } = generate();
    const { encryptionKey, userRefKey } = keysOf(vars);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.stdout).toContain(target);
    expect(output).not.toContain(encryptionKey);
    expect(output).not.toContain(userRefKey);
  });

  it('defaults the target to .env in the current directory', () => {
    const directory = tempDirectory();

    const result = runScript([], directory);

    expect(result.status).toBe(0);
    expect(keysOf(parseEnv(readFileSync(join(directory, '.env'), 'utf8'))).encryptionKey).toBeTruthy();
  });

  it('refuses to overwrite an existing file and leaves it untouched', () => {
    const target = join(tempDirectory(), '.env');
    const existingKey = 'q'.repeat(43) + '=';
    const existing = `AUDIT_ENCRYPTION_KEY=${existingKey}\n`;
    writeFileSync(target, existing);

    const result = runScript([target], tempDirectory());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(target);
    expect(readFileSync(target, 'utf8')).toBe(existing);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(existingKey);
  });

  it.skipIf(process.platform === 'win32')('creates the file readable and writable by its owner only (0600)', () => {
    const { target } = generate();

    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});
