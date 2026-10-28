import { createSecretKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { LOG_LEVELS, type LogLevel } from '../logging/logger.js';

const ENCRYPTION_KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export type NodeEnv = 'development' | 'test' | 'production';

/** Deterministic failure injection for the simulated AI provider. */
export type AiProviderFailureMode =
  | { readonly kind: 'never' }
  | { readonly kind: 'always' }
  | { readonly kind: 'first'; readonly count: number };

export interface AppConfig {
  readonly env: NodeEnv;
  readonly http: { readonly port: number; readonly bodyLimitBytes: number };
  readonly log: { readonly level: LogLevel };
  readonly audit: {
    readonly filePath: string;
    readonly encryptionKey: KeyObject;
    readonly keyId: string;
    /** Keys the HMAC that pseudonymizes userIds; deliberately separate from the encryption key. */
    readonly userRefKey: KeyObject;
  };
  readonly aiProvider: {
    readonly delayMs: number;
    readonly timeoutMs: number;
    readonly failures: AiProviderFailureMode;
  };
  readonly circuitBreaker: { readonly failureThreshold: number; readonly cooldownMs: number };
}

export class ConfigError extends AppError {
  override readonly code = 'INVALID_CONFIGURATION';

  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
  }
}

function isCanonicalBase64Key(value: string): boolean {
  const decoded = Buffer.from(value, 'base64');
  try {
    return decoded.length === ENCRYPTION_KEY_BYTES && decoded.toString('base64') === value;
  } finally {
    decoded.fill(0);
  }
}

// A KeyObject is opaque: logging or serializing the configuration can never print key bytes, unlike a Buffer.
function toSecretKey(base64Key: string): KeyObject {
  const decoded = Buffer.from(base64Key, 'base64');
  try {
    return createSecretKey(decoded);
  } finally {
    decoded.fill(0);
  }
}

const integer = (min: number, max: number = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);

const FAILURE_MODE_PATTERN = /^(?:never|always|first:[1-9]\d*)$/;
const NO_FAILURES: AiProviderFailureMode = { kind: 'never' };

function toFailureMode(value: string): AiProviderFailureMode {
  if (value === 'never' || value === 'always') {
    return { kind: value };
  }
  return { kind: 'first', count: Number(value.slice('first:'.length)) };
}

const aiProviderFailures = z
  .string()
  .regex(FAILURE_MODE_PATTERN, 'must be never, always, or first:<n> with n >= 1')
  .transform(toFailureMode)
  .refine(
    (mode) => mode.kind !== 'first' || Number.isSafeInteger(mode.count),
    'first:<n> must be a safe integer',
  );

const base64Key = () =>
  z.string().refine(isCanonicalBase64Key, `must be canonical base64 encoding exactly ${ENCRYPTION_KEY_BYTES} bytes`);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: integer(1, 65535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    REQUEST_BODY_LIMIT_BYTES: integer(1).default(16384),
    AUDIT_FILE_PATH: z.string().default('./data/audit.jsonl'),
    AUDIT_ENCRYPTION_KEY: base64Key(),
    AUDIT_ENCRYPTION_KEY_ID: z
      .string()
      .regex(KEY_ID_PATTERN, 'must be 1-64 characters of letters, digits, ".", "_" or "-"')
      .default('v1'),
    AUDIT_USER_REF_KEY: base64Key(),
    AI_PROVIDER_DELAY_MS: integer(0).default(2000),
    // Zod 4 defaults bypass parsing, so the default is the already-parsed mode.
    AI_PROVIDER_FAILURES: aiProviderFailures.default(NO_FAILURES),
    AI_PROVIDER_TIMEOUT_MS: integer(1).default(5000),
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: integer(1).default(3),
    CIRCUIT_BREAKER_COOLDOWN_MS: integer(1).default(30000),
  })
  // Both keys are canonical base64, so equal strings mean equal bytes: one key must never serve two purposes.
  .refine((vars) => vars.AUDIT_USER_REF_KEY !== vars.AUDIT_ENCRYPTION_KEY, {
    path: ['AUDIT_USER_REF_KEY'],
    message: 'must differ from AUDIT_ENCRYPTION_KEY',
  });

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const normalized = Object.fromEntries(
    Object.entries(env).map(([name, value]) => [name, value === '' ? undefined : value]),
  );
  const result = envSchema.safeParse(normalized);

  if (!result.success) {
    // Only variable names and rule messages: never echo values, which may be secrets.
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }

  const vars = result.data;
  return Object.freeze({
    env: vars.NODE_ENV,
    http: Object.freeze({ port: vars.PORT, bodyLimitBytes: vars.REQUEST_BODY_LIMIT_BYTES }),
    log: Object.freeze({ level: vars.LOG_LEVEL }),
    audit: Object.freeze({
      filePath: vars.AUDIT_FILE_PATH,
      encryptionKey: toSecretKey(vars.AUDIT_ENCRYPTION_KEY),
      keyId: vars.AUDIT_ENCRYPTION_KEY_ID,
      userRefKey: toSecretKey(vars.AUDIT_USER_REF_KEY),
    }),
    aiProvider: Object.freeze({
      delayMs: vars.AI_PROVIDER_DELAY_MS,
      timeoutMs: vars.AI_PROVIDER_TIMEOUT_MS,
      failures: Object.freeze({ ...vars.AI_PROVIDER_FAILURES }),
    }),
    circuitBreaker: Object.freeze({
      failureThreshold: vars.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      cooldownMs: vars.CIRCUIT_BREAKER_COOLDOWN_MS,
    }),
  });
}
