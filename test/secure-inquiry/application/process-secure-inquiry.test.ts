import { describe, expect, it } from 'vitest';
import { SERVICE_BUSY_REPLY } from '../../../src/secure-inquiry/application/ai-fallback.js';
import {
  AiProviderUnavailableError,
  AiRequestCancelledError,
  AuditPersistenceError,
  type AiProviderFailureReason,
} from '../../../src/secure-inquiry/application/errors.js';
import type { AiProvider, AiReplyOptions } from '../../../src/secure-inquiry/application/ports/ai-provider.js';
import type { AuditOutcomeNotRecorded } from '../../../src/secure-inquiry/application/ports/audit-failure-reporter.js';
import { ProcessSecureInquiry } from '../../../src/secure-inquiry/application/process-secure-inquiry.js';
import { auditAssociatedData } from '../../../src/secure-inquiry/domain/audit-associated-data.js';
import type { AuditOutcome, AuditRecord } from '../../../src/secure-inquiry/domain/audit-record.js';
import type { EncryptedPayload } from '../../../src/secure-inquiry/domain/encrypted-payload.js';
import type { RedactedText } from '../../../src/secure-inquiry/domain/redacted-text.js';
import { createPiiSanitizer } from '../../../src/secure-inquiry/domain/sanitization/pii-sanitizer.js';

const USER_ID = 'jane.doe@example.com';
const USER_REF = 'user-ref-1';
const AUDIT_ID = 'audit-1';
const MESSAGE = 'Please email jane.doe@example.com about SSN 123-45-6789';
const SANITIZED = 'Please email <REDACTED: EMAIL> about SSN <REDACTED: SSN>';
const RECEIVED_AT = new Date('2026-10-27T10:00:00.000Z');
const SETTLED_AT = new Date('2026-10-27T10:00:02.000Z');

const PAYLOAD: EncryptedPayload = {
  algorithm: 'aes-256-gcm',
  version: 1,
  keyId: 'v1',
  iv: 'iv',
  authTag: 'tag',
  ciphertext: 'ciphertext',
};

type ReplyBehavior = (prompt: RedactedText, options?: AiReplyOptions) => Promise<string>;

interface HarnessOptions {
  readonly reply?: ReplyBehavior;
  /** 1-based append numbers that reject. */
  readonly failingAppends?: readonly number[];
}

function harness({ reply = (prompt) => Promise.resolve(`Generated Answer: ${prompt}`), failingAppends = [] }: HarnessOptions = {}) {
  const events: string[] = [];
  const appended: AuditRecord[] = [];
  const encryptCalls: { plaintext: string; associatedData: string }[] = [];
  const prompts: { prompt: string; options: AiReplyOptions | undefined }[] = [];
  const pseudonymized: string[] = [];
  const reported: AuditOutcomeNotRecorded[] = [];
  const clockReadings = [RECEIVED_AT, SETTLED_AT];
  let appendCount = 0;

  const aiProvider: AiProvider = {
    reply: (prompt, options) => {
      events.push('reply');
      prompts.push({ prompt, options });
      return reply(prompt, options);
    },
  };

  const useCase = new ProcessSecureInquiry({
    sanitizer: createPiiSanitizer(),
    encryption: {
      encrypt: (plaintext, associatedData) => {
        events.push('encrypt');
        encryptCalls.push({ plaintext, associatedData });
        return PAYLOAD;
      },
    },
    auditRepository: {
      append: (record) => {
        appendCount += 1;
        events.push(`append:${record.outcome}`);
        if (failingAppends.includes(appendCount)) {
          return Promise.reject(new AuditPersistenceError({ cause: new Error('disk full') }));
        }
        appended.push(record);
        return Promise.resolve();
      },
    },
    auditFailureReporter: { outcomeNotRecorded: (event) => reported.push(event) },
    userPseudonymizer: {
      pseudonymize: (userId) => {
        pseudonymized.push(userId);
        return USER_REF;
      },
    },
    aiProvider,
    clock: { now: () => clockReadings.shift() ?? SETTLED_AT },
    idGenerator: { next: () => AUDIT_ID },
  });

  return { useCase, events, appended, encryptCalls, prompts, pseudonymized, reported };
}

const command = { userId: USER_ID, message: MESSAGE };

describe('ProcessSecureInquiry: success', () => {
  it('returns the provider reply for the sanitized message', async () => {
    const { useCase } = harness();

    await expect(useCase.execute(command)).resolves.toEqual({
      inquiryId: AUDIT_ID,
      source: 'AI_PROVIDER',
      sanitizedMessage: SANITIZED,
      reply: `Generated Answer: ${SANITIZED}`,
    });
  });

  it('encrypts and audits before anything reaches the provider, then records the outcome', async () => {
    const { useCase, events } = harness();

    await useCase.execute(command);

    expect(events).toEqual(['encrypt', 'append:PENDING', 'reply', 'append:COMPLETED']);
  });

  it('encrypts the original message bound to the audit record identity', async () => {
    const { useCase, encryptCalls } = harness();

    await useCase.execute(command);

    expect(encryptCalls).toEqual([
      { plaintext: MESSAGE, associatedData: auditAssociatedData({ auditId: AUDIT_ID, userRef: USER_REF }) },
    ]);
  });

  it('sends only the sanitized text to the provider and forwards the caller signal', async () => {
    const { useCase, prompts } = harness();
    const signal = new AbortController().signal;

    await useCase.execute(command, { signal });

    expect(prompts).toEqual([{ prompt: SANITIZED, options: { signal } }]);
    expect(prompts[0]?.prompt).not.toContain(USER_ID);
  });

  it('writes a PENDING revision and a COMPLETED revision with the full v1 record', async () => {
    const { useCase, appended } = harness();

    await useCase.execute(command);

    const pending = {
      schemaVersion: 1,
      auditId: AUDIT_ID,
      revision: 1,
      createdAt: RECEIVED_AT.toISOString(),
      recordedAt: RECEIVED_AT.toISOString(),
      userRef: USER_REF,
      sanitizedMessage: SANITIZED,
      redactions: { EMAIL: 1, SSN: 1 },
      encryptedMessage: PAYLOAD,
      outcome: 'PENDING',
    };
    expect(appended).toEqual([
      pending,
      { ...pending, revision: 2, recordedAt: SETTLED_AT.toISOString(), outcome: 'COMPLETED' },
    ]);
  });

  it('pseudonymizes the userId and never stores it raw', async () => {
    const { useCase, appended, pseudonymized } = harness();

    await useCase.execute(command);

    expect(pseudonymized).toEqual([USER_ID]);
    expect(JSON.stringify(appended)).not.toContain(USER_ID);
    expect(JSON.stringify(appended)).not.toContain('123-45-6789');
  });
});

describe('ProcessSecureInquiry: audit before egress', () => {
  it('propagates a failed PENDING write and never calls the provider', async () => {
    const { useCase, events, reported } = harness({ failingAppends: [1] });

    await expect(useCase.execute(command)).rejects.toBeInstanceOf(AuditPersistenceError);

    expect(events).toEqual(['encrypt', 'append:PENDING']);
    expect(reported).toEqual([]);
  });
});

describe('ProcessSecureInquiry: provider failures', () => {
  it.each<[AiProviderFailureReason, AuditOutcome]>([
    ['PROVIDER_ERROR', 'PROVIDER_FAILURE'],
    ['TIMEOUT', 'PROVIDER_TIMEOUT'],
    ['CIRCUIT_OPEN', 'CIRCUIT_OPEN_FALLBACK'],
  ])('returns the Service Busy fallback for %s and audits %s', async (reason, outcome) => {
    const { useCase, appended } = harness({ reply: () => Promise.reject(new AiProviderUnavailableError(reason)) });

    await expect(useCase.execute(command)).resolves.toEqual({
      inquiryId: AUDIT_ID,
      source: 'FALLBACK',
      reason,
      sanitizedMessage: SANITIZED,
      reply: SERVICE_BUSY_REPLY,
    });
    expect(appended.map((record) => record.outcome)).toEqual(['PENDING', outcome]);
  });

  it('records a cancellation and rethrows it unchanged', async () => {
    const cancellation = new AiRequestCancelledError();
    const { useCase, appended } = harness({ reply: () => Promise.reject(cancellation) });

    await expect(useCase.execute(command)).rejects.toBe(cancellation);
    expect(appended.map((record) => record.outcome)).toEqual(['PENDING', 'CANCELLED']);
  });

  it('records an unexpected error as INTERNAL_ERROR and rethrows it unchanged', async () => {
    const bug = new TypeError('unexpected');
    const { useCase, appended } = harness({ reply: () => Promise.reject(bug) });

    await expect(useCase.execute(command)).rejects.toBe(bug);
    expect(appended.map((record) => record.outcome)).toEqual(['PENDING', 'INTERNAL_ERROR']);
  });
});

describe('ProcessSecureInquiry: outcome revision failures', () => {
  it('still returns the reply and reports the missing outcome', async () => {
    const { useCase, reported } = harness({ failingAppends: [2] });

    await expect(useCase.execute(command)).resolves.toMatchObject({ source: 'AI_PROVIDER' });

    expect(reported).toEqual([
      { auditId: AUDIT_ID, outcome: 'COMPLETED', cause: expect.any(AuditPersistenceError) as unknown },
    ]);
  });

  it('still returns the fallback and reports the missing outcome', async () => {
    const { useCase, reported } = harness({
      reply: () => Promise.reject(new AiProviderUnavailableError('CIRCUIT_OPEN')),
      failingAppends: [2],
    });

    await expect(useCase.execute(command)).resolves.toMatchObject({ source: 'FALLBACK', reason: 'CIRCUIT_OPEN' });
    expect(reported).toEqual([expect.objectContaining({ outcome: 'CIRCUIT_OPEN_FALLBACK' })]);
  });

  it('keeps the original error when the outcome of a failed call cannot be recorded', async () => {
    const cancellation = new AiRequestCancelledError();
    const { useCase, reported } = harness({ reply: () => Promise.reject(cancellation), failingAppends: [2] });

    await expect(useCase.execute(command)).rejects.toBe(cancellation);
    expect(reported).toEqual([expect.objectContaining({ outcome: 'CANCELLED' })]);
  });
});
