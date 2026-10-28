import { describe, expect, it } from 'vitest';
import { AuditPersistenceError } from '../../../src/secure-inquiry/application/errors.js';
import { LoggingAuditFailureReporter } from '../../../src/secure-inquiry/infrastructure/logging-audit-failure-reporter.js';
import { createLogger } from '../../../src/shared/logging/logger.js';

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const logger = createLogger({
    level: 'trace',
    destination: {
      write: (line: string) => {
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  return { logger, lines, raw };
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe('LoggingAuditFailureReporter', () => {
  it('logs a missing outcome revision at error level with identifiers and error codes', () => {
    const { logger, lines } = capturingLogger();
    const reporter = new LoggingAuditFailureReporter(logger);

    reporter.outcomeNotRecorded({
      auditId: 'audit-1',
      outcome: 'COMPLETED',
      cause: new AuditPersistenceError({ cause: errno('ENOSPC', 'no space left') }),
    });

    expect(lines).toEqual([
      expect.objectContaining({
        level: 50,
        msg: 'Audit outcome could not be recorded',
        auditId: 'audit-1',
        outcome: 'COMPLETED',
        error: { name: 'AuditPersistenceError', code: 'AUDIT_UNAVAILABLE', rootCode: 'ENOSPC' },
      }),
    ]);
  });

  it('never logs error messages, which may quote paths or content', () => {
    const { logger, raw } = capturingLogger();
    const reporter = new LoggingAuditFailureReporter(logger);

    reporter.outcomeNotRecorded({
      auditId: 'audit-2',
      outcome: 'PROVIDER_FAILURE',
      cause: new Error('write failed for jane@example.com'),
    });

    expect(raw.join('')).not.toContain('jane@example.com');
    expect(raw.join('')).toContain('"name":"Error"');
  });

  it('tolerates causes that are not errors', () => {
    const { logger, lines } = capturingLogger();
    const reporter = new LoggingAuditFailureReporter(logger);

    reporter.outcomeNotRecorded({ auditId: 'audit-3', outcome: 'CANCELLED', cause: 'disk on fire' });

    expect(lines[0]).toMatchObject({ auditId: 'audit-3', error: {} });
    expect(JSON.stringify(lines[0])).not.toContain('disk on fire');
  });
});
