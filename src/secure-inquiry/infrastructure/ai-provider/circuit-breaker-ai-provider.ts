import {
  CircuitOpenError,
  type CircuitBreaker,
  type ErrorClassification,
} from '../../../shared/resilience/circuit-breaker.js';
import { AiProviderUnavailableError, AiRequestCancelledError } from '../../application/errors.js';
import type { AiProvider, AiReplyOptions } from '../../application/ports/ai-provider.js';
import type { RedactedText } from '../../domain/redacted-text.js';

/** The caller giving up says nothing about the provider's health, so it never counts towards opening. */
export function classifyAiProviderError(error: unknown): ErrorClassification {
  return error instanceof AiRequestCancelledError ? 'ignore' : 'failure';
}

/** Decorator: adds circuit breaking to any AiProvider without changing its contract. */
export class CircuitBreakerAiProvider implements AiProvider {
  constructor(
    private readonly inner: AiProvider,
    private readonly breaker: CircuitBreaker,
  ) {}

  async reply(prompt: RedactedText, options?: AiReplyOptions): Promise<string> {
    try {
      return await this.breaker.execute(() => this.inner.reply(prompt, options));
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw new AiProviderUnavailableError('CIRCUIT_OPEN', { cause: error });
      }
      throw error;
    }
  }
}
