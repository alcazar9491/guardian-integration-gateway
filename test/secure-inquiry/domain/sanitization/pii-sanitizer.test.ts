import { describe, expect, it } from 'vitest';
import { creditCardDetector } from '../../../../src/secure-inquiry/domain/sanitization/detectors/credit-card-detector.js';
import { emailDetector } from '../../../../src/secure-inquiry/domain/sanitization/detectors/email-detector.js';
import { ssnDetector } from '../../../../src/secure-inquiry/domain/sanitization/detectors/ssn-detector.js';
import { InvalidSanitizerInputError } from '../../../../src/secure-inquiry/domain/sanitization/invalid-sanitizer-input-error.js';
import { createPiiSanitizer, PiiSanitizer } from '../../../../src/secure-inquiry/domain/sanitization/pii-sanitizer.js';

const sanitizer = createPiiSanitizer();

function sanitizeText(text: string): string {
  return sanitizer.sanitize(text).text;
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

const EMAIL = '<REDACTED: EMAIL>';
const CARD = '<REDACTED: CREDIT_CARD>';
const SSN = '<REDACTED: SSN>';

describe('PiiSanitizer', () => {
  describe('emails', () => {
    it.each([
      ['Contact john.doe+tag@mail.example.co.uk today', `Contact ${EMAIL} today`],
      ['Mail me: a@b.io.', `Mail me: ${EMAIL}.`],
      ['<john@example.com>', `<${EMAIL}>`],
      ['Schreib an müller.hans@example.com!', `Schreib an ${EMAIL}!`],
      ['josé@ejemplo.com', EMAIL],
      ['Bestellung an user@bücher.example', `Bestellung an ${EMAIL}`],
      [`long ${'x'.repeat(300)}@example.com`, `long ${EMAIL}`],
    ])('redacts %s', (input, expected) => {
      expect(sanitizeText(input)).toBe(expected);
    });

    it.each(['john@', '@example.com', 'john@example', 'john@@example.com', 'john@.com'])(
      'leaves the malformed address %s unchanged',
      (input) => {
        expect(sanitizeText(input)).toBe(input);
      },
    );
  });

  describe('credit cards', () => {
    it.each([
      '4111111111111111',
      '4111 1111 1111 1111',
      '4111-1111-1111-1111',
      '378282246310005',
      '3782 822463 10005',
      '3056 930902 5904',
      '4222222222222',
    ])('redacts %s', (input) => {
      expect(sanitizeText(input)).toBe(CARD);
    });

    it('keeps punctuation around a redacted card', () => {
      expect(sanitizeText('Card:4111111111111111.')).toBe(`Card:${CARD}.`);
    });

    it.each([
      '4111 1111 1111',
      '12345678901234567890',
      '4111 1111 1111 1111 2222',
      '4111-1111 1111-1111',
      'ID4111111111111111',
      '3.1415926535897932',
    ])('leaves %s unchanged', (input) => {
      expect(sanitizeText(input)).toBe(input);
    });
  });

  describe('SSNs and 9-digit identifiers', () => {
    it.each([
      ['123-45-6789', SSN],
      ['123 45 6789', SSN],
      ['123456789', SSN],
      ['(123456789)', `(${SSN})`],
      ['123-45-6789 2026', `${SSN} 2026`],
    ])('redacts %s', (input, expected) => {
      expect(sanitizeText(input)).toBe(expected);
    });

    it('redacts every identifier and counts them', () => {
      expect(sanitizer.sanitize('ids 123456789 and 987654321')).toStrictEqual({
        text: `ids ${SSN} and ${SSN}`,
        findings: { SSN: 2 },
      });
    });

    it.each([
      '12345678',
      '1234567890',
      'ID123456789',
      '123456789abc',
      '123-456-789',
      '12-345-6789',
      '123-45-67890',
      '123-45-6789-0000',
      '0.123456789',
      '123456789.50',
    ])('leaves %s unchanged', (input) => {
      expect(sanitizeText(input)).toBe(input);
    });
  });

  describe('overlapping matches', () => {
    it.each(['123456789@example.com', 'john@123456789.com', '4111111111111111@pay.example'])(
      'redacts %s once, as an email',
      (input) => {
        expect(sanitizer.sanitize(input)).toStrictEqual({ text: EMAIL, findings: { EMAIL: 1 } });
      },
    );

    it('never re-redacts its own labels', () => {
      const once = sanitizer.sanitize('Email a@b.com, SSN 123-45-6789');
      const twice = sanitizer.sanitize(once.text);

      expect(twice.text).toBe(once.text);
      expect(twice.findings).toStrictEqual({});
    });

    it('leaves label-like text typed by the user untouched', () => {
      expect(sanitizer.sanitize(`Already ${SSN} here`)).toStrictEqual({ text: `Already ${SSN} here`, findings: {} });
    });
  });

  describe('multiple PII types and occurrences', () => {
    it('redacts every type in one message', () => {
      expect(sanitizer.sanitize('Email a@b.com, card 4111 1111 1111 1111, SSN 123-45-6789.')).toStrictEqual({
        text: `Email ${EMAIL}, card ${CARD}, SSN ${SSN}.`,
        findings: { EMAIL: 1, CREDIT_CARD: 1, SSN: 1 },
      });
    });

    it('redacts repeated values independently', () => {
      expect(sanitizer.sanitize('a@x.com b@x.com a@x.com')).toStrictEqual({
        text: `${EMAIL} ${EMAIL} ${EMAIL}`,
        findings: { EMAIL: 3 },
      });
    });
  });

  describe('content preservation', () => {
    it.each(['', ' ', '   \t\n\r\n  '])('returns %j unchanged with no findings', (input) => {
      expect(sanitizer.sanitize(input)).toStrictEqual({ text: input, findings: {} });
    });

    it('returns text without PII exactly as received', () => {
      const input = 'Order #12 shipped on 2026-10-27 to Zürich — call +1 (555) 123-4567. Total: $1,234.56';

      expect(sanitizer.sanitize(input)).toStrictEqual({ text: input, findings: {} });
    });

    it('keeps whitespace, line breaks and emoji around redactions', () => {
      expect(sanitizeText('Hi 👋\n\tmail: a@b.io\r\n  ssn: 123-45-6789  ')).toBe(
        `Hi 👋\n\tmail: ${EMAIL}\r\n  ssn: ${SSN}  `,
      );
    });
  });

  describe('determinism and purity', () => {
    const messages = [
      'Email a@b.com, card 4111 1111 1111 1111, SSN 123-45-6789.',
      '123456789@example.com and 987654321',
      '4111111111111111 4222222222222222',
    ];

    it('gives the same result for the same input', () => {
      for (const message of messages) {
        expect(sanitizer.sanitize(message)).toStrictEqual(sanitizer.sanitize(message));
      }
    });

    it('does not depend on the order detectors are registered in', () => {
      const reversed = new PiiSanitizer([ssnDetector, creditCardDetector, emailDetector]);

      for (const message of messages) {
        expect(reversed.sanitize(message)).toStrictEqual(sanitizer.sanitize(message));
      }
    });

    it('returns frozen results that carry counts only', () => {
      const result = sanitizer.sanitize('a@b.com 123456789');

      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.findings)).toBe(true);
      expect(Object.keys(result).sort()).toStrictEqual(['findings', 'text']);
      expect(Object.values(result.findings).every((count) => typeof count === 'number')).toBe(true);
    });
  });

  describe('malformed input', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a number', 42],
      ['an object', {}],
      ['an array', ['123-45-6789']],
    ] as const)('rejects %s', (_description, input) => {
      expect(() => sanitizer.sanitize(input as unknown as string)).toThrow(InvalidSanitizerInputError);
    });

    it('never echoes the rejected input in the error', () => {
      const input = { toString: () => '123-45-6789' } as unknown as string;

      const error = thrownBy(() => sanitizer.sanitize(input));

      expect(error).toBeInstanceOf(InvalidSanitizerInputError);
      expect(error).toHaveProperty('code', 'INVALID_SANITIZER_INPUT');
      expect(error).toHaveProperty('message', 'Sanitizer input must be a string');
    });

    it('keeps control characters and redacts PII next to them', () => {
      expect(sanitizeText('a\u0000123-45-6789\u0007b')).toBe(`a\u0000${SSN}\u0007b`);
    });

    it('keeps lone surrogates without throwing', () => {
      expect(sanitizeText('\uD800 123456789 \uDC00')).toBe(`\uD800 ${SSN} \uDC00`);
    });
  });

  describe('documented limitations', () => {
    it.each([
      ['１２３４５６７８９', 'fullwidth digits'],
      ['١٢٣٤٥٦٧٨٩', 'Arabic-Indic digits'],
      ['123​45​6789', 'zero-width characters between digits'],
      ['john at example dot com', 'spelled-out email'],
      ['john%40example.com', 'URL-encoded email'],
      ['4111 1111 1111 1111 4222 2222 2222 2222', 'two grouped cards joined by a single space'],
    ])('does not detect %s (%s)', (input) => {
      expect(sanitizeText(input)).toBe(input);
    });
  });

  describe('adversarial input', () => {
    it('stays linear on large inputs designed to trigger backtracking', () => {
      const inputs = ['a'.repeat(100_000), '1'.repeat(100_000), '1 '.repeat(50_000), 'a@'.repeat(50_000), 'a.'.repeat(50_000)];

      const startedAt = performance.now();
      for (const input of inputs) {
        sanitizer.sanitize(input);
      }

      expect(performance.now() - startedAt).toBeLessThan(1000);
    });
  });
});
