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

  it.each([65, 300])('detects an address whose local part has %i characters', (length) => {
    const address = `${'x'.repeat(length)}@example.com`;

    expect(detectedValues(`Mail ${address} now`)).toStrictEqual([address]);
  });

  it.each([
    ['müller.hans@example.com', 'non-ASCII local part'],
    ['josé@ejemplo.com', 'local part ending in a non-ASCII letter'],
    ['müller.hans@example.com', 'decomposed local part with a combining mark'],
    ['user@bücher.example', 'non-ASCII domain label'],
    ['info@пример.рф', 'non-ASCII TLD'],
    ['contact@डाटामेल.भारत', 'domain and TLD with combining vowel signs'],
    ['用户@例子.广告', 'ideographic local part, domain, and TLD'],
  ])('detects the whole address %s (%s)', (address) => {
    expect(detectedValues(`Write to ${address}, please`)).toStrictEqual([address]);
  });

  it('starts the match at the beginning of a non-ASCII local part, never inside it', () => {
    const text = 'Grüße an Ärger.Öl@example.com';

    expect(detectedValues(text)).toStrictEqual(['Ärger.Öl@example.com']);
  });
});
