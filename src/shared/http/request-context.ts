import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../logging/logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express exposes res.locals typing only through this global namespace.
  namespace Express {
    interface Locals {
      requestId: string;
      logger: Logger;
    }
  }
}

const TRUSTED_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = performance.now();
    const incomingId = req.get('x-request-id');
    const requestId = incomingId !== undefined && TRUSTED_REQUEST_ID.test(incomingId) ? incomingId : randomUUID();
    // Captured before routing; the query string is never logged because it may carry PII.
    const path = req.path;

    res.locals.requestId = requestId;
    res.locals.logger = logger.child({ requestId });
    res.setHeader('X-Request-Id', requestId);

    res.on('finish', () => {
      res.locals.logger.info(
        {
          method: req.method,
          path,
          statusCode: res.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'Request completed',
      );
    });

    next();
  };
}
