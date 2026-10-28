import type { EncryptedPayload } from '../../domain/encrypted-payload.js';

/**
 * Verification-only port for automated tests and authorized internal review.
 * Never wired into the use case or exposed over HTTP.
 */
export interface PayloadDecryptor {
  /** Throws `DecryptionError` when the payload cannot be authenticated with the given associated data. */
  decrypt(payload: EncryptedPayload, associatedData: string): string;
}
