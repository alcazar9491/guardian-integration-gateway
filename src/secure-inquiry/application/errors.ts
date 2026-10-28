import { AppError } from '../../shared/errors/app-error.js';

/** Why a degraded reply was returned instead of the provider's answer. Part of the public API contract. */
export type FallbackReason = 'PROVIDER_ERROR' | 'TIMEOUT' | 'CIRCUIT_OPEN';

export type AiProviderFailureReason = 'PROVIDER_ERROR' | 'TIMEOUT' | 'CIRCUIT_OPEN';

/** A provider failure: counts towards opening the circuit. Never carries the prompt. */
export class AiProviderUnavailableError extends AppError {
  override readonly code = 'AI_PROVIDER_UNAVAILABLE';

  constructor(
    readonly reason: AiProviderFailureReason,
    options?: ErrorOptions,
  ) {
    super(`AI provider unavailable: ${reason}`, options);
  }
}

/** The caller gave up. Not a provider failure, so it must never count towards opening the circuit. */
export class AiRequestCancelledError extends AppError {
  override readonly code = 'AI_REQUEST_CANCELLED';

  constructor(options?: ErrorOptions) {
    super('AI request was cancelled', options);
  }
}

export class AuditPersistenceError extends AppError {
  override readonly code = 'AUDIT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Audit record could not be persisted', options);
  }
}

/** Verification-side failure: the audit store exists but cannot be read. */
export class AuditReadError extends AppError {
  override readonly code = 'AUDIT_READ_FAILED';

  constructor(options?: ErrorOptions) {
    super('Audit store could not be read', options);
  }
}

export type DecryptionFailureReason = 'UNSUPPORTED_PAYLOAD' | 'UNKNOWN_KEY' | 'AUTHENTICATION_FAILED';

/** Carries only a reason code: never ciphertext, plaintext, or key material. */
export class DecryptionError extends AppError {
  override readonly code = 'DECRYPTION_FAILED';

  constructor(readonly reason: DecryptionFailureReason) {
    super(`Payload could not be decrypted: ${reason}`);
  }
}
