import {
  CircuitOpenError,
  type CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
  type CircuitStateChange,
  type ErrorClassification,
  type TimeSource,
} from './circuit-breaker.js';

function assertValidOptions({ failureThreshold, cooldownMs }: CircuitBreakerOptions): void {
  if (!Number.isSafeInteger(failureThreshold) || failureThreshold < 1) {
    throw new RangeError('failureThreshold must be an integer >= 1');
  }
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    throw new RangeError('cooldownMs must be a finite number > 0');
  }
}

const countEveryError = (): ErrorClassification => 'failure';

/**
 * Opens after `failureThreshold` consecutive failures and allows one probe after `cooldownMs`.
 * Holds no timers: OPEN → HALF_OPEN is evaluated when a call arrives, against the injected clock.
 */
export class ConsecutiveFailuresCircuitBreaker implements CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly classifyError: (error: unknown) => ErrorClassification;
  private readonly onStateChange: ((change: CircuitStateChange) => void) | undefined;

  private currentState: CircuitState = 'CLOSED';
  private failureCount = 0;
  private openedAt = 0;
  private probeInFlight = false;
  // Bumped on every transition. Outcomes of calls admitted under an older generation are stale:
  // a late failure must not extend the cooldown, and a late success must not close the circuit.
  private generation = 0;

  constructor(
    options: CircuitBreakerOptions,
    private readonly clock: TimeSource,
  ) {
    assertValidOptions(options);
    this.failureThreshold = options.failureThreshold;
    this.cooldownMs = options.cooldownMs;
    this.classifyError = options.classifyError ?? countEveryError;
    this.onStateChange = options.onStateChange;
  }

  get state(): CircuitState {
    return this.currentState;
  }

  get consecutiveFailures(): number {
    return this.failureCount;
  }

  // Deliberately not async: the fail-fast path must reject without calling or awaiting the operation.
  execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.admit()) {
      return Promise.reject(new CircuitOpenError());
    }
    return this.run(operation, this.generation);
  }

  private admit(): boolean {
    switch (this.currentState) {
      case 'CLOSED':
        return true;
      case 'OPEN':
        if (this.now() - this.openedAt < this.cooldownMs) {
          return false;
        }
        this.transitionTo('HALF_OPEN');
        this.probeInFlight = true;
        return true;
      case 'HALF_OPEN':
        // Only reachable without a probe in flight after an ignored probe: the next call probes.
        if (this.probeInFlight) {
          return false;
        }
        this.probeInFlight = true;
        return true;
    }
  }

  private async run<T>(operation: () => Promise<T>, admittedIn: number): Promise<T> {
    try {
      const value = await operation();
      this.recordSuccess(admittedIn);
      return value;
    } catch (error) {
      this.recordFailure(admittedIn, error);
      throw error;
    }
  }

  private recordSuccess(admittedIn: number): void {
    if (admittedIn !== this.generation) {
      return;
    }
    if (this.currentState === 'HALF_OPEN') {
      this.transitionTo('CLOSED');
      return;
    }
    this.failureCount = 0;
  }

  private recordFailure(admittedIn: number, error: unknown): void {
    if (admittedIn !== this.generation) {
      return;
    }
    if (this.classify(error) === 'ignore') {
      if (this.currentState === 'HALF_OPEN') {
        this.probeInFlight = false;
      }
      return;
    }
    if (this.currentState === 'HALF_OPEN') {
      this.open();
      return;
    }
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) {
      this.open();
    }
  }

  private classify(error: unknown): ErrorClassification {
    try {
      return this.classifyError(error);
    } catch {
      // A broken classifier must not hide a provider failure.
      return 'failure';
    }
  }

  private open(): void {
    this.openedAt = this.now();
    this.transitionTo('OPEN');
  }

  private transitionTo(to: CircuitState): void {
    const from = this.currentState;
    this.currentState = to;
    this.generation += 1;
    this.probeInFlight = false;
    if (to === 'CLOSED') {
      this.failureCount = 0;
    }
    this.notify({ from, to });
  }

  private notify(change: CircuitStateChange): void {
    try {
      this.onStateChange?.(change);
    } catch {
      // Observability must never corrupt the breaker or replace the caller's outcome.
    }
  }

  private now(): number {
    return this.clock.now().getTime();
  }
}
