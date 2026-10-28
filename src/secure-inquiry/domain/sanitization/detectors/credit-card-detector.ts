import { contiguousDigits, GROUP_SEPARATORS, groupedDigits } from '../numeric-token.js';
import { createRegexDetector } from '../regex-detector.js';

const CARD_GROUPINGS: readonly (readonly number[])[] = [
  [4, 4, 4, 4], // 16 digits: Visa, Mastercard, Discover
  [4, 4, 4, 4, 3], // 19 digits
  [4, 6, 5], // 15 digits: American Express
  [4, 6, 4], // 14 digits: Diners Club
];

// No Luhn check by design: a mistyped card number is still sensitive, so over-redaction wins.
export const creditCardDetector = createRegexDetector('CREDIT_CARD', [
  contiguousDigits(13, 19),
  ...CARD_GROUPINGS.flatMap((grouping) => GROUP_SEPARATORS.map((separator) => groupedDigits(grouping, separator))),
]);
