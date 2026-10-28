import { AppError } from '../../shared/errors/app-error.js';

const MESSAGES = {
  KEY: 'Encryption key must be a 32-byte secret key',
  KEY_ID: 'Encryption key id must be 1-64 characters of letters, digits, ".", "_" or "-"',
} as const;

/** The message is fixed on purpose: it must never echo key material. */
export class InvalidEncryptionKeyError extends AppError {
  override readonly code = 'INVALID_ENCRYPTION_KEY';

  constructor(readonly field: keyof typeof MESSAGES) {
    super(MESSAGES[field]);
  }
}
