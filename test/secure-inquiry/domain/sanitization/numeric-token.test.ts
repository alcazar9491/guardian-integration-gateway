import { describe, expect, it } from 'vitest';
import { contiguousDigits, groupedDigits } from '../../../../src/secure-inquiry/domain/sanitization/numeric-token.js';

function matchesOf(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

describe('contiguousDigits', () => {
  it('matches a standalone run of the exact length', () => {
    expect(matchesOf(contiguousDigits(9), 'id 123456789 ok')).toStrictEqual(['123456789']);
  });

  it('matches any length within the range', () => {
    const pattern = contiguousDigits(13, 19);

    expect(matchesOf(pattern, '4222222222222')).toStrictEqual(['4222222222222']);
    expect(matchesOf(pattern, '6011000990139424123')).toStrictEqual(['6011000990139424123']);
    expect(matchesOf(pattern, '422222222222')).toStrictEqual([]);
    expect(matchesOf(pattern, '60110009901394241234')).toStrictEqual([]);
  });

  it.each(['12345678', '1234567890', 'A123456789', '123456789B', '_123456789', 'é123456789', '١123456789'])(
    'rejects %s because it is not a complete numeric token',
    (text) => {
      expect(matchesOf(contiguousDigits(9), text)).toStrictEqual([]);
    },
  );

  it.each(['0.123456789', '123456789.50'])('rejects %s because it is part of a decimal number', (text) => {
    expect(matchesOf(contiguousDigits(9), text)).toStrictEqual([]);
  });

  it.each([
    ['123456789.', '123456789'],
    ['Ref.123456789', '123456789'],
    ['(123456789)', '123456789'],
    ['#123456789!', '123456789'],
  ])('accepts %s because the punctuation does not join another number', (text, expected) => {
    expect(matchesOf(contiguousDigits(9), text)).toStrictEqual([expected]);
  });

  it('treats commas as list separators, not as part of a longer number', () => {
    expect(matchesOf(contiguousDigits(9), '123456789,987654321')).toStrictEqual(['123456789', '987654321']);
  });
});

describe('groupedDigits', () => {
  it('matches the grouping with the given separator', () => {
    expect(matchesOf(groupedDigits([3, 2, 4], '-'), 'ssn 123-45-6789 ok')).toStrictEqual(['123-45-6789']);
    expect(matchesOf(groupedDigits([3, 2, 4], ' '), 'ssn 123 45 6789 ok')).toStrictEqual(['123 45 6789']);
  });

  it('rejects another separator or mixed separators', () => {
    expect(matchesOf(groupedDigits([3, 2, 4], '-'), '123 45 6789')).toStrictEqual([]);
    expect(matchesOf(groupedDigits([3, 2, 4], '-'), '123-45 6789')).toStrictEqual([]);
  });

  it.each(['9-123-45-6789', '123-45-6789-0', '123-45-6789-0000'])(
    'rejects %s because it is a window inside a longer grouped number',
    (text) => {
      expect(matchesOf(groupedDigits([3, 2, 4], '-'), text)).toStrictEqual([]);
    },
  );

  it('accepts a neighbouring number joined by a different separator', () => {
    expect(matchesOf(groupedDigits([3, 2, 4], '-'), '123-45-6789 2026')).toStrictEqual(['123-45-6789']);
  });

  it.each(['x123-45-6789', '123-45-6789x', '123-45-67890', '1.123-45-6789', '123-45-6789.5'])(
    'applies the standalone token rules to %s',
    (text) => {
      expect(matchesOf(groupedDigits([3, 2, 4], '-'), text)).toStrictEqual([]);
    },
  );
});
