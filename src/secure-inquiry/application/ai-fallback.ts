import { AiProviderUnavailableError, type AiProviderFailureReason } from './errors.js';

/** The single source of the degraded reply text. HTTP formatting stays in the presenter. */
export const SERVICE_BUSY_REPLY = 'Service Busy';

export interface AiFallback {
  readonly reason: AiProviderFailureReason;
  readonly reply: string;
}

/**
 * Maps a provider failure to the fallback the use case returns instead of an error.
 * Anything else (cancellation, bugs) has no fallback and must be rethrown.
 */
export function resolveFallback(error: unknown): AiFallback | undefined {
  if (!(error instanceof AiProviderUnavailableError)) {
    return undefined;
  }
  return Object.freeze({ reason: error.reason, reply: SERVICE_BUSY_REPLY });
}
