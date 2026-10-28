import type { PiiType } from '../pii-type.js';

export function redactionLabel(type: PiiType): string {
  return `<REDACTED: ${type}>`;
}
