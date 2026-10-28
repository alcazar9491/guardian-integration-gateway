export type SimulatedOutcome = 'success' | 'failure';

/** Decides, call by call, whether the simulated provider succeeds. Deterministic by design: no randomness. */
export interface OutcomeSchedule {
  next(): SimulatedOutcome;
}

export interface ScriptedOptions {
  /** Outcome repeated once the script is exhausted. Defaults to success (recovery). */
  readonly then?: SimulatedOutcome;
}

const OUTCOMES: readonly SimulatedOutcome[] = ['success', 'failure'];

function assertOutcome(value: unknown): asserts value is SimulatedOutcome {
  if (!OUTCOMES.includes(value as SimulatedOutcome)) {
    throw new TypeError(`Unknown simulated outcome; expected one of: ${OUTCOMES.join(', ')}`);
  }
}

export function scripted(outcomes: readonly SimulatedOutcome[], options: ScriptedOptions = {}): OutcomeSchedule {
  const script = [...outcomes];
  const then = options.then ?? 'success';
  script.forEach(assertOutcome);
  assertOutcome(then);

  let calls = 0;
  return {
    next: () => script[calls++] ?? then,
  };
}

export function alwaysSucceed(): OutcomeSchedule {
  return scripted([], { then: 'success' });
}

export function alwaysFail(): OutcomeSchedule {
  return scripted([], { then: 'failure' });
}

export function failFirst(count: number): OutcomeSchedule {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('failFirst count must be a non-negative integer');
  }
  return scripted(Array.from({ length: count }, (): SimulatedOutcome => 'failure'));
}
