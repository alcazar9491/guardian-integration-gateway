export interface AuditRecordIdentity {
  readonly auditId: string;
  readonly userRef: string;
}

/**
 * Associated data that binds an encrypted original to its audit record. Rebuilt from the stored fields at
 * verification time. A JSON array stays unambiguous whatever characters the values contain.
 */
export function auditAssociatedData({ auditId, userRef }: AuditRecordIdentity): string {
  return JSON.stringify([auditId, userRef]);
}
