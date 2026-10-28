import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecryptionError } from '../../../../src/secure-inquiry/application/errors.js';
import { auditAssociatedData } from '../../../../src/secure-inquiry/domain/audit-associated-data.js';
import type { AuditRecord } from '../../../../src/secure-inquiry/domain/audit-record.js';
import { createPiiSanitizer } from '../../../../src/secure-inquiry/domain/sanitization/pii-sanitizer.js';
import { AesGcmEncryptionService } from '../../../../src/secure-inquiry/infrastructure/aes-gcm-encryption-service.js';
import { JsonlAuditRepository } from '../../../../src/secure-inquiry/infrastructure/audit/jsonl-audit-repository.js';
import { HmacUserPseudonymizer } from '../../../../src/secure-inquiry/infrastructure/hmac-user-pseudonymizer.js';

const ORIGINAL = 'Contact jane.doe@example.com, card 4111 1111 1111 1111, SSN 123-45-6789. Thanks!';
const USER_ID = 'john.roe@example.org';
const SENSITIVE_VALUES = [ORIGINAL, 'jane.doe@example.com', '4111 1111 1111 1111', '123-45-6789', USER_ID];

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'guardian-audit-'));
  filePath = join(directory, 'audit.jsonl');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function newEncryption(): AesGcmEncryptionService {
  return new AesGcmEncryptionService({ key: createSecretKey(randomBytes(32)), keyId: 'v1' });
}

function auditStore() {
  const encryption = newEncryption();
  const pseudonymizer = new HmacUserPseudonymizer({ key: createSecretKey(randomBytes(32)) });
  const sanitizer = createPiiSanitizer();
  const repository = new JsonlAuditRepository({ filePath });

  // Mirrors what the use case will do: pseudonymize, sanitize, and encrypt bound to the record identity.
  function pendingRecord(original: string, userId: string): AuditRecord {
    const auditId = randomUUID();
    const userRef = pseudonymizer.pseudonymize(userId);
    const { text, findings } = sanitizer.sanitize(original);
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      auditId,
      revision: 1,
      createdAt: now,
      recordedAt: now,
      userRef,
      sanitizedMessage: text,
      redactions: findings,
      encryptedMessage: encryption.encrypt(original, auditAssociatedData({ auditId, userRef })),
      outcome: 'PENDING',
    };
  }

  return { encryption, pseudonymizer, repository, pendingRecord };
}

describe('audit store security', () => {
  it('never writes the original message, its PII values, or the raw userId to the file', async () => {
    const { repository, pendingRecord } = auditStore();
    const pending = pendingRecord(ORIGINAL, USER_ID);

    await repository.append(pending);
    await repository.append({ ...pending, revision: 2, outcome: 'COMPLETED' });

    const raw = await readFile(filePath, 'utf8');
    for (const value of SENSITIVE_VALUES) {
      expect(raw).not.toContain(value);
    }
  });

  it('keeps the redacted message readable without any key', async () => {
    const { repository, pendingRecord } = auditStore();
    const pending = pendingRecord(ORIGINAL, USER_ID);
    await repository.append(pending);

    const raw = await readFile(filePath, 'utf8');
    const stored = await repository.findById(pending.auditId);

    expect(raw).toContain(pending.sanitizedMessage);
    expect(stored?.sanitizedMessage).toBe(
      'Contact <REDACTED: EMAIL>, card <REDACTED: CREDIT_CARD>, SSN <REDACTED: SSN>. Thanks!',
    );
    expect(stored?.redactions).toEqual({ EMAIL: 1, CREDIT_CARD: 1, SSN: 1 });
  });

  it('recovers the original only through authorized decryption with the record identity', async () => {
    const { encryption, repository, pendingRecord } = auditStore();
    const pending = pendingRecord(ORIGINAL, USER_ID);
    await repository.append(pending);
    await repository.append({ ...pending, revision: 2, outcome: 'CIRCUIT_OPEN_FALLBACK' });

    const stored = await repository.findById(pending.auditId);
    if (stored === undefined) throw new Error('Expected the record to be stored');

    expect(stored.outcome).toBe('CIRCUIT_OPEN_FALLBACK');
    expect(encryption.decrypt(stored.encryptedMessage, auditAssociatedData(stored))).toBe(ORIGINAL);
  });

  it('cannot be decrypted with a different key', async () => {
    const { repository, pendingRecord } = auditStore();
    const pending = pendingRecord(ORIGINAL, USER_ID);
    await repository.append(pending);

    const stored = await repository.findById(pending.auditId);
    if (stored === undefined) throw new Error('Expected the record to be stored');

    expect(() => newEncryption().decrypt(stored.encryptedMessage, auditAssociatedData(stored))).toThrow(
      new DecryptionError('AUTHENTICATION_FAILED'),
    );
  });

  it('rejects a ciphertext swapped onto another record', async () => {
    const { encryption, repository, pendingRecord } = auditStore();
    const first = pendingRecord(ORIGINAL, USER_ID);
    const second = pendingRecord('Another inquiry from the same user', USER_ID);
    await repository.append(first);
    await repository.append(second);

    const storedFirst = await repository.findById(first.auditId);
    const storedSecond = await repository.findById(second.auditId);
    if (storedFirst === undefined || storedSecond === undefined) throw new Error('Expected both records');

    expect(() => encryption.decrypt(storedSecond.encryptedMessage, auditAssociatedData(storedFirst))).toThrow(
      DecryptionError,
    );
  });

  it('rejects a record whose user reference was altered', async () => {
    const { encryption, pseudonymizer, repository, pendingRecord } = auditStore();
    const pending = pendingRecord(ORIGINAL, USER_ID);
    await repository.append(pending);

    const stored = await repository.findById(pending.auditId);
    if (stored === undefined) throw new Error('Expected the record to be stored');
    const forged = { ...stored, userRef: pseudonymizer.pseudonymize('someone.else@example.org') };

    expect(() => encryption.decrypt(forged.encryptedMessage, auditAssociatedData(forged))).toThrow(DecryptionError);
  });

  it("lets an authorized investigator find a user's records by recomputing the reference", async () => {
    const { pseudonymizer, repository, pendingRecord } = auditStore();
    const mine = pendingRecord(ORIGINAL, USER_ID);
    await repository.append(mine);
    await repository.append(pendingRecord('Unrelated inquiry', 'another-user'));

    const { records } = await repository.scan();
    const matches = records.filter((record) => record.userRef === pseudonymizer.pseudonymize(USER_ID));

    expect(matches.map((record) => record.auditId)).toEqual([mine.auditId]);
  });
});
