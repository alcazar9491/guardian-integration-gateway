import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  AiProviderUnavailableError,
  AiRequestCancelledError,
} from '../../../../src/secure-inquiry/application/errors.js';
import type { RedactedText } from '../../../../src/secure-inquiry/domain/redacted-text.js';
import { createPiiSanitizer } from '../../../../src/secure-inquiry/domain/sanitization/pii-sanitizer.js';
import type { Delay } from '../../../../src/secure-inquiry/infrastructure/ai-provider/abortable-delay.js';
import { MockAiProvider } from '../../../../src/secure-inquiry/infrastructure/ai-provider/mock-ai-provider.js';
import {
  alwaysFail,
  alwaysSucceed,
  failFirst,
  scripted,
  type OutcomeSchedule,
} from '../../../../src/secure-inquiry/infrastructure/ai-provider/outcome-schedule.js';

const prompt = (text: string) => text as RedactedText;
const PROMPT = prompt('Contact me at <REDACTED: EMAIL>');

interface PendingDelay {
  readonly ms: number;
  readonly signal: AbortSignal | undefined;
  readonly resolve: () => void;
}

/** A delay the test resolves by hand. It honors abort like the real one unless told to ignore it. */
function controllableDelay({ honorAbort = true } = {}) {
  const pending: PendingDelay[] = [];
  const delay: Delay = (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      pending.push({ ms, signal, resolve });
      if (honorAbort) {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      }
    });
  return { delay, pending };
}

function providerWith(schedule: OutcomeSchedule, delay?: Delay, delayMs = 2000) {
  return new MockAiProvider(delay ? { delayMs, schedule, delay } : { delayMs, schedule });
}

function track(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

const flushPending = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settle(promise: Promise<string>): Promise<'success' | 'failure'> {
  try {
    await promise;
    return 'success';
  } catch (error) {
    expect(error).toBeInstanceOf(AiProviderUnavailableError);
    return 'failure';
  }
}

describe('MockAiProvider', () => {
  describe('success', () => {
    it('replies with a deterministic answer built from the sanitized prompt', async () => {
      const { delay, pending } = controllableDelay();
      const reply = providerWith(alwaysSucceed(), delay).reply(PROMPT);

      pending[0]?.resolve();

      await expect(reply).resolves.toBe('Generated Answer: Contact me at <REDACTED: EMAIL>');
    });

    it('waits for the configured delay', async () => {
      const { delay, pending } = controllableDelay();
      const reply = providerWith(alwaysSucceed(), delay, 2000).reply(PROMPT);

      expect(pending.map((call) => call.ms)).toEqual([2000]);
      pending[0]?.resolve();
      await reply;
    });

    it('stays pending until the delay elapses', async () => {
      const { delay, pending } = controllableDelay();
      const reply = providerWith(alwaysSucceed(), delay).reply(PROMPT);
      const state = track(reply);

      await flushPending();
      expect(state.settled).toBe(false);

      pending[0]?.resolve();
      await reply;
      expect(state.settled).toBe(true);
    });
  });

  describe('failure', () => {
    it('rejects with a typed PROVIDER_ERROR, but only after the simulated latency', async () => {
      const { delay, pending } = controllableDelay();
      const reply = providerWith(alwaysFail(), delay).reply(PROMPT);
      const state = track(reply);

      await flushPending();
      expect(state.settled).toBe(false);

      pending[0]?.resolve();
      const error: unknown = await reply.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiProviderUnavailableError);
      expect(error).toMatchObject({ reason: 'PROVIDER_ERROR', code: 'AI_PROVIDER_UNAVAILABLE' });
    });

    it('never puts the prompt in the error', async () => {
      const secretLooking = prompt('Generated from <REDACTED: SSN> and a unique marker 7f3c');
      const error: unknown = await providerWith(alwaysFail(), undefined, 0)
        .reply(secretLooking)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AiProviderUnavailableError);
      const { message, stack } = error as Error;
      expect(`${message}\n${stack ?? ''}`).not.toContain('7f3c');
    });
  });

  describe('deterministic failure injection', () => {
    it('fails three consecutive calls, then recovers', async () => {
      const provider = providerWith(failFirst(3), undefined, 0);

      const outcomes = [];
      for (let call = 0; call < 6; call++) {
        outcomes.push(await settle(provider.reply(PROMPT)));
      }

      expect(outcomes).toEqual(['failure', 'failure', 'failure', 'success', 'success', 'success']);
    });

    it('assigns outcomes in call order, even when concurrent calls complete in reverse', async () => {
      const { delay, pending } = controllableDelay();
      const provider = providerWith(failFirst(3), delay);

      const replies = Array.from({ length: 6 }, () => settle(provider.reply(PROMPT)));
      [...pending].reverse().forEach((call) => {
        call.resolve();
      });

      expect(await Promise.all(replies)).toEqual(['failure', 'failure', 'failure', 'success', 'success', 'success']);
    });

    it('follows an arbitrary script', async () => {
      const provider = providerWith(scripted(['failure', 'success', 'failure'], { then: 'failure' }), undefined, 0);

      const outcomes = [];
      for (let call = 0; call < 5; call++) {
        outcomes.push(await settle(provider.reply(PROMPT)));
      }

      expect(outcomes).toEqual(['failure', 'success', 'failure', 'failure', 'failure']);
    });
  });

  describe('cancellation', () => {
    it('rejects with AiRequestCancelledError when aborted during the delay, without waiting it out', async () => {
      const controller = new AbortController();
      const startedAt = performance.now();
      const reply = providerWith(alwaysSucceed(), undefined, 2000).reply(PROMPT, { signal: controller.signal });

      setTimeout(() => {
        controller.abort();
      }, 10);

      await expect(reply).rejects.toBeInstanceOf(AiRequestCancelledError);
      expect(performance.now() - startedAt).toBeLessThan(1000);
    });

    it('rejects immediately for an already aborted signal and consumes no outcome', async () => {
      const { delay, pending } = controllableDelay();
      const provider = providerWith(failFirst(1), delay);

      await expect(provider.reply(PROMPT, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
        AiRequestCancelledError,
      );
      expect(pending).toHaveLength(0);

      const next = provider.reply(PROMPT);
      pending[0]?.resolve();
      await expect(next).rejects.toBeInstanceOf(AiProviderUnavailableError);
    });

    it('consumes the outcome of a call aborted during the delay', async () => {
      const { delay, pending } = controllableDelay();
      const provider = providerWith(failFirst(1), delay);
      const controller = new AbortController();

      const cancelled = provider.reply(PROMPT, { signal: controller.signal });
      controller.abort();
      await expect(cancelled).rejects.toBeInstanceOf(AiRequestCancelledError);

      const next = provider.reply(PROMPT);
      pending[1]?.resolve();
      await expect(next).resolves.toContain('Generated Answer:');
    });

    it('reports cancellation even if the delay ignored the abort', async () => {
      const { delay, pending } = controllableDelay({ honorAbort: false });
      const controller = new AbortController();
      const reply = providerWith(alwaysSucceed(), delay).reply(PROMPT, { signal: controller.signal });

      controller.abort();
      pending[0]?.resolve();

      await expect(reply).rejects.toBeInstanceOf(AiRequestCancelledError);
    });

    it('does not report an abort as a provider failure', async () => {
      const reply = providerWith(alwaysFail(), undefined, 2000).reply(PROMPT, { signal: AbortSignal.timeout(10) });

      const error: unknown = await reply.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiRequestCancelledError);
      expect(error).not.toBeInstanceOf(AiProviderUnavailableError);
    });
  });

  describe('event loop', () => {
    it('runs concurrent calls in parallel without blocking the event loop', async () => {
      const provider = providerWith(alwaysSucceed(), undefined, 100);
      let immediateRanFirst = false;
      let firstReplyDone = false;

      const startedAt = performance.now();
      const replies = Array.from({ length: 5 }, () =>
        provider.reply(PROMPT).then((text) => {
          firstReplyDone = true;
          return text;
        }),
      );
      setImmediate(() => {
        immediateRanFirst = !firstReplyDone;
      });

      await Promise.all(replies);

      expect(immediateRanFirst).toBe(true);
      // Five sequential delays would need 500 ms; overlapping delays finish close to 100 ms.
      expect(performance.now() - startedAt).toBeLessThan(400);
    });
  });

  describe('sanitization guarantee', () => {
    it('only accepts RedactedText at compile time', () => {
      const provider = providerWith(alwaysSucceed(), undefined, 0);

      // @ts-expect-error Raw strings are not RedactedText: only the sanitizer can produce a prompt.
      const sendRaw = () => provider.reply('john.doe@example.com');

      expect(sendRaw).toBeTypeOf('function');
    });

    it('never sees the original PII when fed real sanitizer output', async () => {
      const original = 'Email john.doe@example.com, card 4111 1111 1111 1111, SSN 123-45-6789.';
      const { text } = createPiiSanitizer().sanitize(original);

      const reply = await providerWith(alwaysSucceed(), undefined, 0).reply(text);

      expect(reply).toBe(
        'Generated Answer: Email <REDACTED: EMAIL>, card <REDACTED: CREDIT_CARD>, SSN <REDACTED: SSN>.',
      );
      for (const value of ['john.doe@example.com', '4111 1111 1111 1111', '123-45-6789']) {
        expect(reply).not.toContain(value);
      }
    });
  });

  describe('construction', () => {
    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid delay (%s)', (delayMs) => {
      expect(() => new MockAiProvider({ delayMs, schedule: alwaysSucceed() })).toThrow(RangeError);
    });
  });
});
