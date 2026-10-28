import { contiguousDigits, GROUP_SEPARATORS, groupedDigits } from '../numeric-token.js';
import { createRegexDetector } from '../regex-detector.js';

// No SSN validity rules (area 000/666/9xx, group 00): the assessment treats every
// standalone 9-digit identifier as sensitive.
export const ssnDetector = createRegexDetector('SSN', [
  contiguousDigits(9),
  ...GROUP_SEPARATORS.map((separator) => groupedDigits([3, 2, 4], separator)),
]);
