import { describe, expect, it } from 'vitest';
import { creditCardDetector } from '../../../../../src/secure-inquiry/domain/sanitization/detectors/credit-card-detector.js';

function detectedValues(text: string): string[] {
  return creditCardDetector
    .detect(text)
    .map((match) => text.slice(match.start, match.end))
    .sort();
}

describe('creditCardDetector', () => {
  it('detects CREDIT_CARD matches', () => {
    expect(creditCardDetector.type).toBe('CREDIT_CARD');
  });

  it.each([
    ['4222222222222', '13 contiguous digits'],
    ['30569309025904', '14 contiguous digits'],
    ['378282246310005', '15 contiguous digits'],
    ['4111111111111111', '16 contiguous digits'],
    ['6011000990139424123', '19 contiguous digits'],
    ['4111 1111 1111 1111', '4-4-4-4 with spaces'],
    ['4111-1111-1111-1111', '4-4-4-4 with hyphens'],
    ['6011 0009 9013 9424 123', '4-4-4-4-3 with spaces'],
    ['3782 822463 10005', '4-6-5 (Amex) with spaces'],
    ['3782-822463-10005', '4-6-5 (Amex) with hyphens'],
    ['3056 930902 5904', '4-6-4 (Diners) with spaces'],
  ])('detects %s (%s)', (text) => {
    expect(detectedValues(text)).toStrictEqual([text]);
  });

  it.each([
    ['Card:4111111111111111.', '4111111111111111'],
    ['(4111-1111-1111-1111)', '4111-1111-1111-1111'],
    ['pay with 4111 1111 1111 1111, thanks', '4111 1111 1111 1111'],
  ])('leaves surrounding punctuation outside the match in %s', (text, expected) => {
    expect(detectedValues(text)).toStrictEqual([expected]);
  });

  it('detects every card in a message', () => {
    expect(detectedValues('cards 4111111111111111 and 5500 0000 0000 0004')).toStrictEqual([
      '4111111111111111',
      '5500 0000 0000 0004',
    ]);
  });

  it('detects contiguous cards separated by a single space', () => {
    expect(detectedValues('4111111111111111 4222222222222222')).toStrictEqual(['4111111111111111', '4222222222222222']);
  });

  it.each([
    ['412345678901', '12 contiguous digits'],
    ['4111 1111 1111', '12 grouped digits'],
    ['12345678901234567890', '20 contiguous digits'],
    ['4111 1111 1111 1111 2222', 'a longer grouped number'],
    ['4111-1111-1111-1111-2222', 'a longer hyphenated number'],
    ['ID4111111111111111', 'digits glued to a letter prefix'],
    ['4111111111111111X', 'digits glued to a letter suffix'],
    ['3.1415926535897932', 'a decimal fraction'],
    ['+1 (555) 123-4567', 'a phone number'],
    ['2026-10-27', 'a date'],
    ['192.168.100.200', 'an IP address'],
  ])('ignores %s (%s)', (text) => {
    expect(detectedValues(text)).toStrictEqual([]);
  });

  it.each([
    ['4111-1111 1111-1111', 'mixed separators'],
    ['4111.1111.1111.1111', 'dot separators'],
    ['4111  1111  1111  1111', 'double spaces'],
    ['4111 1111 1111 1111 4222 2222 2222 2222', 'two grouped cards joined by a single space'],
  ])('does not detect %s (%s, documented limitation)', (text) => {
    expect(detectedValues(text)).toStrictEqual([]);
  });
});
