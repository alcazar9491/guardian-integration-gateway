import type { PiiType } from '../pii-type.js';
import type { PiiMatch } from './pii-detector.js';

const LABEL_PRIORITY: Readonly<Record<PiiType, number>> = Object.freeze({ EMAIL: 0, CREDIT_CARD: 1, SSN: 2 });

interface Cluster {
  readonly start: number;
  readonly end: number;
  readonly labelSource: PiiMatch;
}

/**
 * Precedence rule: candidates sharing at least one character merge (transitively) into one
 * redaction covering their union, so no fragment of a detected value survives. The merged
 * redaction takes the type of its longest candidate; equal lengths fall back to
 * EMAIL > CREDIT_CARD > SSN. The full sort key makes the result independent of input order.
 */
export function resolveOverlaps(candidates: readonly PiiMatch[]): readonly PiiMatch[] {
  const redactions: PiiMatch[] = [];
  let cluster: Cluster | undefined;

  for (const candidate of [...candidates].sort(byPosition)) {
    if (cluster !== undefined && candidate.start < cluster.end) {
      cluster = extend(cluster, candidate);
      continue;
    }
    if (cluster !== undefined) {
      redactions.push(toRedaction(cluster));
    }
    cluster = { start: candidate.start, end: candidate.end, labelSource: candidate };
  }

  if (cluster !== undefined) {
    redactions.push(toRedaction(cluster));
  }
  return Object.freeze(redactions);
}

function byPosition(a: PiiMatch, b: PiiMatch): number {
  return a.start - b.start || b.end - a.end || LABEL_PRIORITY[a.type] - LABEL_PRIORITY[b.type];
}

function extend(cluster: Cluster, candidate: PiiMatch): Cluster {
  return {
    start: cluster.start,
    end: Math.max(cluster.end, candidate.end),
    labelSource: outranks(candidate, cluster.labelSource) ? candidate : cluster.labelSource,
  };
}

function outranks(challenger: PiiMatch, incumbent: PiiMatch): boolean {
  const lengthDifference = lengthOf(challenger) - lengthOf(incumbent);
  if (lengthDifference !== 0) {
    return lengthDifference > 0;
  }
  return LABEL_PRIORITY[challenger.type] < LABEL_PRIORITY[incumbent.type];
}

function lengthOf(match: PiiMatch): number {
  return match.end - match.start;
}

function toRedaction(cluster: Cluster): PiiMatch {
  return Object.freeze({ type: cluster.labelSource.type, start: cluster.start, end: cluster.end });
}
