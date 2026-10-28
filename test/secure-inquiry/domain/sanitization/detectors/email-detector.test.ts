import { describe, expect, it } from 'vitest';
import { emailDetector } from '../../../../../src/secure-inquiry/domain/sanitization/detectors/email-detector.js';

function detectedValues(text: string): string[] {
  return emailDetector.detect(text).map((match) => text.slice(match.start, match.end));
}

describe('emailDetector', () => {
  it('detects EMAIL matches', () => {
    expect(emailDetector.type).toBe('EMAIL');
  });

  it.each([
    ['Contact john.doe+tag@mail.example.co.uk today', 'john.doe+tag@mail.example.co.uk'],
    ['first_last%dept@example.org', 'first_last%dept@example.org'],
    ['JOHN@EXAMPLE.COM', 'JOHN@EXAMPLE.COM'],
    ['ops@my-company.example', 'ops@my-company.example'],
    ['123456789@example.com', '123456789@example.com'],
    ['john@123456789.com', 'john@123456789.com'],
  ])('detects the address in %s', (text, expected) => {
    expect(detectedValues(text)).toStrictEqual([expected]);
  });

  it.each([
    ['Mail me: a@b.io.', 'a@b.io'],
    ['<john@example.com>', 'john@example.com'],
    ['(john@example.com)', 'john@example.com'],
    ['mailto:john@example.com', 'john@example.com'],
    ['Is it john@example.com?', 'john@example.com'],
    ['"john@example.com",', 'john@example.com'],
  ])('leaves surrounding punctuation outside the match in %s', (text, expected) => {
    expect(detectedValues(text)).toStrictEqual([expected]);
  });

  it('detects every address in a message', () => {
    expect(detectedValues('a@x.com, b@y.org;\nc@z.net')).toStrictEqual(['a@x.com', 'b@y.org', 'c@z.net']);
  });

  it.each([
    'john@',
    '@example.com',
    'john@example',
    'john@@example.com',
    'john@.com',
    'john@-example.com',
    'john@example.c',
    'john@example.123',
    'john at example dot com',
  ])('ignores the malformed address %s', (text) => {
    expect(detectedValues(text)).toStrictEqual([]);
  });

  it('ignores local parts longer than the 64-character limit', () => {
    expect(detectedValues(`${'x'.repeat(65)}@example.com`)).toStrictEqual([]);
  });
});
