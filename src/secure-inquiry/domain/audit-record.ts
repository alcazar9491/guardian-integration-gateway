import type { EncryptedPayload } from './encrypted-payload.js';
import type { RedactionFindings } from './message-sanitizer.js';
import type { RedactedText } from './redacted-text.js';

export const AUDIT_RECORD_SCHEMA_VERSION = 1;

export const AUDIT_OUTCOMES = [
  'PENDING',
  'COMPLETED',
  'PROVIDER_FAILURE',
  'PROVIDER_TIMEOUT',
  'CIRCUIT_OPEN_FALLBACK',
  'CANCELLED',
  'INTERNAL_ERROR',
] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * One revision of an inquiry's audit trail. Revision 1 (`PENDING`) is written before anything leaves the
 * service; a later revision carries the final outcome. Never holds the original message in plaintext or the
 * raw userId.
 */
export interface AuditRecord {
  readonly schemaVersion: typeof AUDIT_RECORD_SCHEMA_VERSION;
  readonly auditId: string;
  readonly revision: number;
  /** ISO-8601: when the inquiry was received. */
  readonly createdAt: string;
  /** ISO-8601: when this revision was written. */
  readonly recordedAt: string;
  /** Keyed pseudonym of the userId. */
  readonly userRef: string;
  readonly sanitizedMessage: RedactedText;
  readonly redactions: RedactionFindings;
  readonly encryptedMessage: EncryptedPayload;
  readonly outcome: AuditOutcome;
}

/** A record read back from storage: its text is no longer guaranteed to be sanitizer output. */
export type PersistedAuditRecord = Omit<AuditRecord, 'sanitizedMessage'> & { readonly sanitizedMessage: string };
