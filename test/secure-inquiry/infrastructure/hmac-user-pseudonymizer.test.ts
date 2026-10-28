import { createHmac, createSecretKey, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  HmacUserPseudonymizer,
  InvalidUserRefKeyError,
} from '../../../src/secure-inquiry/infrastructure/hmac-user-pseudonymizer.js';

function newKeyBytes(): Buffer {
  return randomBytes(32);
}

function pseudonymizerWith(keyBytes: Buffer): HmacUserPseudonymizer {
  return new HmacUserPseudonymizer({ key: createSecretKey(keyBytes) });
}

describe('HmacUserPseudonymizer', () => {
  it('returns an unpadded base64url SHA-256 digest', () => {
    expect(pseudonymizerWith(newKeyBytes()).pseudonymize('user-123')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('computes HMAC-SHA256 of the UTF-8 userId under the configured key', () => {
    const keyBytes = newKeyBytes();
    const expected = createHmac('sha256', keyBytes).update('user-123', 'utf8').digest('base64url');

    expect(pseudonymizerWith(keyBytes).pseudonymize('user-123')).toBe(expected);
  });

  it('is stable for the same key and userId, so authorized lookups can recompute it', () => {
    const keyBytes = newKeyBytes();

    expect(pseudonymizerWith(keyBytes).pseudonymize('user-123')).toBe(
      pseudonymizerWith(Buffer.from(keyBytes)).pseudonymize('user-123'),
    );
  });

  it('gives different references to different users', () => {
    const pseudonymizer = pseudonymizerWith(newKeyBytes());

    expect(pseudonymizer.pseudonymize('user-123')).not.toBe(pseudonymizer.pseudonymize('user-124'));
  });

  it('gives different references under different keys', () => {
    expect(pseudonymizerWith(newKeyBytes()).pseudonymize('user-123')).not.toBe(
      pseudonymizerWith(newKeyBytes()).pseudonymize('user-123'),
    );
  });

  it.each(['jane.roe@example.org', '123-45-6789', 'Zoë Ångström', 'user\nwith\nnewlines'])(
    'never contains the raw userId %j',
    (userId) => {
      const reference = pseudonymizerWith(newKeyBytes()).pseudonymize(userId);

      expect(reference).not.toContain(userId);
      expect(reference).toMatch(/^[A-Za-z0-9_-]{43}$/);
    },
  );

  it('never reveals key material when inspected or serialized', () => {
    const keyBytes = newKeyBytes();
    const pseudonymizer = pseudonymizerWith(keyBytes);
    const renderings = [keyBytes.toString('base64'), keyBytes.toString('hex'), [...keyBytes].join(',')];

    for (const rendered of [inspect(pseudonymizer, { depth: Infinity }), JSON.stringify(pseudonymizer)]) {
      for (const keyRendering of renderings) {
        expect(rendered).not.toContain(keyRendering);
      }
    }
  });

  it('rejects a key that is not 32 bytes with a fixed message', () => {
    const shortKey = randomBytes(16);

    expect(() => pseudonymizerWith(shortKey)).toThrow(InvalidUserRefKeyError);
    expect(() => pseudonymizerWith(shortKey)).toThrow('User reference key must be a 32-byte secret key');
  });
});
