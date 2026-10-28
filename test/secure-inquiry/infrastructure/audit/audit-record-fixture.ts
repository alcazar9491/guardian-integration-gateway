import { randomBytes, randomUUID } from 'node:crypto';
import type { AuditRecord } from '../../../../src/secure-inquiry/domain/audit-record.js';
import type { RedactedText } from '../../../../src/secure-inquiry/domain/redacted-text.js';

/** A valid audit record revision with random identity and opaque encrypted fields. */
export function auditRecordFixture(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    schemaVersion: 1,
    auditId: randomUUID(),
    revision: 1,
    createdAt: '2026-10-27T12:00:00.000Z',
    recordedAt: '2026-10-27T12:00:00.010Z',
    userRef: randomBytes(32).toString('base64url'),
    sanitizedMessage: 'Email <REDACTED: EMAIL> about my order' as RedactedText,
    redactions: { EMAIL: 1 },
    encryptedMessage: {
      algorithm: 'aes-256-gcm',
      version: 1,
      keyId: 'v1',
      iv: randomBytes(12).toString('base64'),
      authTag: randomBytes(16).toString('base64'),
      ciphertext: randomBytes(40).toString('base64'),
    },
    outcome: 'PENDING',
    ...overrides,
  };
}
