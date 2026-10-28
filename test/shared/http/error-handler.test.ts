import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/shared/errors/app-error.js';
import { createErrorHandler } from '../../../src/shared/http/error-handler.js';
import { requestContext } from '../../../src/shared/http/request-context.js';
import { createLogger } from '../../../src/shared/logging/logger.js';

const SSN = '123-45-6789';
const EMAIL = 'jane.doe@example.com';

class UnmappedError extends AppError {
  override readonly code = 'UNMAPPED';
}

interface LogEntry {
  readonly msg: string;
  readonly code?: string;
  readonly error?: Record<string, unknown>;
}

async function logsAfterThrowing(thrown: unknown) {
  const lines: string[] = [];
  const app = express();
  app.use(requestContext(createLogger({ level: 'trace', destination: { write: (line: string) => lines.push(line) } })));
  app.get('/boom', () => {
    throw thrown;
  });
  app.use(createErrorHandler());

  const response = await request(app).get('/boom');

  const failure = lines.map((line) => JSON.parse(line) as LogEntry).find((entry) => entry.msg === 'Request failed');
  return { status: response.status, text: lines.join(''), failure };
}

describe('createErrorHandler: unexpected errors', () => {
  it('logs the error type and stack frames, never the message or the cause', async () => {
    const error = new Error(`lookup failed for ${SSN}`, { cause: new Error(`upstream rejected ${EMAIL}`) });

    const { status, text, failure } = await logsAfterThrowing(error);

    expect(status).toBe(500);
    expect(text).not.toContain(SSN);
    expect(text).not.toContain('lookup failed');
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain('upstream rejected');
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR', error: { type: 'Error' } });
    expect(failure?.error?.stack).toMatch(/^\s*at /);
    expect(Object.keys(failure?.error ?? {}).sort()).toStrictEqual(['stack', 'type']);
  });

  it('drops every message line, even one shaped like a stack frame', async () => {
    const { text, failure } = await logsAfterThrowing(new Error(`first line\n    at ${SSN}`));

    expect(text).not.toContain(SSN);
    expect(failure?.error?.stack).toMatch(/^\s*at /);
  });

  it('keeps a string code and the class name of an unmapped application error', async () => {
    const { text, failure } = await logsAfterThrowing(new UnmappedError(`order for ${EMAIL} failed`));

    expect(text).not.toContain(EMAIL);
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR', error: { type: 'UnmappedError', code: 'UNMAPPED' } });
  });

  it('omits a code that is not a string', async () => {
    const { failure } = await logsAfterThrowing(Object.assign(new Error(`timeout for ${SSN}`), { code: 42 }));

    expect(failure?.error).toMatchObject({ type: 'Error' });
    expect(failure?.error).not.toHaveProperty('code');
  });

  it('logs only the type of a thrown value that is not an Error', async () => {
    const { status, text, failure } = await logsAfterThrowing(`plain text with ${SSN}`);

    expect(status).toBe(500);
    expect(text).not.toContain(SSN);
    expect(failure?.error).toStrictEqual({ type: 'string' });
  });
});
