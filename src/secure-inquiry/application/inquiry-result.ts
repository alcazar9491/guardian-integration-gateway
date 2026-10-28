import type { RedactedText } from '../domain/redacted-text.js';
import type { FallbackReason } from './errors.js';

interface InquiryResultBase {
  /** Identifier of the persisted audit record. */
  readonly inquiryId: string;
  readonly sanitizedMessage: RedactedText;
  readonly reply: string;
}

export type InquiryResult =
  | (InquiryResultBase & { readonly source: 'AI_PROVIDER' })
  | (InquiryResultBase & { readonly source: 'FALLBACK'; readonly reason: FallbackReason });
