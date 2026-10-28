import { createSecretKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DecryptionError, type DecryptionFailureReason } from '../../../src/secure-inquiry/application/errors.js';
import type { EncryptedPayload } from '../../../src/secure-inquiry/domain/encrypted-payload.js';
import { AesGcmEncryptionService } from '../../../src/secure-inquiry/infrastructure/aes-gcm-encryption-service.js';
import { InvalidEncryptionKeyError } from '../../../src/secure-inquiry/infrastructure/invalid-encryption-key-error.js';

const ASSOCIATED_DATA = JSON.stringify(['inquiry-1', 'user-123']);
const PLAINTEXT = 'My SSN is 123-45-6789 and my card is 4111 1111 1111 1111';

function createService(keyBytes: Buffer = randomBytes(32), keyId = 'v1'): AesGcmEncryptionService {
  return new AesGcmEncryptionService({ key: createSecretKey(keyBytes), keyId });
}

function flipFirstBit(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes.writeUInt8(bytes.readUInt8(0) ^ 0x01, 0);
  return bytes.toString('base64');
}

/** Simulates a payload read back from storage, where any field may have been altered. */
function withField(payload: EncryptedPayload, field: string, value: unknown): EncryptedPayload {
  return { ...payload, [field]: value };
}

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected the action to throw');
}

function expectDecryptionFailure(action: () => unknown, reason: DecryptionFailureReason): void {
  const error = captureError(action);
  expect(error).toBeInstanceOf(DecryptionError);
  expect((error as DecryptionError).reason).toBe(reason);
}

describe('AesGcmEncryptionService', () => {
  describe('round trip', () => {
    it.each([
      ['ASCII text', PLAINTEXT],
      ['Unicode and emoji', 'Café ☕ — 日本語 — 🔐 secret'],
      ['an empty string', ''],
      ['a 5,000-character message', 'x'.repeat(5000)],
    ])('decrypts %s back to the original', (_label, plaintext) => {
      const service = createService();

      const payload = service.encrypt(plaintext, ASSOCIATED_DATA);

      expect(service.decrypt(payload, ASSOCIATED_DATA)).toBe(plaintext);
    });

    it('decrypts with a separate instance built from the same key', () => {
      const keyBytes = randomBytes(32);
      const payload = createService(keyBytes).encrypt(PLAINTEXT, ASSOCIATED_DATA);

      expect(createService(keyBytes).decrypt(payload, ASSOCIATED_DATA)).toBe(PLAINTEXT);
    });
  });

  describe('payload', () => {
    it('contains only algorithm, version, key id, IV, auth tag and ciphertext', () => {
      const payload = createService(randomBytes(32), 'key-7').encrypt(PLAINTEXT, ASSOCIATED_DATA);

      expect(Object.keys(payload).sort()).toEqual(['algorithm', 'authTag', 'ciphertext', 'iv', 'keyId', 'version']);
      expect(payload).toMatchObject({ algorithm: 'aes-256-gcm', version: 1, keyId: 'key-7' });
    });

    it('uses a 12-byte IV and a 16-byte authentication tag', () => {
      const payload = createService().encrypt(PLAINTEXT, ASSOCIATED_DATA);

      expect(Buffer.from(payload.iv, 'base64')).toHaveLength(12);
      expect(Buffer.from(payload.authTag, 'base64')).toHaveLength(16);
    });

    it('produces ciphertext as long as the UTF-8 plaintext (no padding)', () => {
      const plaintext = 'Café ☕ 🔐';
      const payload = createService().encrypt(plaintext, ASSOCIATED_DATA);

      expect(Buffer.from(payload.ciphertext, 'base64')).toHaveLength(Buffer.byteLength(plaintext, 'utf8'));
    });

    it('never contains the plaintext or the associated data', () => {
      const serialized = JSON.stringify(createService().encrypt(PLAINTEXT, ASSOCIATED_DATA));

      expect(serialized).not.toContain('123-45-6789');
      expect(serialized).not.toContain(Buffer.from(PLAINTEXT, 'utf8').toString('base64'));
      expect(serialized).not.toContain('user-123');
    });

    it('is frozen', () => {
      expect(Object.isFrozen(createService().encrypt(PLAINTEXT, ASSOCIATED_DATA))).toBe(true);
    });
  });

  describe('IV uniqueness', () => {
    it('generates a fresh IV, and therefore fresh ciphertext, for every encryption of the same message', () => {
      const service = createService();
      const payloads = Array.from({ length: 1000 }, () => service.encrypt(PLAINTEXT, ASSOCIATED_DATA));

      expect(new Set(payloads.map((payload) => payload.iv)).size).toBe(1000);
      expect(new Set(payloads.map((payload) => payload.ciphertext)).size).toBe(1000);
    });
  });

  describe('authentication failures', () => {
    it('rejects a different key that claims the same key id', () => {
      const payload = createService(randomBytes(32), 'v1').encrypt(PLAINTEXT, ASSOCIATED_DATA);
      const otherService = createService(randomBytes(32), 'v1');

      expectDecryptionFailure(() => otherService.decrypt(payload, ASSOCIATED_DATA), 'AUTHENTICATION_FAILED');
    });

    it.each(['ciphertext', 'authTag', 'iv'] as const)('rejects a single flipped bit in the %s', (field) => {
      const service = createService();
      const payload = service.encrypt(PLAINTEXT, ASSOCIATED_DATA);
      const tampered = withField(payload, field, flipFirstBit(payload[field]));

      expectDecryptionFailure(() => service.decrypt(tampered, ASSOCIATED_DATA), 'AUTHENTICATION_FAILED');
    });

    it('rejects ciphertext moved to another record (different associated data)', () => {
      const service = createService();
      const payload = service.encrypt(PLAINTEXT, ASSOCIATED_DATA);

      expectDecryptionFailure(
        () => service.decrypt(payload, JSON.stringify(['inquiry-2', 'user-123'])),
        'AUTHENTICATION_FAILED',
      );
    });

    it('rejects a truncated ciphertext', () => {
      const service = createService();
      const payload = service.encrypt(PLAINTEXT, ASSOCIATED_DATA);
      const truncated = Buffer.from(payload.ciphertext, 'base64').subarray(0, 10).toString('base64');

      expectDecryptionFailure(
        () => service.decrypt(withField(payload, 'ciphertext', truncated), ASSOCIATED_DATA),
        'AUTHENTICATION_FAILED',
      );
    });

    it('rejects a truncated 4-byte authentication tag before attempting decryption', () => {
      const service = createService();
      const payload = service.encrypt(PLAINTEXT, ASSOCIATED_DATA);
      const shortTag = Buffer.from(payload.authTag, 'base64').subarray(0, 4).toString('base64');

      expectDecryptionFailure(
        () => service.decrypt(withField(payload, 'authTag', shortTag), ASSOCIATED_DATA),
        'UNSUPPORTED_PAYLOAD',
      );
    });
  });

  describe('payload metadata', () => {
    it('rejects a payload encrypted under an unknown key id', () => {
      const payload = createService(randomBytes(32), 'v1').encrypt(PLAINTEXT, ASSOCIATED_DATA);

      expectDecryptionFailure(
        () => createService(randomBytes(32), 'v2').decrypt(payload, ASSOCIATED_DATA),
        'UNKNOWN_KEY',
      );
    });

    it.each([
      ['an unsupported algorithm', 'algorithm', 'aes-128-gcm'],
      ['an unsupported version', 'version', 2],
      ['an 8-byte IV', 'iv', randomBytes(8).toString('base64')],
      ['a 17-byte authentication tag', 'authTag', randomBytes(17).toString('base64')],
      ['a non-canonical base64 IV', 'iv', `${randomBytes(12).toString('base64')}!`],
      ['a non-string ciphertext', 'ciphertext', 42],
      ['a missing IV', 'iv', undefined],
    ])('rejects %s as unsupported', (_label, field, value) => {
      const service = createService();
      const payload = withField(service.encrypt(PLAINTEXT, ASSOCIATED_DATA), field, value);

      expectDecryptionFailure(() => service.decrypt(payload, ASSOCIATED_DATA), 'UNSUPPORTED_PAYLOAD');
    });
  });

  describe('construction', () => {
    it.each([
      ['a 16-byte key', () => createSecretKey(randomBytes(16))],
      ['a 64-byte key', () => createSecretKey(randomBytes(64))],
      ['an asymmetric key', () => generateKeyPairSync('ed25519').publicKey],
    ])('rejects %s', (_label, createKey: () => KeyObject) => {
      const error = captureError(() => new AesGcmEncryptionService({ key: createKey(), keyId: 'v1' }));

      expect(error).toBeInstanceOf(InvalidEncryptionKeyError);
      expect((error as InvalidEncryptionKeyError).field).toBe('KEY');
    });

    it.each(['', 'has space', 'v1/../v2', 'clé', 'k'.repeat(65)])('rejects key id %j', (keyId) => {
      const error = captureError(() => createService(randomBytes(32), keyId));

      expect(error).toBeInstanceOf(InvalidEncryptionKeyError);
      expect((error as InvalidEncryptionKeyError).field).toBe('KEY_ID');
    });

    it('accepts a key id made of letters, digits, dots, underscores and hyphens', () => {
      expect(() => createService(randomBytes(32), 'key-2026.10_a')).not.toThrow();
    });
  });

  describe('secret hygiene', () => {
    function keyRenderings(keyBytes: Buffer): string[] {
      return [
        keyBytes.toString('base64'),
        keyBytes.toString('hex'),
        [...keyBytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
        [...keyBytes].join(','),
      ];
    }

    it('never reveals key material when the service is serialized or inspected', () => {
      const keyBytes = randomBytes(32);
      const service = createService(keyBytes);

      for (const rendered of [JSON.stringify(service), inspect(service, { depth: Infinity, showHidden: true })]) {
        for (const keyRendering of keyRenderings(keyBytes)) {
          expect(rendered).not.toContain(keyRendering);
        }
      }
    });

    it('never puts plaintext, ciphertext or key material in decryption errors', () => {
      const keyBytes = randomBytes(32);
      const payload = createService().encrypt(PLAINTEXT, ASSOCIATED_DATA);
      const error = captureError(() => createService(keyBytes).decrypt(payload, ASSOCIATED_DATA));
      const rendered = `${error.message}\n${error.stack ?? ''}\n${inspect(error)}`;

      expect(rendered).not.toContain('123-45-6789');
      expect(rendered).not.toContain(payload.ciphertext);
      expect(rendered).not.toContain(ASSOCIATED_DATA);
      for (const keyRendering of keyRenderings(keyBytes)) {
        expect(rendered).not.toContain(keyRendering);
      }
    });

    it('never echoes the rejected key id', () => {
      const error = captureError(() => createService(randomBytes(32), 'secret-looking id'));

      expect(error.message).not.toContain('secret-looking id');
    });
  });
});
