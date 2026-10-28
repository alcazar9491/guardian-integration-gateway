import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { InquiryResult } from '../src/secure-inquiry/application/inquiry-result.js';
import type { SecureInquiryCommand } from '../src/secure-inquiry/application/process-secure-inquiry.js';
import type { RedactedText } from '../src/secure-inquiry/domain/redacted-text.js';
import { createLogger } from '../src/shared/logging/logger.js';

const SSN = '123-45-6789';
const EMAIL = 'john.doe@example.com';

function buildAppWithCapturedLogs() {
  const lines: string[] = [];
  const execute = vi.fn<(command: SecureInquiryCommand) => Promise<InquiryResult>>().mockResolvedValue({
    inquiryId: 'inq-1',
    source: 'AI_PROVIDER',
    sanitizedMessage: 'Contact <REDACTED: EMAIL>' as RedactedText,
    reply: 'ok',
  });
  const app = createApp({
    logger: createLogger({ level: 'trace', destination: { write: (line: string) => lines.push(line) } }),
    processSecureInquiry: { execute },
    bodyLimitBytes: 16 * 1024,
  });
  return { app, logs: () => lines.join('') };
}

describe('logging hygiene', () => {
  it('never logs the payload of a malformed JSON body', async () => {
    const { app, logs } = buildAppWithCapturedLogs();

    await request(app)
      .post('/secure-inquiry')
      .set('Content-Type', 'application/json')
      .send(`{"userId":"u","message":"my ssn is ${SSN}"`);

    expect(logs()).toContain('MALFORMED_JSON');
    expect(logs()).not.toContain(SSN);
  });

  it('never logs a valid request body', async () => {
    const { app, logs } = buildAppWithCapturedLogs();

    await request(app).post('/secure-inquiry').send({ userId: 'user-123', message: `Email ${EMAIL}` });

    expect(logs()).toContain('"path":"/secure-inquiry"');
    expect(logs()).toContain('"statusCode":200');
    expect(logs()).not.toContain(EMAIL);
  });

  it('never logs query strings', async () => {
    const { app, logs } = buildAppWithCapturedLogs();

    await request(app).post(`/secure-inquiry?email=${EMAIL}`).send({ userId: 'user-123', message: 'hello' });

    expect(logs()).not.toContain(EMAIL);
  });

  it('never logs the payload of a rejected oversized body', async () => {
    const { app, logs } = buildAppWithCapturedLogs();

    await request(app)
      .post('/secure-inquiry')
      .send({ userId: 'user-123', message: `${SSN} ${'a'.repeat(20 * 1024)}` });

    expect(logs()).toContain('PAYLOAD_TOO_LARGE');
    expect(logs()).not.toContain(SSN);
  });
});
