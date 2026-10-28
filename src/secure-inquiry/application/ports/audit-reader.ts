import type { PersistedAuditRecord } from '../../domain/audit-record.js';

export interface AuditScanResult {
  /** Latest revision of each audit record. */
  readonly records: readonly PersistedAuditRecord[];
  /** Lines that could not be parsed or validated; skipped, never surfaced with their content. */
  readonly invalidLines: number;
}

/**
 * Verification-only port for automated tests and authorized internal review.
 * Never wired into the use case or exposed over HTTP.
 */
export interface AuditReader {
  /** Rejects with `AuditReadError` when the store cannot be read. */
  findById(auditId: string): Promise<PersistedAuditRecord | undefined>;
  scan(): Promise<AuditScanResult>;
}
