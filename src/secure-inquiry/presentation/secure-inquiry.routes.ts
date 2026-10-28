import express, { Router, type RequestHandler } from 'express';
import { clientDisconnectSignal } from '../../shared/http/client-disconnect.js';
import type { ErrorMappings } from '../../shared/http/error-handler.js';
import { requireJson } from '../../shared/http/require-json.js';
import { validateBody } from '../../shared/http/validate-body.js';
import type { ProcessSecureInquiry } from '../application/process-secure-inquiry.js';
import { presentInquiryResult, type SecureInquiryResponse } from './secure-inquiry.presenter.js';
import { secureInquiryRequestSchema, type SecureInquiryRequest } from './secure-inquiry.schema.js';

export interface SecureInquiryRouterDependencies {
  readonly processSecureInquiry: Pick<ProcessSecureInquiry, 'execute'>;
  readonly bodyLimitBytes: number;
}

export const secureInquiryErrorMappings: ErrorMappings = {
  AUDIT_UNAVAILABLE: { status: 500, message: 'The inquiry could not be recorded' },
  AI_REQUEST_CANCELLED: { status: 499, message: 'Request cancelled' },
};

export function createSecureInquiryRouter({
  processSecureInquiry,
  bodyLimitBytes,
}: SecureInquiryRouterDependencies): Router {
  // Thin controller: parse, delegate, present. Every decision lives in the use case.
  const handleInquiry: RequestHandler<Record<string, string>, SecureInquiryResponse, SecureInquiryRequest> = async (
    req,
    res,
  ) => {
    const result = await processSecureInquiry.execute(req.body, { signal: clientDisconnectSignal(res) });
    res.status(200).json(presentInquiryResult(result, res.locals.requestId));
  };

  const router = Router();
  router.post(
    '/secure-inquiry',
    requireJson,
    express.json({ limit: bodyLimitBytes }),
    validateBody(secureInquiryRequestSchema),
    handleInquiry,
  );
  return router;
}
