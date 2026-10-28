import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import {
  AiProviderUnavailableError,
  AiRequestCancelledError,
} from '../../../../src/secure-inquiry/application/errors.js';
import type { AiProvider } from '../../../../src/secure-inquiry/application/ports/ai-provider.js';
import type { RedactedText } from '../../../../src/secure-inquiry/domain/redacted-text.js';
import type { Delay } from '../../../../src/secure-inquiry/infrastructure/ai-provider/abortable-delay.js';
import {
  CircuitBreakerAiProvider,
  classifyAiProviderError,
} from '../../../../src/secure-inquiry/infrastructure/ai-provider/circuit-breaker-ai-provider.js';
import { MockAiProvider } from '../../../../src/secure-inquiry/infrastructure/ai-provider/mock-ai-provider.js';
import {
  alwaysFail,
  failFirst,
  type OutcomeSchedule,
} from '../../../../src/secure-inquiry/infrastructure/ai-provider/outcome-schedule.js';
import { CircuitOpenError, type TimeSource } from '../../../../src/shared/resilience/circuit-breaker.js';
import { ConsecutiveFailuresCircuitBreaker } from '../../../../src/shared/resilience/consecutive-failures-circuit-breaker.js';

const PROMPT = 'Contact me at <REDACTED: EMAIL>' as RedactedText;
const COOLDOWN_MS = 30_000;

function fakeClock(): TimeSource & { advance(ms: number): void } {
  let current = 0;
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

function breakerFor(clock: TimeSource) {
  return new ConsecutiveFailuresCircuitBreaker(
    { failureThreshold: 3, cooldownMs: COOLDOWN_MS, classifyError: classifyAiProviderError },
    clock,
  );
}

/** The real mock provider configured with its 2 s latency; the spied delay records each wait without sleeping. */
function guardedMockProvider(schedule: OutcomeSchedule) {
  const clock = fakeClock();
  const delay = vi.fn<Delay>(() => Promise.resolve());
  const breaker = breakerFor(clock);
  const provider = new CircuitBreakerAiProvider(new MockAiProvider({ delayMs: 2000, schedule, delay }), breaker);
  return { provider, breaker, clock, delay };
}

function guardedStub(reply: AiProvider['reply']) {
  const inner = { reply: vi.fn(reply) };
  const breaker = breakerFor(fakeClock());
  return { provider: new CircuitBreakerAiProvider(inner, breaker), inner, breaker };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}

async function expectProviderFailure(promise: Promise<string>, reason: string): Promise<AiProviderUnavailableError> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(AiProviderUnavailableError);
  expect(error).toMatchObject({ reason });
  return error as AiProviderUnavailableError;
}

describe('CircuitBreakerAiProvider', () => {
  it('passes successful replies and the abort signal through', async () => {
    const { provider, inner } = guardedStub(() => Promise.resolve('answer'));
    const signal = new AbortController().signal;

    await expect(provider.reply(PROMPT, { signal })).resolves.toBe('answer');
    expect(inner.reply).toHaveBeenCalledWith(PROMPT, { signal });
  });

  it('opens after three failing calls and fails the next one fast without reaching the provider', async () => {
    const { provider, breaker, delay } = guardedMockProvider(failFirst(3));

    for (let call = 0; call < 3; call++) {
      await expectProviderFailure(provider.reply(PROMPT), 'PROVIDER_ERROR');
    }
    expect(breaker.state).toBe('OPEN');

    const started = performance.now();
    const error = await expectProviderFailure(provider.reply(PROMPT), 'CIRCUIT_OPEN');
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(50);
    expect(delay).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledWith(2000, undefined);
    expect(error.cause).toBeInstanceOf(CircuitOpenError);
  });

  it('recovers through a single probe once the cooldown has elapsed', async () => {
    const { provider, breaker, clock, delay } = guardedMockProvider(failFirst(3));
    for (let call = 0; call < 3; call++) {
      await expectProviderFailure(provider.reply(PROMPT), 'PROVIDER_ERROR');
    }

    clock.advance(COOLDOWN_MS);

    await expect(provider.reply(PROMPT)).resolves.toBe(`Generated Answer: ${PROMPT}`);
    expect(breaker.state).toBe('CLOSED');
    await expect(provider.reply(PROMPT)).resolves.toBe(`Generated Answer: ${PROMPT}`);
    expect(delay).toHaveBeenCalledTimes(5);
  });

  it('reopens when the recovery probe fails', async () => {
    const { provider, breaker, clock, delay } = guardedMockProvider(alwaysFail());
    for (let call = 0; call < 3; call++) {
      await expectProviderFailure(provider.reply(PROMPT), 'PROVIDER_ERROR');
    }

    clock.advance(COOLDOWN_MS);
    await expectProviderFailure(provider.reply(PROMPT), 'PROVIDER_ERROR');

    expect(breaker.state).toBe('OPEN');
    await expectProviderFailure(provider.reply(PROMPT), 'CIRCUIT_OPEN');
    expect(delay).toHaveBeenCalledTimes(4);
  });

  it('counts timeouts as provider failures', async () => {
    const { provider, breaker } = guardedStub(() => Promise.reject(new AiProviderUnavailableError('TIMEOUT')));

    for (let call = 0; call < 3; call++) {
      await expectProviderFailure(provider.reply(PROMPT), 'TIMEOUT');
    }

    expect(breaker.state).toBe('OPEN');
  });

  it('never counts cancellations, and rethrows them unchanged', async () => {
    const cancellation = new AiRequestCancelledError();
    const { provider, breaker, inner } = guardedStub(() => Promise.reject(cancellation));

    for (let call = 0; call < 5; call++) {
      await expect(provider.reply(PROMPT)).rejects.toBe(cancellation);
    }

    expect(breaker.state).toBe('CLOSED');
    expect(inner.reply).toHaveBeenCalledTimes(5);
  });

  it('rethrows unexpected inner errors unchanged', async () => {
    const bug = new TypeError('bug');
    const { provider } = guardedStub(() => Promise.reject(bug));

    await expect(provider.reply(PROMPT)).rejects.toBe(bug);
  });
});

describe('classifyAiProviderError', () => {
  it('ignores cancellations and counts everything else', () => {
    expect(classifyAiProviderError(new AiRequestCancelledError())).toBe('ignore');
    expect(classifyAiProviderError(new AiProviderUnavailableError('PROVIDER_ERROR'))).toBe('failure');
    expect(classifyAiProviderError(new AiProviderUnavailableError('TIMEOUT'))).toBe('failure');
    expect(classifyAiProviderError(new Error('bug'))).toBe('failure');
  });
});
