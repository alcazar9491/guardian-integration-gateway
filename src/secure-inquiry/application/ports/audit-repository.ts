import type { AuditRecord } from '../../domain/audit-record.js';

export interface AuditRepository {
  /**
   * Appends one revision of a record; a later revision with the same `auditId` supersedes earlier ones.
   * Rejects with AuditPersistenceError when the revision cannot be stored durably.
   */
  append(record: AuditRecord): Promise<void>;
}
