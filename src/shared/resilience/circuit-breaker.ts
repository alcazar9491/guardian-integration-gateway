import { AppError } from '../errors/app-error.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** `ignore` leaves the breaker untouched: neither a failure nor a success (e.g. the caller cancelled). */
export type ErrorClassification = 'failure' | 'ignore';

export interface CircuitStateChange {
  readonly from: CircuitState;
  readonly to: CircuitState;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. Integer >= 1. */
  readonly failureThreshold: number;
  /** Time spent OPEN before a single HALF_OPEN probe is allowed. Milliseconds > 0. */
  readonly cooldownMs: number;
  /** Defaults to counting every error as a failure. */
  readonly classifyError?: (error: unknown) => ErrorClassification;
  /** Observability hook. A throwing listener never affects the breaker. */
  readonly onStateChange?: (change: CircuitStateChange) => void;
}

export interface TimeSource {
  now(): Date;
}

/** Read-only observation of a breaker: no way to change its state or run an operation through it. */
export interface CircuitStatus {
  readonly state: CircuitState;
  /** Counted failures in a row. Holds the threshold while OPEN or HALF_OPEN; 0 after a success or on close. */
  readonly consecutiveFailures: number;
}

export interface CircuitBreaker extends CircuitStatus {
  /** Rejects with CircuitOpenError, without invoking `operation`, while the circuit is short-circuiting. */
  execute<T>(operation: () => Promise<T>): Promise<T>;
}

export class CircuitOpenError extends AppError {
  override readonly code = 'CIRCUIT_OPEN';

  constructor() {
    super('Circuit is open');
  }
}
