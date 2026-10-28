import type { PiiType } from '../pii-type.js';
import type { PiiDetector, PiiMatch } from './pii-detector.js';

/**
 * Patterns are only consumed through `matchAll`, which iterates over an internal copy,
 * so the shared module-level RegExp objects never carry `lastIndex` state between calls.
 */
export function createRegexDetector(type: PiiType, patterns: readonly RegExp[]): PiiDetector {
  for (const pattern of patterns) {
    if (!pattern.global) {
      throw new TypeError(`Detector patterns for ${type} must use the global flag`);
    }
  }

  return Object.freeze({
    type,
    detect: (text: string): readonly PiiMatch[] =>
      Object.freeze(patterns.flatMap((pattern) => findMatches(text, pattern, type))),
  });
}

function findMatches(text: string, pattern: RegExp, type: PiiType): PiiMatch[] {
  return [...text.matchAll(pattern)]
    .filter((match) => match[0].length > 0)
    .map((match) => Object.freeze({ type, start: match.index, end: match.index + match[0].length }));
}
