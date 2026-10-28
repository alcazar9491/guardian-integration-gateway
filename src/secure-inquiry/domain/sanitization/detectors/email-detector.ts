import { createRegexDetector } from '../regex-detector.js';

// Letters, combining marks and digits of any script, so internationalized addresses are matched whole.
const WORD_CHARS = String.raw`\p{L}\p{M}\p{N}`;
const LOCAL_CHAR = `[${WORD_CHARS}._%+-]`;
// Starting only at a token boundary keeps the scan linear and captures the whole local part, however long.
const LOCAL_PART = `(?<!${LOCAL_CHAR})${LOCAL_CHAR}+`;
const DOMAIN_LABEL = String.raw`[\p{L}\p{N}](?:[${WORD_CHARS}-]{0,61}[${WORD_CHARS}])?`;
const TOP_LEVEL_DOMAIN = String.raw`\p{L}[\p{L}\p{M}]{1,62}`;

const EMAIL = Object.freeze(new RegExp(String.raw`${LOCAL_PART}@(?:${DOMAIN_LABEL}\.){1,126}${TOP_LEVEL_DOMAIN}`, 'gu'));

export const emailDetector = createRegexDetector('EMAIL', [EMAIL]);
