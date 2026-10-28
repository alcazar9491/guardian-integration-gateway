import { createCipheriv, createDecipheriv, randomBytes, type KeyObject } from 'node:crypto';
import { DecryptionError } from '../application/errors.js';
import type { EncryptionService } from '../application/ports/encryption-service.js';
import type { PayloadDecryptor } from '../application/ports/payload-decryptor.js';
import {
  ENCRYPTED_PAYLOAD_ALGORITHM,
  ENCRYPTED_PAYLOAD_VERSION,
  type EncryptedPayload,
} from '../domain/encrypted-payload.js';
import { InvalidEncryptionKeyError } from './invalid-encryption-key-error.js';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface AesGcmEncryptionServiceOptions {
  /** 32-byte AES-256 secret key. */
  readonly key: KeyObject;
  readonly keyId: string;
}

/** Strict base64: rejects input that Node's lenient decoder would silently repair. */
function decodeCanonicalBase64(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : undefined;
}

function decodeExactLength(value: unknown, expectedBytes: number): Buffer {
  const decoded = decodeCanonicalBase64(value);
  if (decoded?.length !== expectedBytes) throw new DecryptionError('UNSUPPORTED_PAYLOAD');
  return decoded;
}

export class AesGcmEncryptionService implements EncryptionService, PayloadDecryptor {
  // Only the opaque KeyObject is kept: inspecting or serializing this service never reveals key bytes.
  private readonly key: KeyObject;
  private readonly keyId: string;

  constructor({ key, keyId }: AesGcmEncryptionServiceOptions) {
    if (key.type !== 'secret' || key.symmetricKeySize !== KEY_BYTES) throw new InvalidEncryptionKeyError('KEY');
    if (!KEY_ID_PATTERN.test(keyId)) throw new InvalidEncryptionKeyError('KEY_ID');
    this.key = key;
    this.keyId = keyId;
  }

  encrypt(plaintext: string, associatedData: string): EncryptedPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ENCRYPTED_PAYLOAD_ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    return Object.freeze({
      algorithm: ENCRYPTED_PAYLOAD_ALGORITHM,
      version: ENCRYPTED_PAYLOAD_VERSION,
      keyId: this.keyId,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
  }

  decrypt(payload: EncryptedPayload, associatedData: string): string {
    // Payloads come back from storage, so their runtime shape is not trusted.
    const algorithm: unknown = payload.algorithm;
    const version: unknown = payload.version;
    if (algorithm !== ENCRYPTED_PAYLOAD_ALGORITHM || version !== ENCRYPTED_PAYLOAD_VERSION) {
      throw new DecryptionError('UNSUPPORTED_PAYLOAD');
    }
    if (payload.keyId !== this.keyId) throw new DecryptionError('UNKNOWN_KEY');

    const iv = decodeExactLength(payload.iv, IV_BYTES);
    // Length checked up front and pinned via authTagLength: without it, Node accepts truncated tags
    // (down to 4 bytes), which makes forging a valid tag dramatically cheaper.
    const authTag = decodeExactLength(payload.authTag, AUTH_TAG_BYTES);
    const ciphertext = decodeCanonicalBase64(payload.ciphertext);
    if (ciphertext === undefined) throw new DecryptionError('UNSUPPORTED_PAYLOAD');

    const decipher = createDecipheriv(ENCRYPTED_PAYLOAD_ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(authTag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key, tampered data and wrong associated data are indistinguishable by design: no oracle.
      throw new DecryptionError('AUTHENTICATION_FAILED');
    }
  }
}
