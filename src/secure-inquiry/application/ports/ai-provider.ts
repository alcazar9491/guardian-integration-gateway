import type { RedactedText } from '../../domain/redacted-text.js';

export interface AiReplyOptions {
  /** Aborting means the caller gave up; providers reject with AiRequestCancelledError. */
  readonly signal?: AbortSignal;
}

export interface AiProvider {
  /**
   * Accepts only sanitizer output. Rejects with AiProviderUnavailableError when no reply can be produced,
   * or AiRequestCancelledError when the caller aborts.
   */
  reply(prompt: RedactedText, options?: AiReplyOptions): Promise<string>;
}
