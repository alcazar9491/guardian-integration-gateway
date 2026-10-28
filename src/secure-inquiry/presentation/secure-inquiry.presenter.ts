import type { FallbackReason } from '../application/errors.js';
import type { InquiryResult } from '../application/inquiry-result.js';

interface SecureInquiryResponseBase {
  readonly requestId: string;
  readonly inquiryId: string;
  readonly sanitizedMessage: string;
  readonly reply: string;
}

export type SecureInquiryResponse =
  | (SecureInquiryResponseBase & { readonly status: 'COMPLETED'; readonly source: 'AI_PROVIDER' })
  | (SecureInquiryResponseBase & {
      readonly status: 'DEGRADED';
      readonly source: 'FALLBACK';
      readonly reason: FallbackReason;
    });

export function presentInquiryResult(result: InquiryResult, requestId: string): SecureInquiryResponse {
  const base = {
    requestId,
    inquiryId: result.inquiryId,
    sanitizedMessage: result.sanitizedMessage,
    reply: result.reply,
  };

  return result.source === 'AI_PROVIDER'
    ? { ...base, status: 'COMPLETED', source: 'AI_PROVIDER' }
    : { ...base, status: 'DEGRADED', source: 'FALLBACK', reason: result.reason };
}
