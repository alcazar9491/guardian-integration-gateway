export const ENCRYPTED_PAYLOAD_ALGORITHM = 'aes-256-gcm';
export const ENCRYPTED_PAYLOAD_VERSION = 1;

/**
 * Version 1 of the encrypted audit payload. Binary fields are base64.
 * Never holds the key or the associated data: the latter is rebuilt from the audit record at verification time.
 */
export interface EncryptedPayload {
  readonly algorithm: typeof ENCRYPTED_PAYLOAD_ALGORITHM;
  readonly version: typeof ENCRYPTED_PAYLOAD_VERSION;
  readonly keyId: string;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}
