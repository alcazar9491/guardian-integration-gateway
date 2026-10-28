import express, { type Express } from 'express';
import type { ProcessSecureInquiry } from './secure-inquiry/application/process-secure-inquiry.js';
import {
  createSecureInquiryRouter,
  secureInquiryErrorMappings,
} from './secure-inquiry/presentation/secure-inquiry.routes.js';
import { createErrorHandler } from './shared/http/error-handler.js';
import { createHealthRouter } from './shared/http/health.routes.js';
import { notFound } from './shared/http/not-found.js';
import { requestContext } from './shared/http/request-context.js';
import { securityHeaders } from './shared/http/security-headers.js';
import type { Logger } from './shared/logging/logger.js';

export interface AppDependencies {
  readonly logger: Logger;
  readonly processSecureInquiry: Pick<ProcessSecureInquiry, 'execute'>;
  readonly bodyLimitBytes: number;
}

export function createApp({ logger, processSecureInquiry, bodyLimitBytes }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  // First, so every response carries the headers: errors, 404s, and /health included.
  app.use(securityHeaders);
  app.use(requestContext(logger));
  app.use(createHealthRouter());
  // Bodies are parsed per route, after the media-type check, so unknown routes never parse anything.
  app.use(createSecureInquiryRouter({ processSecureInquiry, bodyLimitBytes }));
  app.use(notFound);
  app.use(createErrorHandler(secureInquiryErrorMappings));

  return app;
}
