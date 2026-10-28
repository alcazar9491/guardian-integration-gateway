import type { EncryptedPayload } from '../../domain/encrypted-payload.js';

export interface EncryptionService {
  /** `associatedData` is authenticated but not encrypted; it binds the ciphertext to its record. */
  encrypt(plaintext: string, associatedData: string): EncryptedPayload;
}
