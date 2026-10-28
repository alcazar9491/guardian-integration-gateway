import { auditAssociatedData } from '../domain/audit-associated-data.js';
import { AUDIT_RECORD_SCHEMA_VERSION, type AuditOutcome, type AuditRecord } from '../domain/audit-record.js';
import type { MessageSanitizer } from '../domain/message-sanitizer.js';
import type { RedactedText } from '../domain/redacted-text.js';
import { resolveFallback } from './ai-fallback.js';
import { AiRequestCancelledError, type FallbackReason } from './errors.js';
import type { InquiryResult } from './inquiry-result.js';
import type { AiProvider } from './ports/ai-provider.js';
import type { AuditFailureReporter } from './ports/audit-failure-reporter.js';
import type { AuditRepository } from './ports/audit-repository.js';
import type { Clock } from './ports/clock.js';
import type { EncryptionService } from './ports/encryption-service.js';
import type { IdGenerator } from './ports/id-generator.js';
import type { UserPseudonymizer } from './ports/user-pseudonymizer.js';

export interface SecureInquiryCommand {
  readonly userId: string;
  readonly message: string;
}

export interface SecureInquiryOptions {
  /** Aborted when the caller (for example a disconnected HTTP client) no longer wants the answer. */
  readonly signal?: AbortSignal;
}

export interface ProcessSecureInquiryDependencies {
  readonly sanitizer: MessageSanitizer;
  readonly encryption: EncryptionService;
  readonly auditRepository: AuditRepository;
  readonly auditFailureReporter: AuditFailureReporter;
  readonly userPseudonymizer: UserPseudonymizer;
  readonly aiProvider: AiProvider;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

/** How the provider call settled: a result to return, or an error to rethrow once the outcome is audited. */
type ProviderSettlement =
  | { readonly outcome: AuditOutcome; readonly result: InquiryResult }
  | { readonly outcome: AuditOutcome; readonly error: unknown };

const OUTCOME_BY_FALLBACK_REASON: Readonly<Record<FallbackReason, AuditOutcome>> = {
  PROVIDER_ERROR: 'PROVIDER_FAILURE',
  TIMEOUT: 'PROVIDER_TIMEOUT',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN_FALLBACK',
};

export class ProcessSecureInquiry {
  constructor(private readonly deps: ProcessSecureInquiryDependencies) {}

  async execute(command: SecureInquiryCommand, options: SecureInquiryOptions = {}): Promise<InquiryResult> {
    const pending = this.createPendingRecord(command);

    // Audit before egress: if this write fails, the sanitized text never leaves the service.
    await this.deps.auditRepository.append(pending);

    const settlement = await this.callProvider(pending, options.signal);
    await this.recordOutcome(pending, settlement.outcome);

    if ('error' in settlement) throw settlement.error;
    return settlement.result;
  }

  private createPendingRecord({ userId, message }: SecureInquiryCommand): AuditRecord {
    const { text, findings } = this.deps.sanitizer.sanitize(message);
    const auditId = this.deps.idGenerator.next();
    const userRef = this.deps.userPseudonymizer.pseudonymize(userId);
    const receivedAt = this.deps.clock.now().toISOString();

    return {
      schemaVersion: AUDIT_RECORD_SCHEMA_VERSION,
      auditId,
      revision: 1,
      createdAt: receivedAt,
      recordedAt: receivedAt,
      userRef,
      sanitizedMessage: text,
      redactions: findings,
      encryptedMessage: this.deps.encryption.encrypt(message, auditAssociatedData({ auditId, userRef })),
      outcome: 'PENDING',
    };
  }

  private async callProvider(pending: AuditRecord, signal?: AbortSignal): Promise<ProviderSettlement> {
    const prompt: RedactedText = pending.sanitizedMessage;
    const base = { inquiryId: pending.auditId, sanitizedMessage: prompt };

    try {
      const reply = await this.deps.aiProvider.reply(prompt, signal === undefined ? {} : { signal });
      return { outcome: 'COMPLETED', result: { ...base, source: 'AI_PROVIDER', reply } };
    } catch (error) {
      const fallback = resolveFallback(error);
      if (fallback !== undefined) {
        return {
          outcome: OUTCOME_BY_FALLBACK_REASON[fallback.reason],
          result: { ...base, source: 'FALLBACK', reason: fallback.reason, reply: fallback.reply },
        };
      }
      return { outcome: error instanceof AiRequestCancelledError ? 'CANCELLED' : 'INTERNAL_ERROR', error };
    }
  }

  private async recordOutcome(pending: AuditRecord, outcome: AuditOutcome): Promise<void> {
    const settled: AuditRecord = {
      ...pending,
      revision: 2,
      recordedAt: this.deps.clock.now().toISOString(),
      outcome,
    };
    try {
      await this.deps.auditRepository.append(settled);
    } catch (cause) {
      // Revision 1 already audits the inquiry and the provider has already been called: failing the response
      // now would only provoke a retry and a duplicate provider call. Report it instead of swallowing it.
      this.deps.auditFailureReporter.outcomeNotRecorded({ auditId: pending.auditId, outcome, cause });
    }
  }
}
