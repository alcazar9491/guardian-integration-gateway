import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../src/shared/errors/app-error.js';
import {
  CircuitOpenError,
  type CircuitBreakerOptions,
  type CircuitStateChange,
  type TimeSource,
} from '../../../src/shared/resilience/circuit-breaker.js';
import { ConsecutiveFailuresCircuitBreaker } from '../../../src/shared/resilience/consecutive-failures-circuit-breaker.js';

function fakeClock(start = 0): TimeSource & { advance(ms: number): void } {
  let current = start;
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

const COOLDOWN_MS = 30_000;
const DEFAULTS: CircuitBreakerOptions = { failureThreshold: 3, cooldownMs: COOLDOWN_MS };

function breakerWith(overrides: Partial<CircuitBreakerOptions> = {}, clock = fakeClock()) {
  return new ConsecutiveFailuresCircuitBreaker({ ...DEFAULTS, ...overrides }, clock);
}

const providerDown = () => new Error('provider down');
const succeed = () => Promise.resolve('ok');
const fail = () => Promise.reject(providerDown());
const neverSettles = () => new Promise<string>(() => undefined);

async function failTimes(breaker: ConsecutiveFailuresCircuitBreaker, times: number): Promise<void> {
  for (let call = 0; call < times; call++) {
    await expect(breaker.execute(fail)).rejects.toThrow('provider down');
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function openedBreaker(overrides: Partial<CircuitBreakerOptions> = {}) {
  const clock = fakeClock();
  const breaker = breakerWith(overrides, clock);
  await failTimes(breaker, overrides.failureThreshold ?? DEFAULTS.failureThreshold);
  expect(breaker.state).toBe('OPEN');
  return { breaker, clock };
}

describe('ConsecutiveFailuresCircuitBreaker', () => {
  describe('contract', () => {
    it('starts CLOSED', () => {
      expect(breakerWith().state).toBe('CLOSED');
    });

    it('signals short-circuiting with a framework-free CircuitOpenError', () => {
      const error = new CircuitOpenError();

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe('CIRCUIT_OPEN');
      expect(error.name).toBe('CircuitOpenError');
    });

    it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects failureThreshold %s', (failureThreshold) => {
      expect(() => breakerWith({ failureThreshold })).toThrow(RangeError);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects cooldownMs %s', (cooldownMs) => {
      expect(() => breakerWith({ cooldownMs })).toThrow(RangeError);
    });

    it('accepts a threshold of 1 and a 1 ms cooldown', () => {
      expect(() => breakerWith({ failureThreshold: 1, cooldownMs: 1 })).not.toThrow();
    });
  });

  describe('CLOSED', () => {
    it('passes the operation result through', async () => {
      await expect(breakerWith().execute(succeed)).resolves.toBe('ok');
    });

    it('rethrows the identical operation error', async () => {
      const error = providerDown();

      await expect(breakerWith().execute(() => Promise.reject(error))).rejects.toBe(error);
    });

    it('treats an operation that throws synchronously as a failure', async () => {
      const breaker = breakerWith({ failureThreshold: 1 });

      await expect(
        breaker.execute(() => {
          throw providerDown();
        }),
      ).rejects.toThrow('provider down');
      expect(breaker.state).toBe('OPEN');
    });

    it('stays CLOSED after two consecutive failures and still invokes the third call', async () => {
      const breaker = breakerWith();
      await failTimes(breaker, 2);
      const operation = vi.fn(fail);

      expect(breaker.state).toBe('CLOSED');
      await expect(breaker.execute(operation)).rejects.toThrow('provider down');
      expect(operation).toHaveBeenCalledOnce();
    });

    it('opens on exactly the third consecutive failure', async () => {
      const breaker = breakerWith();

      await failTimes(breaker, 2);
      expect(breaker.state).toBe('CLOSED');
      await failTimes(breaker, 1);
      expect(breaker.state).toBe('OPEN');
    });

    it.each([1, 5])('honors a configured threshold of %i', async (failureThreshold) => {
      const breaker = breakerWith({ failureThreshold });

      await failTimes(breaker, failureThreshold - 1);
      expect(breaker.state).toBe('CLOSED');
      await failTimes(breaker, 1);
      expect(breaker.state).toBe('OPEN');
    });

    it('resets the consecutive count after a success', async () => {
      const breaker = breakerWith();

      await failTimes(breaker, 2);
      await breaker.execute(succeed);
      await failTimes(breaker, 2);
      expect(breaker.state).toBe('CLOSED');

      await failTimes(breaker, 1);
      expect(breaker.state).toBe('OPEN');
    });
  });

  describe('OPEN', () => {
    it('rejects with CircuitOpenError without invoking the operation', async () => {
      const { breaker } = await openedBreaker();
      const operation = vi.fn(succeed);

      await expect(breaker.execute(operation)).rejects.toBeInstanceOf(CircuitOpenError);
      expect(operation).not.toHaveBeenCalled();
    });

    it('fails fast even when the operation would never settle', async () => {
      const { breaker } = await openedBreaker();
      const operation = vi.fn(neverSettles);

      await expect(breaker.execute(operation)).rejects.toBeInstanceOf(CircuitOpenError);
      expect(operation).not.toHaveBeenCalled();
    });

    it('keeps rejecting until the cooldown has fully elapsed', async () => {
      const { breaker, clock } = await openedBreaker();
      const operation = vi.fn(succeed);

      clock.advance(COOLDOWN_MS - 1);

      await expect(breaker.execute(operation)).rejects.toBeInstanceOf(CircuitOpenError);
      expect(operation).not.toHaveBeenCalled();
      expect(breaker.state).toBe('OPEN');
    });

    it('reports OPEN after the cooldown until a call arrives (lazy transition)', async () => {
      const { breaker, clock } = await openedBreaker();

      clock.advance(COOLDOWN_MS * 10);

      expect(breaker.state).toBe('OPEN');
    });

    it('admits a HALF_OPEN probe once exactly the cooldown has elapsed', async () => {
      const { breaker, clock } = await openedBreaker();
      const probe = deferred<string>();
      const operation = vi.fn(() => probe.promise);

      clock.advance(COOLDOWN_MS);
      const result = breaker.execute(operation);

      expect(operation).toHaveBeenCalledOnce();
      expect(breaker.state).toBe('HALF_OPEN');
      probe.resolve('recovered');
      await expect(result).resolves.toBe('recovered');
    });
  });

  describe('HALF_OPEN', () => {
    it('closes after a successful probe and resets the failure count', async () => {
      const { breaker, clock } = await openedBreaker();
      clock.advance(COOLDOWN_MS);

      await breaker.execute(succeed);
      expect(breaker.state).toBe('CLOSED');

      await failTimes(breaker, 2);
      expect(breaker.state).toBe('CLOSED');
      await failTimes(breaker, 1);
      expect(breaker.state).toBe('OPEN');
    });

    it('reopens after a failed probe and restarts the cooldown', async () => {
      const { breaker, clock } = await openedBreaker();
      clock.advance(COOLDOWN_MS);

      await failTimes(breaker, 1);
      expect(breaker.state).toBe('OPEN');

      clock.advance(COOLDOWN_MS - 1);
      await expect(breaker.execute(succeed)).rejects.toBeInstanceOf(CircuitOpenError);

      clock.advance(1);
      await expect(breaker.execute(succeed)).resolves.toBe('ok');
      expect(breaker.state).toBe('CLOSED');
    });

    it('reopens after a single failed probe even with a higher threshold', async () => {
      const { breaker, clock } = await openedBreaker({ failureThreshold: 5 });
      clock.advance(COOLDOWN_MS);

      await failTimes(breaker, 1);

      expect(breaker.state).toBe('OPEN');
    });
  });

  describe('concurrency', () => {
    it('admits exactly one recovery probe when many calls arrive after the cooldown', async () => {
      const { breaker, clock } = await openedBreaker();
      const probe = deferred<string>();
      const operation = vi.fn(() => probe.promise);
      clock.advance(COOLDOWN_MS);

      const calls = Array.from({ length: 10 }, () => breaker.execute(operation));
      const [probeCall, ...rest] = calls;

      expect(operation).toHaveBeenCalledOnce();
      for (const call of rest) {
        await expect(call).rejects.toBeInstanceOf(CircuitOpenError);
      }
      probe.resolve('recovered');
      await expect(probeCall).resolves.toBe('recovered');
      expect(breaker.state).toBe('CLOSED');
    });

    it('keeps rejecting concurrent calls while a probe that will fail is in flight', async () => {
      const { breaker, clock } = await openedBreaker();
      const probe = deferred<string>();
      clock.advance(COOLDOWN_MS);

      const probeCall = breaker.execute(() => probe.promise);
      await expect(breaker.execute(succeed)).rejects.toBeInstanceOf(CircuitOpenError);
      probe.reject(providerDown());

      await expect(probeCall).rejects.toThrow('provider down');
      expect(breaker.state).toBe('OPEN');
    });

    it('ignores late failures from a burst so they cannot extend the cooldown', async () => {
      const changes: CircuitStateChange[] = [];
      const clock = fakeClock();
      const breaker = breakerWith({ onStateChange: (change) => changes.push(change) }, clock);
      const inFlight = Array.from({ length: 5 }, () => deferred<string>());
      const calls = inFlight.map((call) => breaker.execute(() => call.promise));

      for (const call of inFlight.slice(0, 3)) call.reject(providerDown());
      await Promise.allSettled(calls.slice(0, 3));
      expect(breaker.state).toBe('OPEN');

      clock.advance(10_000);
      for (const call of inFlight.slice(3)) call.reject(providerDown());
      await Promise.allSettled(calls.slice(3));

      clock.advance(COOLDOWN_MS - 10_000);
      await expect(breaker.execute(succeed)).resolves.toBe('ok');
      expect(changes).toEqual([
        { from: 'CLOSED', to: 'OPEN' },
        { from: 'OPEN', to: 'HALF_OPEN' },
        { from: 'HALF_OPEN', to: 'CLOSED' },
      ]);
    });

    it('does not let a late success close an OPEN circuit, but still returns it to its caller', async () => {
      const breaker = breakerWith();
      const inFlight = Array.from({ length: 4 }, () => deferred<string>());
      const calls = inFlight.map((call) => breaker.execute(() => call.promise));

      for (const call of inFlight.slice(0, 3)) call.reject(providerDown());
      await Promise.allSettled(calls.slice(0, 3));
      inFlight[3]?.resolve('late');

      await expect(calls[3]).resolves.toBe('late');
      expect(breaker.state).toBe('OPEN');
    });

    it.each([
      [
        'failure',
        (call: ReturnType<typeof deferred<string>>) => {
          call.reject(providerDown());
        },
      ],
      [
        'success',
        (call: ReturnType<typeof deferred<string>>) => {
          call.resolve('late');
        },
      ],
    ])('does not let a late %s settle a HALF_OPEN probe', async (_label, settleLate) => {
      const clock = fakeClock();
      const breaker = breakerWith({}, clock);
      const inFlight = Array.from({ length: 4 }, () => deferred<string>());
      const calls = inFlight.map((call) => breaker.execute(() => call.promise));
      for (const call of inFlight.slice(0, 3)) call.reject(providerDown());
      await Promise.allSettled(calls.slice(0, 3));

      clock.advance(COOLDOWN_MS);
      const probe = deferred<string>();
      const probeCall = breaker.execute(() => probe.promise);
      expect(breaker.state).toBe('HALF_OPEN');

      const late = inFlight[3];
      if (late) settleLate(late);
      await Promise.allSettled([calls[3]]);
      expect(breaker.state).toBe('HALF_OPEN');

      probe.resolve('recovered');
      await expect(probeCall).resolves.toBe('recovered');
      expect(breaker.state).toBe('CLOSED');
    });

    it('counts consecutive failures in completion order', async () => {
      const breaker = breakerWith();
      const inFlight = Array.from({ length: 4 }, () => deferred<string>());
      const calls = inFlight.map((call) => breaker.execute(() => call.promise));

      inFlight[0]?.reject(providerDown());
      inFlight[1]?.reject(providerDown());
      inFlight[3]?.resolve('ok');
      await Promise.allSettled([calls[0], calls[1], calls[3]]);
      inFlight[2]?.reject(providerDown());
      await Promise.allSettled([calls[2]]);

      expect(breaker.state).toBe('CLOSED');
      await failTimes(breaker, 1);
      expect(breaker.state).toBe('CLOSED');
      await failTimes(breaker, 1);
      expect(breaker.state).toBe('OPEN');
    });
  });

  describe('consecutiveFailures', () => {
    it('counts failures, holds the threshold while OPEN, and resets to 0 when the circuit closes', async () => {
      const clock = fakeClock();
      const breaker = breakerWith({}, clock);
      expect(breaker.consecutiveFailures).toBe(0);

      await failTimes(breaker, 1);
      expect(breaker.consecutiveFailures).toBe(1);
      await failTimes(breaker, 1);
      expect(breaker.consecutiveFailures).toBe(2);
      await failTimes(breaker, 1);
      expect(breaker.state).toBe('OPEN');
      expect(breaker.consecutiveFailures).toBe(3);

      await expect(breaker.execute(succeed)).rejects.toBeInstanceOf(CircuitOpenError);
      expect(breaker.consecutiveFailures).toBe(3);

      clock.advance(COOLDOWN_MS);
      await breaker.execute(succeed);
      expect(breaker.state).toBe('CLOSED');
      expect(breaker.consecutiveFailures).toBe(0);
    });

    it('resets to 0 after a success while CLOSED', async () => {
      const breaker = breakerWith();
      await failTimes(breaker, 2);

      await breaker.execute(succeed);

      expect(breaker.consecutiveFailures).toBe(0);
    });

    it('cannot be changed from outside', () => {
      const breaker = breakerWith();

      expect(() => {
        (breaker as { consecutiveFailures: number }).consecutiveFailures = 5;
      }).toThrow(TypeError);
      expect(breaker.consecutiveFailures).toBe(0);
    });

    it('still holds the threshold after a failed probe reopens the circuit', async () => {
      const { breaker, clock } = await openedBreaker();
      clock.advance(COOLDOWN_MS);

      await failTimes(breaker, 1);

      expect(breaker.state).toBe('OPEN');
      expect(breaker.consecutiveFailures).toBe(3);
    });
  });

  describe('error classification', () => {
    class CallerCancelled extends Error {}
    const ignoreCancellation = (error: unknown) => (error instanceof CallerCancelled ? 'ignore' : 'failure');
    const cancelled = () => Promise.reject(new CallerCancelled('caller left'));

    it('neither counts nor resets on an ignored error in CLOSED, and rethrows it unchanged', async () => {
      const breaker = breakerWith({ classifyError: ignoreCancellation });

      await failTimes(breaker, 2);
      await expect(breaker.execute(cancelled)).rejects.toBeInstanceOf(CallerCancelled);
      expect(breaker.state).toBe('CLOSED');

      await failTimes(breaker, 1);
      expect(breaker.state).toBe('OPEN');
    });

    it('frees the probe slot when the probe is ignored, so the next call probes', async () => {
      const clock = fakeClock();
      const breaker = breakerWith({ classifyError: ignoreCancellation }, clock);
      await failTimes(breaker, 3);
      clock.advance(COOLDOWN_MS);

      await expect(breaker.execute(cancelled)).rejects.toBeInstanceOf(CallerCancelled);
      expect(breaker.state).toBe('HALF_OPEN');

      const operation = vi.fn(succeed);
      await expect(breaker.execute(operation)).resolves.toBe('ok');
      expect(operation).toHaveBeenCalledOnce();
      expect(breaker.state).toBe('CLOSED');
    });

    it('treats an error as a failure when the classifier itself throws', async () => {
      const breaker = breakerWith({
        failureThreshold: 1,
        classifyError: () => {
          throw new Error('classifier bug');
        },
      });

      await expect(breaker.execute(fail)).rejects.toThrow('provider down');
      expect(breaker.state).toBe('OPEN');
    });
  });

  describe('listener isolation', () => {
    it('keeps a consistent state and the original error when the listener throws', async () => {
      const clock = fakeClock();
      const breaker = breakerWith(
        {
          onStateChange: () => {
            throw new Error('listener bug');
          },
        },
        clock,
      );

      await failTimes(breaker, 3);
      expect(breaker.state).toBe('OPEN');
      await expect(breaker.execute(succeed)).rejects.toBeInstanceOf(CircuitOpenError);

      clock.advance(COOLDOWN_MS);
      await expect(breaker.execute(succeed)).resolves.toBe('ok');
      expect(breaker.state).toBe('CLOSED');
    });
  });

  describe('state change notifications', () => {
    it('reports every transition in order', async () => {
      const changes: CircuitStateChange[] = [];
      const clock = fakeClock();
      const breaker = breakerWith({ onStateChange: (change) => changes.push(change) }, clock);

      await failTimes(breaker, 3);
      clock.advance(COOLDOWN_MS);
      await failTimes(breaker, 1);
      clock.advance(COOLDOWN_MS);
      await breaker.execute(succeed);

      expect(changes).toEqual([
        { from: 'CLOSED', to: 'OPEN' },
        { from: 'OPEN', to: 'HALF_OPEN' },
        { from: 'HALF_OPEN', to: 'OPEN' },
        { from: 'OPEN', to: 'HALF_OPEN' },
        { from: 'HALF_OPEN', to: 'CLOSED' },
      ]);
    });
  });
});
