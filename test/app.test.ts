import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { AiRequestCancelledError, AuditPersistenceError } from '../src/secure-inquiry/application/errors.js';
import type { InquiryResult } from '../src/secure-inquiry/application/inquiry-result.js';
import type {
  SecureInquiryCommand,
  SecureInquiryOptions,
} from '../src/secure-inquiry/application/process-secure-inquiry.js';
import type { RedactedText } from '../src/secure-inquiry/domain/redacted-text.js';
import { createLogger } from '../src/shared/logging/logger.js';

type Execute = (command: SecureInquiryCommand, options?: SecureInquiryOptions) => Promise<InquiryResult>;

interface ErrorEnvelope {
  requestId: string;
  error: { code: string; message: string; details?: { path: string; issue: string }[] };
}

const errorBody = (response: { body: unknown }) => response.body as ErrorEnvelope;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sanitizedMessage = 'Contact me at <REDACTED: EMAIL>' as RedactedText;
const validBody = { userId: 'user-123', message: 'Contact me at john@example.com' };

function buildApp(execute = vi.fn<Execute>()) {
  const app = createApp({
    logger: createLogger({ level: 'silent' }),
    processSecureInquiry: { execute },
    bodyLimitBytes: 16 * 1024,
  });
  return { app, execute };
}

describe('GET /health', () => {
  it('reports the service as up and assigns a request id', async () => {
    const { app } = buildApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['x-request-id']).toMatch(UUID);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('echoes a well-formed incoming request id', async () => {
    const { app } = buildApp();

    const response = await request(app).get('/health').set('X-Request-Id', 'client-req_42.a');

    expect(response.headers['x-request-id']).toBe('client-req_42.a');
  });

  it.each([['contains spaces and markup <b>'], ['x'.repeat(129)]])(
    'replaces a malformed incoming request id (%#)',
    async (incoming) => {
      const { app } = buildApp();

      const response = await request(app).get('/health').set('X-Request-Id', incoming);

      expect(response.headers['x-request-id']).toMatch(UUID);
    },
  );
});

describe('POST /secure-inquiry', () => {
  it('passes the validated command to the use case and presents a completed result', async () => {
    const { app, execute } = buildApp();
    execute.mockResolvedValue({ inquiryId: 'inq-1', source: 'AI_PROVIDER', sanitizedMessage, reply: 'Happy to help.' });

    const response = await request(app)
      .post('/secure-inquiry')
      .send({ userId: '  user-123  ', message: validBody.message });

    expect(execute).toHaveBeenCalledWith(
      { userId: 'user-123', message: validBody.message },
      { signal: expect.any(AbortSignal) as unknown },
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      requestId: response.headers['x-request-id'],
      inquiryId: 'inq-1',
      status: 'COMPLETED',
      source: 'AI_PROVIDER',
      sanitizedMessage,
      reply: 'Happy to help.',
    });
  });

  it('presents a fallback result as degraded', async () => {
    const { app, execute } = buildApp();
    execute.mockResolvedValue({
      inquiryId: 'inq-2',
      source: 'FALLBACK',
      reason: 'CIRCUIT_OPEN',
      sanitizedMessage,
      reply: 'Temporarily unavailable.',
    });

    const response = await request(app).post('/secure-inquiry').send(validBody);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'DEGRADED', source: 'FALLBACK', reason: 'CIRCUIT_OPEN' });
  });

  it.each([
    ['missing fields', {}, ['userId', 'message']],
    ['missing message', { userId: 'user-123' }, ['message']],
    ['non-string userId', { userId: 42, message: 'hello' }, ['userId']],
    ['empty userId', { userId: '   ', message: 'hello' }, ['userId']],
    ['blank message', { userId: 'user-123', message: '   ' }, ['message']],
    ['message too long', { userId: 'user-123', message: 'a'.repeat(5001) }, ['message']],
    ['userId too long', { userId: 'u'.repeat(129), message: 'hello' }, ['userId']],
    ['unknown field', { ...validBody, role: 'admin' }, ['(body)']],
    ['array body', [validBody], ['(body)']],
  ])('rejects %s with 400 and never calls the use case', async (_label, body, paths) => {
    const { app, execute } = buildApp();

    const response = await request(app).post('/secure-inquiry').send(body);

    expect(response.status).toBe(400);
    expect(errorBody(response).error.code).toBe('VALIDATION_ERROR');
    expect(errorBody(response).error.details?.map((detail) => detail.path)).toEqual(
      expect.arrayContaining(paths),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON without echoing the payload', async () => {
    const { app, execute } = buildApp();

    const response = await request(app)
      .post('/secure-inquiry')
      .set('Content-Type', 'application/json')
      .send('{"userId":"u","message":"ssn 123-45-6789"');

    expect(response.status).toBe(400);
    expect(errorBody(response).error.code).toBe('MALFORMED_JSON');
    expect(response.text).not.toContain('123-45-6789');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects non-JSON content with 415', async () => {
    const { app, execute } = buildApp();

    const response = await request(app).post('/secure-inquiry').set('Content-Type', 'text/plain').send('hello');

    expect(response.status).toBe(415);
    expect(errorBody(response).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(execute).not.toHaveBeenCalled();
  });

  // RFC 8259 §8.1: JSON exchanged between systems is UTF-8. UTF-7 in particular can disguise content.
  it.each([['iso-8859-1'], ['utf-7'], ['UTF-7'], ['utf-16'], ['utf-32'], ['utf8']])(
    'rejects charset=%s with 415 before parsing and never calls the use case',
    async (charset) => {
      const { app, execute } = buildApp();

      const response = await request(app)
        .post('/secure-inquiry')
        .set('Content-Type', `application/json; charset=${charset}`)
        .send(JSON.stringify(validBody));

      expect(response.status).toBe(415);
      expect(errorBody(response).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([['utf-8'], ['UTF-8'], ['"utf-8"']])('accepts charset=%s', async (charset) => {
    const { app, execute } = buildApp();
    execute.mockResolvedValue({ inquiryId: 'inq-3', source: 'AI_PROVIDER', sanitizedMessage, reply: 'ok' });

    const response = await request(app)
      .post('/secure-inquiry')
      .set('Content-Type', `application/json; charset=${charset}`)
      .send(JSON.stringify(validBody));

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects an oversized body with 413', async () => {
    const { app, execute } = buildApp();

    const response = await request(app)
      .post('/secure-inquiry')
      .send({ userId: 'user-123', message: 'a'.repeat(20 * 1024) });

    expect(response.status).toBe(413);
    expect(errorBody(response).error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps a cancellation to 499 while the client is still connected', async () => {
    const { app, execute } = buildApp();
    execute.mockRejectedValue(new AiRequestCancelledError());

    const response = await request(app).post('/secure-inquiry').send(validBody);

    expect(response.status).toBe(499);
    expect(errorBody(response).error).toEqual({ code: 'AI_REQUEST_CANCELLED', message: 'Request cancelled' });
  });

  it('maps an audit persistence failure to 500 AUDIT_UNAVAILABLE', async () => {
    const { app, execute } = buildApp();
    execute.mockRejectedValue(new AuditPersistenceError());

    const response = await request(app).post('/secure-inquiry').send(validBody);

    expect(response.status).toBe(500);
    expect(errorBody(response).error.code).toBe('AUDIT_UNAVAILABLE');
  });

  it('hides unexpected error details behind a generic 500', async () => {
    const { app, execute } = buildApp();
    execute.mockRejectedValue(new Error('sensitive detail 123-45-6789'));

    const response = await request(app).post('/secure-inquiry').send(validBody);

    expect(response.status).toBe(500);
    expect(errorBody(response).error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    expect(response.text).not.toContain('sensitive detail');
  });

  it('includes the request id from the header in the error envelope', async () => {
    const { app } = buildApp();

    const response = await request(app).post('/secure-inquiry').set('X-Request-Id', 'trace-1').send({});

    expect(response.headers['x-request-id']).toBe('trace-1');
    expect(errorBody(response).requestId).toBe('trace-1');
  });
});

describe('client disconnects', () => {
  function postAndDisconnect(port: number): void {
    const body = JSON.stringify(validBody);
    const clientRequest = httpRequest({
      port,
      method: 'POST',
      path: '/secure-inquiry',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    clientRequest.on('error', () => undefined);
    clientRequest.end(body);
    // Give the server time to start handling, then hang up before any response.
    setTimeout(() => clientRequest.destroy(), 50);
  }

  it('aborts the use case signal when the client hangs up, without writing a response', async () => {
    let observedSignal: AbortSignal | undefined;
    const execute = vi.fn<Execute>((_command, options) => {
      observedSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new AiRequestCancelledError());
        });
      });
    });
    const lines: string[] = [];
    const app = createApp({
      logger: createLogger({ level: 'info', destination: { write: (line: string) => lines.push(line) } }),
      processSecureInquiry: { execute },
      bodyLimitBytes: 16 * 1024,
    });
    const server = app.listen(0);

    try {
      postAndDisconnect((server.address() as AddressInfo).port);
      await vi.waitFor(() => {
        expect(observedSignal?.aborted).toBe(true);
      });
      await vi.waitFor(() => {
        expect(lines.join('')).toContain('Client disconnected before the response was sent');
      });
      expect(lines.join('')).not.toContain('"level":50');
    } finally {
      server.close();
    }
  });

  it('does not abort the signal of a request that completed normally', async () => {
    const { app, execute } = buildApp();
    execute.mockResolvedValue({ inquiryId: 'inq-4', source: 'AI_PROVIDER', sanitizedMessage, reply: 'ok' });

    await request(app).post('/secure-inquiry').send(validBody);

    expect(execute.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });
});

describe('security headers', () => {
  const securityHeaders = {
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
  };

  it.each([
    ['a successful inquiry', 200, (app: Express) => request(app).post('/secure-inquiry').send(validBody)],
    ['a validation error', 400, (app: Express) => request(app).post('/secure-inquiry').send({})],
    [
      'an unsupported media type',
      415,
      (app: Express) => request(app).post('/secure-inquiry').set('Content-Type', 'text/plain').send('hello'),
    ],
    ['an unknown route', 404, (app: Express) => request(app).get('/does-not-exist')],
    ['the health check', 200, (app: Express) => request(app).get('/health')],
  ])('are set on %s', async (_label, status, send) => {
    const { app, execute } = buildApp();
    execute.mockResolvedValue({ inquiryId: 'inq-5', source: 'AI_PROVIDER', sanitizedMessage, reply: 'ok' });

    const response = await send(app);

    expect(response.status).toBe(status);
    expect(response.headers).toMatchObject(securityHeaders);
    // HSTS belongs to the TLS terminator in front of the service.
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('unknown routes', () => {
  it('returns 404 NOT_FOUND', async () => {
    const { app } = buildApp();

    const response = await request(app).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      requestId: response.headers['x-request-id'],
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  it('returns 404 for a body sent to an unknown route instead of parsing it', async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post('/does-not-exist')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(404);
  });
});
