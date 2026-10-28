import type { Logger } from '../../shared/logging/logger.js';
import type { AuditFailureReporter, AuditOutcomeNotRecorded } from '../application/ports/audit-failure-reporter.js';

interface ErrorSummary {
  readonly name?: string;
  readonly code?: string;
  readonly rootCode?: string;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined;
  const property: unknown = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : undefined;
}

// Names and codes only: error messages can quote file paths or request content.
function summarize(cause: unknown): ErrorSummary {
  if (!(cause instanceof Error)) return {};
  const code = stringProperty(cause, 'code');
  const rootCode = stringProperty(cause.cause, 'code');
  return {
    name: cause.name,
    ...(code === undefined ? {} : { code }),
    ...(rootCode === undefined ? {} : { rootCode }),
  };
}

export class LoggingAuditFailureReporter implements AuditFailureReporter {
  constructor(private readonly logger: Logger) {}

  outcomeNotRecorded({ auditId, outcome, cause }: AuditOutcomeNotRecorded): void {
    this.logger.error({ auditId, outcome, error: summarize(cause) }, 'Audit outcome could not be recorded');
  }
}
