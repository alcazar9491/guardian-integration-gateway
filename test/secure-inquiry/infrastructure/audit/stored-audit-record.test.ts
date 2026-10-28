import { describe, expect, it } from 'vitest';
import { AuditPersistenceError } from '../../../../src/secure-inquiry/application/errors.js';
import type { AuditRecord } from '../../../../src/secure-inquiry/domain/audit-record.js';
import type { RedactedText } from '../../../../src/secure-inquiry/domain/redacted-text.js';
import {
  parseAuditLine,
  serializeAuditRecord,
  toStoredRecord,
} from '../../../../src/secure-inquiry/infrastructure/audit/stored-audit-record.js';
import { auditRecordFixture } from './audit-record-fixture.js';

const RECORD_KEYS = [
  'schemaVersion',
  'auditId',
  'revision',
  'createdAt',
  'recordedAt',
  'userRef',
  'sanitizedMessage',
  'redactions',
  'encryptedMessage',
  'outcome',
];
const PAYLOAD_KEYS = ['algorithm', 'version', 'keyId', 'iv', 'authTag', 'ciphertext'];

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw');
}

describe('toStoredRecord', () => {
  it('keeps exactly the v1 fields', () => {
    const stored = toStoredRecord(auditRecordFixture());

    expect(Object.keys(stored)).toEqual(RECORD_KEYS);
    expect(Object.keys(stored.encryptedMessage)).toEqual(PAYLOAD_KEYS);
  });

  it('drops stray runtime properties, so an accidental original never reaches the file', () => {
    const fixture = auditRecordFixture();
    const polluted = {
      ...fixture,
      originalMessage: 'Email jane@example.com about my order',
      userId: 'jane@example.com',
      encryptedMessage: { ...fixture.encryptedMessage, key: 'not-a-real-key' },
      redactions: { EMAIL: 1, PHONE: 2 },
    } as unknown as AuditRecord;

    const serialized = JSON.stringify(toStoredRecord(polluted));

    expect(serialized).not.toContain('jane@example.com');
    expect(serialized).not.toContain('not-a-real-key');
    expect(serialized).not.toContain('PHONE');
    expect(toStoredRecord(polluted).redactions).toEqual({ EMAIL: 1 });
  });
});

describe('serializeAuditRecord', () => {
  it('produces exactly one newline-terminated JSON line, even for multi-line messages', () => {
    const record = auditRecordFixture({ sanitizedMessage: 'line one\nline two\r\nline three' as RedactedText });

    const line = serializeAuditRecord(record);

    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
  });

  it('round-trips through parseAuditLine', () => {
    const record = auditRecordFixture({ revision: 2, outcome: 'CIRCUIT_OPEN_FALLBACK' });

    expect(parseAuditLine(serializeAuditRecord(record).trimEnd())).toEqual(toStoredRecord(record));
  });

  it.each([
    ['an invalid timestamp', { createdAt: 'yesterday' }],
    ['revision 0', { revision: 0 }],
    ['an unknown outcome', { outcome: 'MAYBE' }],
    ['an empty audit id', { auditId: '' }],
  ])('refuses to write a record with %s, without echoing record content', (_label, override) => {
    const record = auditRecordFixture(override as Partial<AuditRecord>);

    const error = captureError(() => serializeAuditRecord(record));

    expect(error).toBeInstanceOf(AuditPersistenceError);
    const rendered = `${String(error)} ${(error as Error).stack ?? ''} ${String((error as Error).cause)}`;
    expect(rendered).not.toContain(record.sanitizedMessage);
    expect(rendered).not.toContain(record.encryptedMessage.ciphertext);
  });
});

describe('parseAuditLine', () => {
  const validLine = serializeAuditRecord(auditRecordFixture()).trimEnd();

  it('parses a valid line into a persisted record', () => {
    expect(parseAuditLine(validLine)).toMatchObject({ schemaVersion: 1, revision: 1, outcome: 'PENDING' });
  });

  it.each([
    ['malformed JSON', '{"schemaVersion":1,'],
    ['a torn fragment', validLine.slice(0, Math.floor(validLine.length / 2))],
    ['a JSON number', '42'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['an unknown schema version', validLine.replace('"schemaVersion":1', '"schemaVersion":2')],
    ['an unexpected extra field', validLine.replace(/\}$/, ',"originalMessage":"hello"}')],
    ['a missing field', validLine.replace(/"outcome":"PENDING",?/, '').replace(',}', '}')],
    ['a prototype key', validLine.replace(/\}$/, ',"__proto__":{"polluted":true}}')],
  ])('rejects %s', (_label, line) => {
    expect(parseAuditLine(line)).toBeUndefined();
  });
});
