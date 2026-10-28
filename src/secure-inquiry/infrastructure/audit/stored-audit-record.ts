import { z } from 'zod';
import { AuditPersistenceError } from '../../application/errors.js';
import {
  AUDIT_OUTCOMES,
  AUDIT_RECORD_SCHEMA_VERSION,
  type AuditRecord,
  type PersistedAuditRecord,
} from '../../domain/audit-record.js';
import { ENCRYPTED_PAYLOAD_ALGORITHM, ENCRYPTED_PAYLOAD_VERSION } from '../../domain/encrypted-payload.js';
import type { RedactionFindings } from '../../domain/message-sanitizer.js';
import { PII_TYPES, type PiiType } from '../../domain/pii-type.js';

const storedEncryptedPayloadSchema = z.strictObject({
  algorithm: z.literal(ENCRYPTED_PAYLOAD_ALGORITHM),
  version: z.literal(ENCRYPTED_PAYLOAD_VERSION),
  keyId: z.string().min(1),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  ciphertext: z.string(),
});

/** Strict on purpose: an unexpected field in the file is treated as an invalid line, never surfaced. */
const storedAuditRecordSchema = z.strictObject({
  schemaVersion: z.literal(AUDIT_RECORD_SCHEMA_VERSION),
  auditId: z.string().min(1),
  revision: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  userRef: z.string().min(1),
  sanitizedMessage: z.string(),
  redactions: z.partialRecord(z.enum(PII_TYPES), z.number().int().min(0)),
  encryptedMessage: storedEncryptedPayloadSchema,
  outcome: z.enum(AUDIT_OUTCOMES),
});

export type StoredAuditRecord = z.infer<typeof storedAuditRecordSchema>;

function pickRedactions(findings: RedactionFindings): Partial<Record<PiiType, number>> {
  const picked: Partial<Record<PiiType, number>> = {};
  for (const type of PII_TYPES) {
    const count = findings[type];
    if (count !== undefined) picked[type] = count;
  }
  return picked;
}

/**
 * Whitelist serializer: copies only the v1 fields by name, so a stray runtime property (for example an
 * accidental `originalMessage`) can never reach the file.
 */
export function toStoredRecord(record: AuditRecord): StoredAuditRecord {
  const payload = record.encryptedMessage;
  return {
    schemaVersion: record.schemaVersion,
    auditId: record.auditId,
    revision: record.revision,
    createdAt: record.createdAt,
    recordedAt: record.recordedAt,
    userRef: record.userRef,
    sanitizedMessage: record.sanitizedMessage,
    redactions: pickRedactions(record.redactions),
    encryptedMessage: {
      algorithm: payload.algorithm,
      version: payload.version,
      keyId: payload.keyId,
      iv: payload.iv,
      authTag: payload.authTag,
      ciphertext: payload.ciphertext,
    },
    outcome: record.outcome,
  };
}

/** One newline-terminated JSON line. Validated first, so the store never holds a line it cannot read back. */
export function serializeAuditRecord(record: AuditRecord): string {
  const result = storedAuditRecordSchema.safeParse(toStoredRecord(record));
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new AuditPersistenceError({ cause: new Error(`Audit record failed validation at: ${fields}`) });
  }
  return `${JSON.stringify(result.data)}\n`;
}

/** Returns undefined for anything that is not a complete, valid v1 record: malformed, torn, or tampered. */
export function parseAuditLine(line: string): PersistedAuditRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const result = storedAuditRecordSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
