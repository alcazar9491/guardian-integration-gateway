import { describe, expect, it } from 'vitest';
import type { PiiType } from '../../../../src/secure-inquiry/domain/pii-type.js';
import type { PiiMatch } from '../../../../src/secure-inquiry/domain/sanitization/pii-detector.js';
import { resolveOverlaps } from '../../../../src/secure-inquiry/domain/sanitization/resolve-overlaps.js';

function span(type: PiiType, start: number, end: number): PiiMatch {
  return { type, start, end };
}

describe('resolveOverlaps', () => {
  it('returns nothing when there are no candidates', () => {
    expect(resolveOverlaps([])).toStrictEqual([]);
  });

  it('keeps disjoint candidates and orders them by position', () => {
    expect(resolveOverlaps([span('SSN', 20, 29), span('EMAIL', 0, 10)])).toStrictEqual([
      span('EMAIL', 0, 10),
      span('SSN', 20, 29),
    ]);
  });

  it('keeps adjacent candidates separate because they share no character', () => {
    expect(resolveOverlaps([span('SSN', 0, 9), span('EMAIL', 9, 20)])).toStrictEqual([
      span('SSN', 0, 9),
      span('EMAIL', 9, 20),
    ]);
  });

  it('collapses duplicate candidates', () => {
    expect(resolveOverlaps([span('SSN', 3, 12), span('SSN', 3, 12)])).toStrictEqual([span('SSN', 3, 12)]);
  });

  it('absorbs a contained candidate into its container', () => {
    expect(resolveOverlaps([span('SSN', 0, 9), span('EMAIL', 0, 21)])).toStrictEqual([span('EMAIL', 0, 21)]);
  });

  it('merges partially overlapping candidates into their union, labelled by the longest', () => {
    expect(resolveOverlaps([span('SSN', 0, 11), span('CREDIT_CARD', 5, 24)])).toStrictEqual([
      span('CREDIT_CARD', 0, 24),
    ]);
  });

  it('merges overlap chains transitively', () => {
    expect(resolveOverlaps([span('SSN', 0, 5), span('CREDIT_CARD', 11, 15), span('SSN', 4, 12)])).toStrictEqual([
      span('SSN', 0, 15),
    ]);
  });

  it.each([
    [span('SSN', 0, 9), span('CREDIT_CARD', 0, 9), 'CREDIT_CARD'],
    [span('CREDIT_CARD', 0, 9), span('EMAIL', 0, 9), 'EMAIL'],
    [span('SSN', 0, 9), span('EMAIL', 0, 9), 'EMAIL'],
  ] as const)('breaks equal-length ties by priority EMAIL > CREDIT_CARD > SSN', (first, second, winner) => {
    expect(resolveOverlaps([first, second])).toStrictEqual([span(winner, 0, 9)]);
    expect(resolveOverlaps([second, first])).toStrictEqual([span(winner, 0, 9)]);
  });

  it('gives the same result for every candidate order', () => {
    const candidates = [span('SSN', 0, 9), span('EMAIL', 0, 21), span('CREDIT_CARD', 30, 46), span('SSN', 40, 49)];
    const expected = [span('EMAIL', 0, 21), span('CREDIT_CARD', 30, 49)];

    for (const order of permutations(candidates)) {
      expect(resolveOverlaps(order)).toStrictEqual(expected);
    }
  });

  it('neither mutates its input nor returns a mutable result', () => {
    const candidates = Object.freeze([span('SSN', 10, 19), span('EMAIL', 0, 5)]);

    const resolved = resolveOverlaps(candidates);

    expect(candidates).toStrictEqual([span('SSN', 10, 19), span('EMAIL', 0, 5)]);
    expect(Object.isFrozen(resolved)).toBe(true);
  });
});

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}
