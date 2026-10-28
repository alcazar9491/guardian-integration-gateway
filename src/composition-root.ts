import type { Express } from 'express';
import { createApp } from './app.js';
import type { Clock } from './secure-inquiry/application/ports/clock.js';
import type { EncryptionService } from './secure-inquiry/application/ports/encryption-service.js';
import type { IdGenerator } from './secure-inquiry/application/ports/id-generator.js';
import { ProcessSecureInquiry } from './secure-inquiry/application/process-secure-inquiry.js';
import { createPiiSanitizer } from './secure-inquiry/domain/sanitization/pii-sanitizer.js';
import { AesGcmEncryptionService } from './secure-inquiry/infrastructure/aes-gcm-encryption-service.js';
import type { AiProvider } from './secure-inquiry/application/ports/ai-provider.js';
import {
  CircuitBreakerAiProvider,
  classifyAiProviderError,
} from './secure-inquiry/infrastructure/ai-provider/circuit-breaker-ai-provider.js';
import type { Delay } from './secure-inquiry/infrastructure/ai-provider/abortable-delay.js';
import { MockAiProvider } from './secure-inquiry/infrastructure/ai-provider/mock-ai-provider.js';
import {
  alwaysFail,
  alwaysSucceed,
  failFirst,
  type OutcomeSchedule,
} from './secure-inquiry/infrastructure/ai-provider/outcome-schedule.js';
import { TimeoutAiProvider } from './secure-inquiry/infrastructure/ai-provider/timeout-ai-provider.js';
import type { AuditFileSystem } from './secure-inquiry/infrastructure/audit/audit-file-system.js';
import { JsonlAuditRepository } from './secure-inquiry/infrastructure/audit/jsonl-audit-repository.js';
import { HmacUserPseudonymizer } from './secure-inquiry/infrastructure/hmac-user-pseudonymizer.js';
import { LoggingAuditFailureReporter } from './secure-inquiry/infrastructure/logging-audit-failure-reporter.js';
import { RandomUuidGenerator } from './secure-inquiry/infrastructure/random-uuid-generator.js';
import { SystemClock } from './secure-inquiry/infrastructure/system-clock.js';
import type { AiProviderFailureMode, AppConfig } from './shared/config/app-config.js';
import type { Logger } from './shared/logging/logger.js';
import type { CircuitStateChange, CircuitStatus, TimeSource } from './shared/resilience/circuit-breaker.js';
import { ConsecutiveFailuresCircuitBreaker } from './shared/resilience/consecutive-failures-circuit-breaker.js';

export interface ComposedApplication {
  readonly app: Express;
  /** Drains pending audit writes; call after the HTTP server stops accepting requests. */
  readonly shutdown: () => Promise<void>;
  /** Read-only view of the AI provider's breaker for in-process observation. Not exposed over HTTP. */
  readonly circuit: CircuitStatus;
}

export interface AiProviderChain {
  readonly aiProvider: AiProvider;
  readonly circuit: CircuitStatus;
}

export interface AiProviderOverrides {
  readonly clock?: TimeSource;
  readonly schedule?: OutcomeSchedule;
  readonly delay?: Delay;
}

/** Test seams only. Without overrides, compose() builds exactly the production wiring. */
export interface CompositionOverrides {
  readonly clock?: Clock & TimeSource;
  readonly idGenerator?: IdGenerator;
  readonly aiOutcomeSchedule?: OutcomeSchedule;
  readonly aiDelay?: Delay;
  readonly auditFileSystem?: AuditFileSystem;
}

function scheduleFor(failures: AiProviderFailureMode): OutcomeSchedule {
  switch (failures.kind) {
    case 'never':
      return alwaysSucceed();
    case 'always':
      return alwaysFail();
    case 'first':
      return failFirst(failures.count);
  }
}

function logCircuitTransition(logger: Logger): (change: CircuitStateChange) => void {
  return (change) => {
    const level = change.to === 'OPEN' ? 'warn' : 'info';
    logger[level]({ circuit: change }, 'AI provider circuit state changed');
  };
}

/** A live view that can neither change the breaker nor run calls through it. */
function readOnlyStatus(breaker: CircuitStatus): CircuitStatus {
  return Object.freeze({
    get state() {
      return breaker.state;
    },
    get consecutiveFailures() {
      return breaker.consecutiveFailures;
    },
  });
}

/**
 * Builds the AI provider chain around exactly one breaker. Called once per process: a per-request
 * breaker would never see consecutive failures and so would never open.
 */
export function buildAiProvider(
  config: AppConfig,
  logger: Logger,
  { clock = new SystemClock(), schedule, delay }: AiProviderOverrides = {},
): AiProviderChain {
  const breaker = new ConsecutiveFailuresCircuitBreaker(
    {
      failureThreshold: config.circuitBreaker.failureThreshold,
      cooldownMs: config.circuitBreaker.cooldownMs,
      classifyError: classifyAiProviderError,
      onStateChange: logCircuitTransition(logger),
    },
    clock,
  );

  // Breaker outermost: timeouts surface as provider failures it can count.
  const aiProvider = new CircuitBreakerAiProvider(
    new TimeoutAiProvider(
      new MockAiProvider({
        delayMs: config.aiProvider.delayMs,
        schedule: schedule ?? scheduleFor(config.aiProvider.failures),
        ...(delay === undefined ? {} : { delay }),
      }),
      { timeoutMs: config.aiProvider.timeoutMs },
    ),
    breaker,
  );

  return { aiProvider, circuit: readOnlyStatus(breaker) };
}

/** The only place that knows concrete classes. Everything else depends on ports. */
export function compose(
  config: AppConfig,
  logger: Logger,
  overrides: CompositionOverrides = {},
): ComposedApplication {
  const clock = overrides.clock ?? new SystemClock();

  if (config.aiProvider.failures.kind !== 'never') {
    logger.warn({ aiProviderFailures: config.aiProvider.failures }, 'AI provider failure injection is enabled');
  }

  const { aiProvider, circuit } = buildAiProvider(config, logger, {
    clock,
    ...(overrides.aiOutcomeSchedule === undefined ? {} : { schedule: overrides.aiOutcomeSchedule }),
    ...(overrides.aiDelay === undefined ? {} : { delay: overrides.aiDelay }),
  });

  // The use case only sees the encrypt side; decryption is reserved for tests and authorized verification.
  const encryption: EncryptionService = new AesGcmEncryptionService({
    key: config.audit.encryptionKey,
    keyId: config.audit.keyId,
  });

  // One repository per process: its in-process write queue is what keeps concurrent appends from interleaving.
  const auditRepository = new JsonlAuditRepository({
    filePath: config.audit.filePath,
    ...(overrides.auditFileSystem === undefined ? {} : { fileSystem: overrides.auditFileSystem }),
  });

  const processSecureInquiry = new ProcessSecureInquiry({
    sanitizer: createPiiSanitizer(),
    encryption,
    auditRepository,
    auditFailureReporter: new LoggingAuditFailureReporter(logger),
    userPseudonymizer: new HmacUserPseudonymizer({ key: config.audit.userRefKey }),
    aiProvider,
    clock,
    idGenerator: overrides.idGenerator ?? new RandomUuidGenerator(),
  });

  const app = createApp({ logger, processSecureInquiry, bodyLimitBytes: config.http.bodyLimitBytes });

  return { app, shutdown: () => auditRepository.close(), circuit };
}
