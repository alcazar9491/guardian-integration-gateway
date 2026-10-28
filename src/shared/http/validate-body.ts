import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { RequestValidationError, type ValidationIssue } from './http-errors.js';

function toValidationIssue(issue: z.core.$ZodIssue): ValidationIssue {
  return {
    path: issue.path.length > 0 ? issue.path.map(String).join('.') : '(body)',
    issue: issue.message,
  };
}

/** Replaces `req.body` with the parsed value so handlers only ever see validated input. */
export function validateBody<TBody>(schema: z.ZodType<TBody>): RequestHandler<Record<string, string>, unknown, TBody> {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new RequestValidationError(result.error.issues.map(toValidationIssue)));
      return;
    }
    req.body = result.data;
    next();
  };
}
