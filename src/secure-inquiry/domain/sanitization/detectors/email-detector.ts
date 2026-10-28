import { createRegexDetector } from '../regex-detector.js';

const LOCAL_CHAR = '[A-Za-z0-9._%+-]';
// Starting only at a token boundary keeps the scan linear and captures the whole local part.
const LOCAL_PART = `(?<!${LOCAL_CHAR})${LOCAL_CHAR}{1,64}`;
const DOMAIN_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const TOP_LEVEL_DOMAIN = '[A-Za-z]{2,63}';

const EMAIL = Object.freeze(new RegExp(String.raw`${LOCAL_PART}@(?:${DOMAIN_LABEL}\.){1,126}${TOP_LEVEL_DOMAIN}`, 'gu'));

export const emailDetector = createRegexDetector('EMAIL', [EMAIL]);
