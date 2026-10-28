import { AppError } from '../errors/app-error.js';

export interface ValidationIssue {
  readonly path: string;
  readonly issue: string;
}

export class RequestValidationError extends AppError {
  override readonly code = 'VALIDATION_ERROR';

  constructor(readonly details: readonly ValidationIssue[]) {
    super('Invalid request body');
  }
}

export class UnsupportedMediaTypeError extends AppError {
  override readonly code = 'UNSUPPORTED_MEDIA_TYPE';

  constructor() {
    super('Content-Type must be application/json');
  }
}
