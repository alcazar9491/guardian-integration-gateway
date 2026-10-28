import { describe, expect, it } from 'vitest';
import { redactionLabel } from '../../../../src/secure-inquiry/domain/sanitization/redaction-label.js';

describe('redactionLabel', () => {
  it.each([
    ['EMAIL', '<REDACTED: EMAIL>'],
    ['CREDIT_CARD', '<REDACTED: CREDIT_CARD>'],
    ['SSN', '<REDACTED: SSN>'],
  ] as const)('formats %s as %s', (type, label) => {
    expect(redactionLabel(type)).toBe(label);
  });
});
