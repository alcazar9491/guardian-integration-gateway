import type { MessageSanitizer, RedactionFindings, SanitizationResult } from '../message-sanitizer.js';
import type { PiiType } from '../pii-type.js';
import type { RedactedText } from '../redacted-text.js';
import { applyRedactions } from './apply-redactions.js';
import { creditCardDetector } from './detectors/credit-card-detector.js';
import { emailDetector } from './detectors/email-detector.js';
import { ssnDetector } from './detectors/ssn-detector.js';
import { InvalidSanitizerInputError } from './invalid-sanitizer-input-error.js';
import type { PiiDetector, PiiMatch } from './pii-detector.js';
import { resolveOverlaps } from './resolve-overlaps.js';

/** Pure and stateless: every detector scans the original text, then one pass writes the labels. */
export class PiiSanitizer implements MessageSanitizer {
  constructor(private readonly detectors: readonly PiiDetector[]) {}

  sanitize(raw: string): SanitizationResult {
    assertIsString(raw);

    const candidates = this.detectors.flatMap((detector) => detector.detect(raw));
    const redactions = resolveOverlaps(candidates);

    return Object.freeze({
      text: applyRedactions(raw, redactions) as RedactedText,
      findings: countFindings(redactions),
    });
  }
}

export function createPiiSanitizer(): PiiSanitizer {
  return new PiiSanitizer([emailDetector, creditCardDetector, ssnDetector]);
}

function assertIsString(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new InvalidSanitizerInputError();
  }
}

function countFindings(redactions: readonly PiiMatch[]): RedactionFindings {
  const findings: Partial<Record<PiiType, number>> = {};
  for (const { type } of redactions) {
    findings[type] = (findings[type] ?? 0) + 1;
  }
  return Object.freeze(findings);
}
