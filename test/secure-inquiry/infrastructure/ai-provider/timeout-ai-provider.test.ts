import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiProviderUnavailableError,
  AiRequestCancelledError,
} from '../../../../src/secure-inquiry/application/errors.js';
import type { AiProvider, AiReplyOptions } from '../../../../src/secure-inquiry/application/ports/ai-provider.js';
import type { RedactedText } from '../../../../src/secure-inquiry/domain/redacted-text.js';
import { MockAiProvider } from '../../../../src/secure-inquiry/infrastructure/ai-provider/mock-ai-provider.js';
import { alwaysSucceed } from '../../../../src/secure-inquiry/infrastructure/ai-provider/outcome-schedule.js';
import { TimeoutAiProvider } from '../../../../src/secure-inquiry/infrastructure/ai-provider/timeout-ai-provider.js';

const PROMPT = 'Contact me at <REDACTED: EMAIL>' as RedactedText;

/** An inner provider that records what it receives and settles only when the test says so. */
function manualProvider() {
  const calls: { prompt: RedactedText; signal: AbortSignal | undefined }[] = [];
  let settle: { resolve: (text: string) => void; reject: (error: unknown) => void } | undefined;
  const provider: AiProvider = {
    reply: (prompt: RedactedText, options?: AiReplyOptions) => {
      calls.push({ prompt, signal: options?.signal });
      return new Promise<string>((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
  };
  return {
    provider,
    calls,
    resolve: (text: string) => settle?.resolve(text),
    reject: (error: unknown) => settle?.reject(error),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TimeoutAiProvider', () => {
  it('passes the prompt through unchanged and returns the inner reply', async () => {
    const inner = manualProvider();
    const reply = new TimeoutAiProvider(inner.provider, { timeoutMs: 1000 }).reply(PROMPT);

    inner.resolve('Generated Answer: ok');

    await expect(reply).resolves.toBe('Generated Answer: ok');
    expect(inner.calls.map((call) => call.prompt)).toEqual([PROMPT]);
  });

  it('times out a slow provider with a typed TIMEOUT error', async () => {
    const slow = new MockAiProvider({ delayMs: 500, schedule: alwaysSucceed() });
    const startedAt = performance.now();

    const error: unknown = await new TimeoutAiProvider(slow, { timeoutMs: 20 })
      .reply(PROMPT)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiProviderUnavailableError);
    expect(error).toMatchObject({ reason: 'TIMEOUT' });
    expect(performance.now() - startedAt).toBeLessThan(300);
  });

  it('times out a provider that ignores the abort signal', async () => {
    vi.useFakeTimers();
    const inner = manualProvider();
    const reply = new TimeoutAiProvider(inner.provider, { timeoutMs: 50 }).reply(PROMPT);
    const outcome = reply.catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(50);

    expect(await outcome).toMatchObject({ reason: 'TIMEOUT' });
    inner.resolve('too late');
  });

  it('aborts the signal handed to the inner provider when the timeout fires', async () => {
    vi.useFakeTimers();
    const inner = manualProvider();
    const outcome = new TimeoutAiProvider(inner.provider, { timeoutMs: 50 })
      .reply(PROMPT)
      .catch((caught: unknown) => caught);

    expect(inner.calls[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(50);

    expect(inner.calls[0]?.signal?.aborted).toBe(true);
    await outcome;
  });

  it('reports a caller abort as cancellation, not as a timeout', async () => {
    const inner = manualProvider();
    const controller = new AbortController();
    const reply = new TimeoutAiProvider(inner.provider, { timeoutMs: 5000 }).reply(PROMPT, {
      signal: controller.signal,
    });

    controller.abort();

    const error: unknown = await reply.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiRequestCancelledError);
    expect(inner.calls[0]?.signal?.aborted).toBe(true);
  });

  it('rejects an already aborted caller signal without calling the inner provider', async () => {
    const inner = manualProvider();

    await expect(
      new TimeoutAiProvider(inner.provider, { timeoutMs: 1000 }).reply(PROMPT, { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(AiRequestCancelledError);
    expect(inner.calls).toHaveLength(0);
  });

  it('passes inner provider failures through unchanged', async () => {
    const inner = manualProvider();
    const failure = new AiProviderUnavailableError('PROVIDER_ERROR');
    const reply = new TimeoutAiProvider(inner.provider, { timeoutMs: 1000 }).reply(PROMPT);

    inner.reject(failure);

    await expect(reply).rejects.toBe(failure);
  });

  it('leaves no timer behind once the reply settles', async () => {
    vi.useFakeTimers();
    const inner = manualProvider();
    const reply = new TimeoutAiProvider(inner.provider, { timeoutMs: 1000 }).reply(PROMPT);

    expect(vi.getTimerCount()).toBe(1);
    inner.resolve('done');
    await reply;

    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid timeout (%s)', (timeoutMs) => {
    expect(() => new TimeoutAiProvider(manualProvider().provider, { timeoutMs })).toThrow(RangeError);
  });
});
