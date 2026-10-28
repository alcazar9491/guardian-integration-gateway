import type { PiiMatch } from './pii-detector.js';
import { redactionLabel } from './redaction-label.js';

/**
 * Expects sorted, non-overlapping redactions as returned by `resolveOverlaps`.
 * Labels are written in a single pass over the original text and never re-scanned.
 */
export function applyRedactions(text: string, redactions: readonly PiiMatch[]): string {
  let output = '';
  let cursor = 0;

  for (const redaction of redactions) {
    output += text.slice(cursor, redaction.start) + redactionLabel(redaction.type);
    cursor = redaction.end;
  }

  return output + text.slice(cursor);
}
