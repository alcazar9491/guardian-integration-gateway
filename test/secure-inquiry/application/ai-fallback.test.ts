import { describe, expect, it } from 'vitest';
import { resolveFallback, SERVICE_BUSY_REPLY } from '../../../src/secure-inquiry/application/ai-fallback.js';
import {
  AiProviderUnavailableError,
  AiRequestCancelledError,
  type AiProviderFailureReason,
} from '../../../src/secure-inquiry/application/errors.js';

describe('resolveFallback', () => {
  it('replies exactly "Service Busy"', () => {
    expect(SERVICE_BUSY_REPLY).toBe('Service Busy');
  });

  it.each<AiProviderFailureReason>(['CIRCUIT_OPEN', 'PROVIDER_ERROR', 'TIMEOUT'])(
    'maps a %s provider failure to the Service Busy fallback',
    (reason) => {
      expect(resolveFallback(new AiProviderUnavailableError(reason))).toEqual({ reason, reply: SERVICE_BUSY_REPLY });
    },
  );

  it('returns a frozen fallback', () => {
    expect(Object.isFrozen(resolveFallback(new AiProviderUnavailableError('CIRCUIT_OPEN')))).toBe(true);
  });

  it.each([
    ['a cancelled request', new AiRequestCancelledError()],
    ['an unexpected error', new Error('bug')],
    ['a non-error value', 'boom'],
    ['undefined', undefined],
  ])('has no fallback for %s, so the use case rethrows it', (_label, error) => {
    expect(resolveFallback(error)).toBeUndefined();
  });
});
