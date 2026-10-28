import { AppError } from '../../../shared/errors/app-error.js';

/** The message is fixed on purpose: it must never echo the rejected input. */
export class InvalidSanitizerInputError extends AppError {
  override readonly code = 'INVALID_SANITIZER_INPUT';

  constructor() {
    super('Sanitizer input must be a string');
  }
}
