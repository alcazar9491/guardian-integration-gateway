import type { ErrorRequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';
import { RequestValidationError, type ValidationIssue } from './http-errors.js';

export interface ErrorMapping {
  readonly status: number;
  /** Public message. When omitted, the error's own message is used, so set it for every 5xx. */
  readonly message?: string;
}

export type ErrorMappings = Readonly<Record<string, ErrorMapping>>;

interface ErrorResponse {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: readonly ValidationIssue[];
}

interface BodyParserError {
  readonly type: string;
  readonly status: number;
}

const SHARED_MAPPINGS: ErrorMappings = {
  VALIDATION_ERROR: { status: 400 },
  UNSUPPORTED_MEDIA_TYPE: { status: 415 },
};

const INTERNAL_ERROR: ErrorResponse = { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };

interface UnexpectedErrorSummary {
  readonly type: string;
  readonly code?: string;
  readonly stack?: string;
}

const STACK_FRAME = /^\s+at /;

function stackFrames(error: Error): string | undefined {
  if (typeof error.stack !== 'string') return undefined;
  // V8 opens the stack with "Name: message", and the message may span lines that look like frames.
  const header = Error.prototype.toString.call(error);
  const trace = error.stack.startsWith(header) ? error.stack.slice(header.length) : error.stack;
  const frames = trace.split('\n').filter((line) => STACK_FRAME.test(line));
  return frames.length === 0 ? undefined : frames.join('\n');
}

// An unexpected error's message and cause chain can quote anything, including request PII.
function summarizeUnexpectedError(error: unknown): UnexpectedErrorSummary {
  if (!(error instanceof Error)) return { type: typeof error };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const stack = stackFrames(error);
  return {
    type: error.constructor.name,
    ...(code === undefined ? {} : { code }),
    ...(stack === undefined ? {} : { stack }),
  };
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    typeof error.type === 'string' &&
    'status' in error &&
    typeof error.status === 'number'
  );
}

function fromBodyParserError(error: BodyParserError): ErrorResponse {
  switch (error.type) {
    case 'entity.parse.failed':
      return { status: 400, code: 'MALFORMED_JSON', message: 'Request body is not valid JSON' };
    case 'entity.too.large':
      return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' };
    case 'charset.unsupported':
    case 'encoding.unsupported':
      return { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported charset or content encoding' };
    default:
      return error.status >= 400 && error.status < 500
        ? { status: 400, code: 'BAD_REQUEST', message: 'Malformed request' }
        : INTERNAL_ERROR;
  }
}

function toErrorResponse(error: unknown, mappings: ErrorMappings): ErrorResponse {
  if (error instanceof AppError) {
    const mapping = mappings[error.code];
    if (mapping === undefined) return INTERNAL_ERROR;
    return {
      status: mapping.status,
      code: error.code,
      message: mapping.message ?? error.message,
      ...(error instanceof RequestValidationError ? { details: error.details } : {}),
    };
  }
  if (isBodyParserError(error)) return fromBodyParserError(error);
  return INTERNAL_ERROR;
}

export function createErrorHandler(featureMappings: ErrorMappings = {}): ErrorRequestHandler {
  const mappings = { ...SHARED_MAPPINGS, ...featureMappings };

  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const response = toErrorResponse(error, mappings);
    const { logger, requestId } = res.locals;

    if (req.socket.destroyed) {
      // Nobody is left to read a response; the outcome is already in the audit trail.
      logger.info({ code: response.code }, 'Client disconnected before the response was sent');
      return;
    }

    if (isBodyParserError(error)) {
      // Body-parser errors carry the raw payload in `body`, and JSON SyntaxError messages quote
      // part of it. Logging the error object or its message would leak request PII.
      logger.warn({ code: response.code, type: error.type }, 'Request body rejected');
    } else if (response === INTERNAL_ERROR) {
      logger.error({ error: summarizeUnexpectedError(error), code: response.code }, 'Request failed');
    } else if (response.status >= 500) {
      logger.error({ err: error, code: response.code }, 'Request failed');
    } else {
      logger.warn({ code: response.code }, 'Request rejected');
    }

    res.status(response.status).json({
      requestId,
      error: {
        code: response.code,
        message: response.message,
        ...(response.details === undefined ? {} : { details: response.details }),
      },
    });
  };
}
