import type { AuditOutcome } from '../../domain/audit-record.js';

export interface AuditOutcomeNotRecorded {
  readonly auditId: string;
  readonly outcome: AuditOutcome;
  readonly cause: unknown;
}

/**
 * Deliberately narrow: it accepts identifiers and an error, never message content, so it cannot become a
 * channel for logging request data.
 */
export interface AuditFailureReporter {
  /** The final outcome revision could not be persisted; revision 1 already audits the inquiry. */
  outcomeNotRecorded(event: AuditOutcomeNotRecorded): void;
}
