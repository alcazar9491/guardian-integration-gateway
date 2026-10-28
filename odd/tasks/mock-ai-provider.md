# Feature: mock-ai-provider

## Objective

`AiProvider` port and a `MockAiProvider` adapter that simulates an external AI service: non-blocking 2-second delay, deterministic reply `Generated Answer: <sanitized message>`, deterministic failure injection (including consecutive failures followed by recovery), typed application errors, and cancellation/timeout support. The provider can only ever receive sanitized text.

## Problem / Why

The circuit breaker and use case need a provider whose failures are reproducible, not random. The current scaffold exposes `AI_PROVIDER_FAILURE_RATE` (random), which makes breaker tests and demos nondeterministic.

## Scope

- In: port signature with `AbortSignal`, error reasons, `AiRequestCancelledError`, outcome schedules, `MockAiProvider`, `TimeoutAiProvider` decorator, lint rule restricting `RedactedText` creation, config replacement of the failure rate, composition-root wiring, staged `env.example` update, unit tests, `docs/ai-provider.md`.
- Out: circuit breaker state machine (next slice; its adapter stays a stub), use case orchestration, HTTP-driven cancellation (client disconnect), real provider integration.

## Constraints

- No Express, HTTP, or `process.env` access in the provider, schedules, or timeout decorator.
- Failure injection lives only in infrastructure and configuration; domain and application contain no failure behavior.
- Never block the event loop: delays use `node:timers/promises` and honor `AbortSignal`.
- No new dependencies. Never log prompts.
- Do not create or edit `.env*` files in the project (permission rule); update only the staged scratchpad `env.example`.

## Design

### Port (application)

`AiProvider.reply(prompt: RedactedText, options?: { signal?: AbortSignal }): Promise<string>`.

Errors (application):

- `AiProviderUnavailableError` with `reason: 'PROVIDER_ERROR' | 'TIMEOUT' | 'CIRCUIT_OPEN'`. Counts as a provider failure for the breaker.
- `AiRequestCancelledError`: the caller aborted. Never counts as a provider failure.

Messages are generic and never contain the prompt.

### Sanitization guarantee

1. Compile time: `reply` accepts only `RedactedText` (branded via a non-exported `unique symbol`).
2. Lint: `no-restricted-syntax` forbids `as RedactedText` and `<RedactedText>` assertions everywhere in `src/` except `src/secure-inquiry/domain/sanitization/**`, so the sanitizer is the only producer. Tests are exempt.
3. Tests: a `@ts-expect-error` call with a raw string (type-checked by `npm run typecheck`) and an in-process test piping real sanitizer output into the provider.

### Outcome schedules (infrastructure, Strategy)

`OutcomeSchedule { next(): 'success' | 'failure' }` with factories `alwaysSucceed()`, `alwaysFail()`, `failFirst(n)` (then succeeds), and `scripted(outcomes, { then })`. The outcome is taken synchronously when `reply` is called, so concurrent calls get outcomes in call order. A call made with an already-aborted signal rejects immediately and consumes no outcome; a call aborted during the delay has already consumed its outcome (documented).

### MockAiProvider (infrastructure)

Options `{ delayMs, schedule, delay? }`; `delay` is an injectable `(ms, signal?) => Promise<void>` defaulting to an abortable `node:timers/promises` `setTimeout`. Success and failure both resolve after the delay (failures model a remote error arriving after latency). Success returns `Generated Answer: ${prompt}`. Failure rejects with `AiProviderUnavailableError('PROVIDER_ERROR')`. Abort rejects with `AiRequestCancelledError` and clears the timer.

### TimeoutAiProvider (infrastructure, Decorator)

`TimeoutAiProvider(inner, { timeoutMs })` combines its own timeout signal (an `AbortController` aborted by a `setTimeout` cleared on settle; amended from `AbortSignal.timeout` so no timer outlives the call) with the caller signal via `AbortSignal.any`, passes it to `inner`, and also races the inner promise so a provider that ignores the signal still times out. Its own timeout becomes `AiProviderUnavailableError('TIMEOUT')`; caller abort stays `AiRequestCancelledError`; other errors pass through unchanged. Listeners are removed on settle.

`CircuitBreakerOptions.callTimeoutMs` is removed: timeouts are this decorator's single responsibility. Wiring order: `CircuitBreakerAiProvider(TimeoutAiProvider(MockAiProvider))`.

### Configuration

- Remove `AI_PROVIDER_FAILURE_RATE`.
- Add `AI_PROVIDER_FAILURES` = `never` (default) | `always` | `first:<n>` (n ≥ 1), parsed into a discriminated union in config. The composition root maps it to a schedule.
- Keep `AI_PROVIDER_DELAY_MS` (default 2000) and `AI_PROVIDER_TIMEOUT_MS` (default 5000).
- When failure injection is not `never`, one startup warning names the mode (no other detail). Amended: emitted by `compose()`, which `main` calls once, so it is unit-testable.

## Test plan

- Success: reply text equals `Generated Answer: <prompt>`; the injected delay receives the configured ms; the promise stays pending until the delay resolves.
- Non-blocking: with real timers, 5 concurrent calls at 100 ms finish well under 5 × 100 ms, and a `setImmediate` callback runs before the first reply.
- Failure: `alwaysFail` rejects with `AiProviderUnavailableError` `PROVIDER_ERROR` after the delay; error message and stack do not contain the prompt.
- Recovery: `failFirst(3)` rejects calls 1–3 and resolves calls 4–6; same with concurrent calls (call order). `scripted` follows its sequence then its `then` outcome. Invalid schedule arguments throw at construction.
- Cancellation: abort during delay rejects with `AiRequestCancelledError` well before the delay ends; a pre-aborted signal rejects immediately without consuming an outcome.
- Timeout decorator: slow inner → `TIMEOUT`; fast inner → passes through; caller abort → `AiRequestCancelledError`; inner `PROVIDER_ERROR` passes through; a signal-ignoring inner still times out; no unhandled rejections.
- Sanitization: `@ts-expect-error` on a raw string; real `createPiiSanitizer()` output piped into the provider yields `<REDACTED: EMAIL>` and never the original email; the lint rule rejects a temporary `as RedactedText` probe outside the sanitizer.
- Config: `AI_PROVIDER_FAILURES` accepts `never`, `always`, `first:3`; rejects `sometimes`, `first:0`, `first:-1`, `first:abc`; `AI_PROVIDER_FAILURE_RATE` no longer exists.
- Composition root: smoke tests still pass with the new wiring.

## Workflow settings

- TDD: strict, ON. Source: global `~/.claude/CLAUDE.md`. Runner: Vitest (`npm test`).
- Route: delegated direct (writer trigger: 2+ non-trivial files) via one forked writer, started after `aes-gcm-encryption` completes (shared `application/errors.ts`, `app-config.ts`, `composition-root.ts`, and test runs).
- Commits: blocked. Not a git repository yet.
- RDD assessment: not run. No work-unit commit exists.
- Delivery: forecast ~600 authored changed lines; strategy pending until a repository exists.
- Engram mirror `odd/mock-ai-provider/tasks`: PENDING. Engram MCP failed to connect this session.

## Tasks

- [x] T1 Contracts: port `signal` option, `TIMEOUT` reason, `AiRequestCancelledError`, remove `callTimeoutMs`, `RedactedText` assertion lint rule (prove it fires)
- [x] T2 Outcome schedules (TDD)
- [x] T3 `MockAiProvider` with abortable injectable delay (TDD), replacing `SimulatedAiProvider`; group AI adapters under `infrastructure/ai-provider/`
- [x] T4 `TimeoutAiProvider` decorator (TDD)
- [x] T5 Config `AI_PROVIDER_FAILURES` (TDD), staged `env.example` update, composition-root wiring, startup warning, smoke tests
- [x] T6 `docs/ai-provider.md` (modes, breaker demo recipe, cancellation vs timeout semantics, what counts as a breaker failure); full `npm run check` and `npm run build`

## Acceptance criteria

- Every test-plan item passes; `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.
- No `express`, HTTP, `process`, or logger import in the AI provider adapters (Grep).
- No dependency added to `package.json`.

## Progress and evidence

Baseline before writing: `npm run check` exit 0, 14 files, 295/295 tests.

### T1 Contracts (route: delegated writer)

- `AiReplyOptions { signal? }` on the port; `AiProviderFailureReason` (`PROVIDER_ERROR | TIMEOUT | CIRCUIT_OPEN`) for `AiProviderUnavailableError`; new `AiRequestCancelledError`. The API-facing `FallbackReason` is unchanged; the use case slice decides how `TIMEOUT` surfaces.
- `CircuitBreakerOptions.callTimeoutMs` removed with its wiring.
- Lint proof: a temporary probe in `src/secure-inquiry/application/` produced 4 `no-restricted-syntax` errors (`as RedactedText`, `as unknown as RedactedText`, `<RedactedText>`, `brand<RedactedText>()`); `domain/sanitization/pii-sanitizer.ts` linted clean in the same run. Probe deleted.
- Types and lint configuration only; no behavior to test-drive. `npm run check`: exit 0, 295/295.
- Commit: blocked (no git repository).

### T2 Outcome schedules (route: delegated writer)

- RED: `npx vitest run test/secure-inquiry/infrastructure/ai-provider/outcome-schedule.test.ts` failed (module `outcome-schedule` missing, 1 file failed).
- GREEN: same command, 15/15 passed; ESLint clean on the new files.
- `failFirst(0)` is allowed (equivalent to `alwaysSucceed`); negative, fractional, NaN and infinite counts throw `RangeError`; unknown outcomes throw `TypeError`; the script is copied defensively.
- Commit: blocked (no git repository).

### T3 MockAiProvider (route: delegated writer)

- RED: `npx vitest run test/secure-inquiry/infrastructure/ai-provider/mock-ai-provider.test.ts` failed (modules `mock-ai-provider` and `abortable-delay` missing, 1 file failed).
- GREEN: same command, 19/19 passed (success, delay, pending-until-delay, typed failure after latency, prompt never in errors, `failFirst(3)` recovery sequential and concurrent-in-reverse, scripted, cancellation mid-delay under 1 s, pre-aborted consumes no outcome, mid-delay abort consumes its outcome, signal-ignoring delay still reports cancellation, abort never reported as provider failure, 5 × 100 ms concurrent calls under 400 ms with `setImmediate` running first, `@ts-expect-error` raw string, real sanitizer output piped through, invalid delays).
- `SimulatedAiProvider` deleted; `CircuitBreakerAiProvider` stub moved to `infrastructure/ai-provider/`. The composition root temporarily wires `MockAiProvider` with `alwaysSucceed()` so the build stays green until T5 replaces the config.
- `npm run check`: exit 0, 16 files, 329/329. Typecheck passing proves the `@ts-expect-error` raw-string call is a real compile error.
- Commit: blocked (no git repository).

### T4 TimeoutAiProvider (route: delegated writer)

- RED: `npx vitest run test/secure-inquiry/infrastructure/ai-provider/timeout-ai-provider.test.ts` failed (module `timeout-ai-provider` missing, 1 file failed).
- GREEN: same command, 12/12 passed (pass-through, real-timer TIMEOUT under 300 ms against a 500 ms mock, fake-timer TIMEOUT for a signal-ignoring provider, inner signal aborted on timeout, caller abort is cancellation not timeout, pre-aborted caller never reaches the inner provider, inner failures pass through as the same instance, no timer left after settle, invalid timeouts).
- Spec amendment: an explicit `AbortController` + `setTimeout` cleared in `finally` replaces `AbortSignal.timeout`, so no timer outlives the call and the behavior is testable with fake timers. When caller abort and timeout coincide, cancellation wins (never counted as a provider failure).
- `npm run check`: exit 0, 17 files, 341/341.
- Commit: blocked (no git repository).

### T5 Configuration and wiring (route: delegated writer)

- RED: `npx vitest run test/shared/config/app-config.test.ts test/composition-root.test.ts` → 18 failed, 26 passed (defaults, explicit values, 4 accepted modes, 9 rejected modes, removed failure rate, aggregated errors, startup warning).
- GREEN: config 38/38; composition root 6/6.
- Zod 4 gotchas found on the way: `.default()` on a transformed schema takes the parsed output type and skips parsing, and it shallow-clones object defaults (dropping `Object.freeze`). The default is the parsed `{ kind: 'never' }` and the mode is frozen when the config is assembled.
- Spec amendment: the startup warning is logged from `compose()` (called once per process by `main`) rather than from `main` itself, so it is unit-tested with a captured logger.
- Wiring: `CircuitBreakerAiProvider(TimeoutAiProvider(MockAiProvider(schedule from AI_PROVIDER_FAILURES)))`; `AI_PROVIDER_FAILURE_RATE` removed from config, tests, and the staged scratchpad `env.example` (project `.env.example` still blocked by the permission rule).
- `npm run check`: exit 0, 17 files, 356/356.
- Commit: blocked (no git repository).

### T6 Docs and full verification (route: delegated writer)

- `docs/ai-provider.md`: port contract, adapter chain, mock behavior, failure modes, breaker demo recipe, timeout vs cancellation, three-layer sanitization guarantee.
- `npm run check`: exit 0 (typecheck, lint, 17 files, 356/356 tests). `npm run build`: exit 0.
- Grep: no `express`, `node:http`, `process`, pino/logger, or `console` in `src/secure-inquiry/infrastructure/ai-provider/`. `AI_PROVIDER_FAILURE_RATE` appears only in the config regression test asserting it is gone. `package.json` dependencies unchanged.
- Boot: `dist/main.js` with a generated key, `AI_PROVIDER_FAILURES=first:3`, `PORT=3999` logged exactly one `AI provider failure injection is enabled` warning with `{"kind":"first","count":3}`, `GET /health` returned 200; process terminated, port freed.
- Commit: blocked (no git repository).

## Next step

Feature complete. Circuit breaker slice next: implement `ConsecutiveFailuresCircuitBreaker` and `CircuitBreakerAiProvider` (count `AiProviderUnavailableError` only, never `AiRequestCancelledError`). Use case slice: decide how `TIMEOUT` surfaces in `FallbackReason`, and pass a caller `AbortSignal` tied to client disconnect.
