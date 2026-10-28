import { describe, expect, it } from 'vitest';
import { applyRedactions } from '../../../../src/secure-inquiry/domain/sanitization/apply-redactions.js';

describe('applyRedactions', () => {
  it('returns the text unchanged when there is nothing to redact', () => {
    expect(applyRedactions('', [])).toBe('');
    expect(applyRedactions('  nothing \n here\t', [])).toBe('  nothing \n here\t');
  });

  it('replaces each span with its label and keeps everything else', () => {
    expect(applyRedactions('a 123 b', [{ type: 'SSN', start: 2, end: 5 }])).toBe('a <REDACTED: SSN> b');
  });

  it('replaces several spans in one pass', () => {
    const text = 'x@y.io and 4111111111111111.';

    expect(
      applyRedactions(text, [
        { type: 'EMAIL', start: 0, end: 6 },
        { type: 'CREDIT_CARD', start: 11, end: 27 },
      ]),
    ).toBe('<REDACTED: EMAIL> and <REDACTED: CREDIT_CARD>.');
  });

  it('handles spans at the very start, the very end, and covering everything', () => {
    expect(applyRedactions('123456789 end', [{ type: 'SSN', start: 0, end: 9 }])).toBe('<REDACTED: SSN> end');
    expect(applyRedactions('start 123456789', [{ type: 'SSN', start: 6, end: 15 }])).toBe('start <REDACTED: SSN>');
    expect(applyRedactions('123456789', [{ type: 'SSN', start: 0, end: 9 }])).toBe('<REDACTED: SSN>');
  });
});
