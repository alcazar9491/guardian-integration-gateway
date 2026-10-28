import { describe, expect, it } from 'vitest';
import type { InquiryResult } from '../../../src/secure-inquiry/application/inquiry-result.js';
import type { RedactedText } from '../../../src/secure-inquiry/domain/redacted-text.js';
import { presentInquiryResult } from '../../../src/secure-inquiry/presentation/secure-inquiry.presenter.js';

const AUDIT_INTERNALS = {
  encryptedMessage: { algorithm: 'aes-256-gcm', iv: 'iv-value', authTag: 'tag-value', ciphertext: 'cipher-value' },
  userRef: 'user-ref-value',
  userId: 'jane@example.com',
  originalMessage: 'Email jane@example.com',
  revision: 1,
};
const FORBIDDEN = ['iv-value', 'tag-value', 'cipher-value', 'user-ref-value', 'jane@example.com', 'encryptedMessage'];

/** Simulates a result object that accidentally carries audit internals at runtime. */
function polluted(result: InquiryResult): InquiryResult {
  return { ...result, ...AUDIT_INTERNALS };
}

const sanitizedMessage = 'Email <REDACTED: EMAIL>' as RedactedText;

describe('presentInquiryResult', () => {
  it('exposes only the response contract for a provider reply', () => {
    const response = presentInquiryResult(
      polluted({ inquiryId: 'inq-1', source: 'AI_PROVIDER', sanitizedMessage, reply: 'Generated Answer: hi' }),
      'req-1',
    );

    expect(Object.keys(response).sort()).toEqual(
      ['inquiryId', 'reply', 'requestId', 'sanitizedMessage', 'source', 'status'].sort(),
    );
    for (const value of FORBIDDEN) expect(JSON.stringify(response)).not.toContain(value);
  });

  it('exposes only the response contract for a fallback', () => {
    const response = presentInquiryResult(
      polluted({ inquiryId: 'inq-2', source: 'FALLBACK', reason: 'CIRCUIT_OPEN', sanitizedMessage, reply: 'Service Busy' }),
      'req-2',
    );

    expect(Object.keys(response).sort()).toEqual(
      ['inquiryId', 'reason', 'reply', 'requestId', 'sanitizedMessage', 'source', 'status'].sort(),
    );
    for (const value of FORBIDDEN) expect(JSON.stringify(response)).not.toContain(value);
  });
});
