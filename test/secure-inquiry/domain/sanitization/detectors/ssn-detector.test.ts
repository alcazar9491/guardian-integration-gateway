import { describe, expect, it } from 'vitest';
import { ssnDetector } from '../../../../../src/secure-inquiry/domain/sanitization/detectors/ssn-detector.js';

function detectedValues(text: string): string[] {
  return ssnDetector
    .detect(text)
    .map((match) => text.slice(match.start, match.end))
    .sort();
}

describe('ssnDetector', () => {
  it('detects SSN matches', () => {
    expect(ssnDetector.type).toBe('SSN');
  });

  it.each([
    ['123-45-6789', 'hyphenated SSN'],
    ['123 45 6789', 'space-separated SSN'],
    ['123456789', 'standalone 9-digit identifier'],
  ])('detects %s (%s)', (text) => {
    expect(detectedValues(text)).toStrictEqual([text]);
  });

  it.each([
    ['SSN:123-45-6789.', '123-45-6789'],
    ['(123456789)', '123456789'],
    ['id #123456789!', '123456789'],
    ['My SSN is 123456789.', '123456789'],
    ['123-45-6789 2026', '123-45-6789'],
  ])('leaves surrounding text outside the match in %s', (text, expected) => {
    expect(detectedValues(text)).toStrictEqual([expected]);
  });

  it('detects every identifier in a message', () => {
    expect(detectedValues('ids 123456789 and 987-65-4321\nalso 111 22 3333')).toStrictEqual([
      '111 22 3333',
      '123456789',
      '987-65-4321',
    ]);
  });

  it('detects comma-separated identifiers', () => {
    expect(detectedValues('123456789,987654321')).toStrictEqual(['123456789', '987654321']);
  });

  it.each([
    ['12345678', '8 digits'],
    ['1234567890', '10 digits'],
    ['ID123456789', 'digits glued to a letter prefix'],
    ['123456789abc', 'digits glued to a letter suffix'],
    ['123-456-789', '3-3-3 grouping'],
    ['12-345-6789', '2-3-4 grouping'],
    ['123-45-67890', 'an oversized last group'],
    ['123-45-6789-0000', 'a longer hyphenated number'],
    ['0.123456789', 'a decimal fraction'],
    ['123456789.50', 'a decimal amount'],
    ['123-45 6789', 'mixed separators'],
  ])('ignores %s (%s)', (text) => {
    expect(detectedValues(text)).toStrictEqual([]);
  });
});
