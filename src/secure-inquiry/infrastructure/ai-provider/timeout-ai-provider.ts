import { AiProviderUnavailableError, AiRequestCancelledError } from '../../application/errors.js';
import type { AiProvider, AiReplyOptions } from '../../application/ports/ai-provider.js';
import type { RedactedText } from '../../domain/redacted-text.js';

export interface TimeoutAiProviderOptions {
  readonly timeoutMs: number;
}

/** Decorator: replies slower than `timeoutMs` fail with TIMEOUT, which the circuit breaker counts as a failure. */
export class TimeoutAiProvider implements AiProvider {
  private readonly timeoutMs: number;

  constructor(
    private readonly inner: AiProvider,
    options: TimeoutAiProviderOptions,
  ) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a finite, positive number');
    }
    this.timeoutMs = options.timeoutMs;
  }

  async reply(prompt: RedactedText, { signal: callerSignal }: AiReplyOptions = {}): Promise<string> {
    if (callerSignal?.aborted) {
      throw new AiRequestCancelledError();
    }

    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort();
    }, this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;

    try {
      // Racing as well as passing the signal: a provider that ignores its signal must still time out.
      return await settleOrAbort(this.inner.reply(prompt, { signal }), signal);
    } catch (error) {
      // The caller giving up wins over a simultaneous timeout: it must never count as a provider failure.
      if (callerSignal?.aborted) {
        throw error instanceof AiRequestCancelledError ? error : new AiRequestCancelledError({ cause: error });
      }
      if (timeout.signal.aborted) {
        throw new AiProviderUnavailableError('TIMEOUT', { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function settleOrAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
