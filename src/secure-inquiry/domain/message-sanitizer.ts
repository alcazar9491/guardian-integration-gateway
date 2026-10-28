import type { PiiType } from './pii-type.js';
import type { RedactedText } from './redacted-text.js';

export type RedactionFindings = Readonly<Partial<Record<PiiType, number>>>;

export interface SanitizationResult {
  readonly text: RedactedText;
  readonly findings: RedactionFindings;
}

export interface MessageSanitizer {
  sanitize(raw: string): SanitizationResult;
}
