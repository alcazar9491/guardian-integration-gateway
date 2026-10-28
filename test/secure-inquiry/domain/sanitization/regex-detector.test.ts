import { describe, expect, it } from 'vitest';
import { createRegexDetector } from '../../../../src/secure-inquiry/domain/sanitization/regex-detector.js';

describe('createRegexDetector', () => {
  it('reports the type and half-open offsets of every match', () => {
    const detector = createRegexDetector('SSN', [/\d{3}/gu]);

    expect(detector.type).toBe('SSN');
    expect(detector.detect('a 123 b 456')).toStrictEqual([
      { type: 'SSN', start: 2, end: 5 },
      { type: 'SSN', start: 8, end: 11 },
    ]);
  });

  it('combines the matches of every pattern', () => {
    const detector = createRegexDetector('EMAIL', [/\d{2}/gu, /[a-z]{2}/gu]);

    expect(detector.detect('ab 12')).toStrictEqual([
      { type: 'EMAIL', start: 3, end: 5 },
      { type: 'EMAIL', start: 0, end: 2 },
    ]);
  });

  it('returns no matches for text without the pattern', () => {
    const detector = createRegexDetector('SSN', [/\d{3}/gu]);

    expect(detector.detect('')).toStrictEqual([]);
    expect(detector.detect('no digits here')).toStrictEqual([]);
  });

  it('ignores zero-length matches', () => {
    const detector = createRegexDetector('SSN', [/\d*/gu]);

    expect(detector.detect('a1')).toStrictEqual([{ type: 'SSN', start: 1, end: 2 }]);
  });

  it('rejects patterns without the global flag', () => {
    expect(() => createRegexDetector('SSN', [/\d/u])).toThrow(TypeError);
  });

  it('is repeatable and leaves the shared pattern untouched', () => {
    const pattern = /\d{3}/gu;
    const detector = createRegexDetector('SSN', [pattern]);

    const first = detector.detect('123 456');
    const second = detector.detect('123 456');

    expect(second).toStrictEqual(first);
    expect(pattern.lastIndex).toBe(0);
  });

  it('returns frozen matches', () => {
    const matches = createRegexDetector('SSN', [/\d{3}/gu]).detect('123');

    expect(Object.isFrozen(matches)).toBe(true);
    expect(matches.every((match) => Object.isFrozen(match))).toBe(true);
  });
});
