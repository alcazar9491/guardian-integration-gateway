import { describe, expect, it } from 'vitest';
import {
  alwaysFail,
  alwaysSucceed,
  failFirst,
  scripted,
  type OutcomeSchedule,
  type SimulatedOutcome,
} from '../../../../src/secure-inquiry/infrastructure/ai-provider/outcome-schedule.js';

function take(schedule: OutcomeSchedule, count: number): SimulatedOutcome[] {
  return Array.from({ length: count }, () => schedule.next());
}

describe('alwaysSucceed', () => {
  it('always yields success', () => {
    expect(take(alwaysSucceed(), 5)).toEqual(['success', 'success', 'success', 'success', 'success']);
  });
});

describe('alwaysFail', () => {
  it('always yields failure', () => {
    expect(take(alwaysFail(), 5)).toEqual(['failure', 'failure', 'failure', 'failure', 'failure']);
  });
});

describe('failFirst', () => {
  it('fails the first n calls, then recovers for good', () => {
    expect(take(failFirst(3), 6)).toEqual(['failure', 'failure', 'failure', 'success', 'success', 'success']);
  });

  it('behaves like alwaysSucceed when n is 0', () => {
    expect(take(failFirst(0), 3)).toEqual(['success', 'success', 'success']);
  });

  it('keeps independent state per schedule', () => {
    const first = failFirst(1);
    const second = failFirst(1);

    expect(first.next()).toBe('failure');
    expect(second.next()).toBe('failure');
    expect(first.next()).toBe('success');
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid count (%s)', (count) => {
    expect(() => failFirst(count)).toThrow(RangeError);
  });
});

describe('scripted', () => {
  it('follows the script, then succeeds by default', () => {
    expect(take(scripted(['failure', 'success', 'failure']), 5)).toEqual([
      'failure',
      'success',
      'failure',
      'success',
      'success',
    ]);
  });

  it('follows the script, then repeats the configured outcome', () => {
    expect(take(scripted(['success'], { then: 'failure' }), 3)).toEqual(['success', 'failure', 'failure']);
  });

  it('uses the fallback outcome immediately for an empty script', () => {
    expect(take(scripted([], { then: 'failure' }), 2)).toEqual(['failure', 'failure']);
  });

  it('is not affected by later changes to the array it was given', () => {
    const outcomes: SimulatedOutcome[] = ['failure', 'failure'];
    const schedule = scripted(outcomes);

    outcomes[0] = 'success';
    outcomes.push('failure');

    expect(take(schedule, 4)).toEqual(['failure', 'failure', 'success', 'success']);
  });

  it('rejects unknown outcomes at construction', () => {
    const invalid = ['failure', 'sometimes'] as unknown as SimulatedOutcome[];

    expect(() => scripted(invalid)).toThrow(TypeError);
  });

  it('rejects an unknown fallback outcome at construction', () => {
    const invalid = { then: 'maybe' } as unknown as { then: SimulatedOutcome };

    expect(() => scripted([], invalid)).toThrow(TypeError);
  });
});
