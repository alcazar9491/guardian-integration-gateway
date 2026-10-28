import { createHmac, type KeyObject } from 'node:crypto';
import { AppError } from '../../shared/errors/app-error.js';
import type { UserPseudonymizer } from '../application/ports/user-pseudonymizer.js';

const KEY_BYTES = 32;

/** The message is fixed on purpose: it must never echo key material. */
export class InvalidUserRefKeyError extends AppError {
  override readonly code = 'INVALID_USER_REF_KEY';

  constructor() {
    super('User reference key must be a 32-byte secret key');
  }
}

export interface HmacUserPseudonymizerOptions {
  readonly key: KeyObject;
}

/**
 * Data minimization: userId is client-asserted and may itself be PII, so audit records hold only a keyed
 * HMAC of it. Without the key the reference reveals nothing; with it, investigators can recompute it to
 * find a user's records.
 */
export class HmacUserPseudonymizer implements UserPseudonymizer {
  private readonly key: KeyObject;

  constructor({ key }: HmacUserPseudonymizerOptions) {
    if (key.type !== 'secret' || key.symmetricKeySize !== KEY_BYTES) throw new InvalidUserRefKeyError();
    this.key = key;
  }

  pseudonymize(userId: string): string {
    return createHmac('sha256', this.key).update(userId, 'utf8').digest('base64url');
  }
}
