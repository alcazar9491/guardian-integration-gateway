import type { PiiType } from '../pii-type.js';

/** A detected span as half-open UTF-16 offsets. It never carries the matched value. */
export interface PiiMatch {
  readonly type: PiiType;
  readonly start: number;
  readonly end: number;
}

export interface PiiDetector {
  readonly type: PiiType;
  detect(text: string): readonly PiiMatch[];
}
