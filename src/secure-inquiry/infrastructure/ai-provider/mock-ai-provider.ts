import { AiProviderUnavailableError, AiRequestCancelledError } from '../../application/errors.js';
import type { AiProvider, AiReplyOptions } from '../../application/ports/ai-provider.js';
import type { RedactedText } from '../../domain/redacted-text.js';
import { abortableDelay, type Delay } from './abortable-delay.js';
import type { OutcomeSchedule } from './outcome-schedule.js';

export const MOCK_REPLY_PREFIX = 'Generated Answer: ';

export interface MockAiProviderOptions {
  /** Simulated network latency, applied to successes and failures alike. */
  readonly delayMs: number;
  readonly schedule: OutcomeSchedule;
  readonly delay?: Delay;
}

/** Stands in for an external AI service; failures come only from the injected schedule. */
export class MockAiProvider implements AiProvider {
  private readonly delayMs: number;
  private readonly schedule: OutcomeSchedule;
  private readonly delay: Delay;

  constructor(options: MockAiProviderOptions) {
    if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
      throw new RangeError('delayMs must be a finite, non-negative number');
    }
    this.delayMs = options.delayMs;
    this.schedule = options.schedule;
    this.delay = options.delay ?? abortableDelay;
  }

  async reply(prompt: RedactedText, { signal }: AiReplyOptions = {}): Promise<string> {
    if (signal?.aborted) {
      throw new AiRequestCancelledError();
    }

    // Taken when the call is made, not when it completes: concurrent calls fail in call order.
    const outcome = this.schedule.next();

    try {
      await this.delay(this.delayMs, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw new AiRequestCancelledError({ cause: error });
      }
      throw error;
    }

    if (signal?.aborted) {
      throw new AiRequestCancelledError();
    }
    if (outcome === 'failure') {
      throw new AiProviderUnavailableError('PROVIDER_ERROR');
    }
    return `${MOCK_REPLY_PREFIX}${prompt}`;
  }
}
