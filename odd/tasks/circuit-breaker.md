# Feature: circuit-breaker

## Objective

Production-minded consecutive-failure circuit breaker (CLOSED, OPEN, HALF_OPEN) protecting the AI provider: opens after 3 consecutive provider failures, fails fast while open (no provider call, no 2-second wait), recovers through a single controlled probe after a configurable cooldown, and stays consistent under concurrent requests.

## Problem / Why

Without a breaker, every request during a provider outage waits the full provider latency and keeps hammering a failing dependency. The breaker must be deterministic to test and must not let concurrent completions corrupt its state or trigger uncontrolled recovery calls.

## Scope

- In: generic breaker in `shared/resilience` (policy only), `CircuitBreakerAiProvider` adapter, application fallback mapping (`Service Busy`), config rename for the cooldown, composition-root wiring with transition logging, unit tests, `docs/circuit-breaker.md`.
- Out: use case orchestration and HTTP end-to-end fallback (next slice wires `resolveFallback`), health endpoint exposure of the state, distributed/shared breaker state, bulkhead/concurrency limits in CLOSED.

## Constraints

- `shared/resilience` imports nothing from features, Express, or loggers; time comes from the injected `TimeSource`.
- No timers inside the breaker: transitions are evaluated lazily on each call, so tests are deterministic and nothing leaks.
- Breaker policy (when to call, when to reject) stays separate from fallback content (application) and HTTP formatting (presentation).
- No new dependencies. Do not create or edit `.env*` files in the project; update only the staged scratchpad `env.example`.

## Design

### Contract (`shared/resilience/circuit-breaker.ts`)

- `CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'`.
- `CircuitBreaker { readonly state: CircuitState; execute<T>(operation: () => Promise<T>): Promise<T> }`.
- `CircuitOpenError` (framework-free `AppError`, code `CIRCUIT_OPEN`).
- `CircuitBreakerOptions { failureThreshold; cooldownMs; classifyError?: (error: unknown) => 'failure' | 'ignore'; onStateChange?: (change: { from; to }) => void }`. Default classifier counts every error as a failure. Options are validated at construction (`failureThreshold` integer ≥ 1, `cooldownMs` > 0).

### State machine (`ConsecutiveFailuresCircuitBreaker`)

| From | Event | To | Effect |
|---|---|---|---|
| CLOSED | success | CLOSED | `consecutiveFailures = 0` |
| CLOSED | failure, count + 1 < threshold | CLOSED | `consecutiveFailures++` |
| CLOSED | failure reaching threshold | OPEN | `openedAt = now`, `generation++` |
| OPEN | call, `now - openedAt < cooldownMs` | OPEN | reject `CircuitOpenError` without invoking the operation |
| OPEN | call, `now - openedAt >= cooldownMs` | HALF_OPEN | `generation++`; this call is the single probe |
| HALF_OPEN | call while the probe is in flight | HALF_OPEN | reject `CircuitOpenError` without invoking the operation |
| HALF_OPEN | probe success | CLOSED | `consecutiveFailures = 0`, `generation++` |
| HALF_OPEN | probe failure | OPEN | `openedAt = now`, `generation++` (cooldown restarts) |
| any | ignored error (e.g. caller cancellation) | unchanged | no count change; a cancelled probe frees the probe slot |

Fail-fast path: `execute` checks state synchronously and returns `Promise.reject(new CircuitOpenError())`; the operation function is never called and nothing is awaited.

### Concurrency rules

Node runs callbacks on one thread, so state changes between `await`s are atomic; the risks are interleavings, handled by:

1. Generation guard: each call records `generation` at admission; an outcome is applied only if `generation` is unchanged. Late failures from a burst cannot extend `openedAt`; a late success cannot close an OPEN or HALF_OPEN circuit.
2. Single probe: `probeInFlight` admits exactly one HALF_OPEN call; concurrent calls fail fast.
3. "Consecutive" is measured in completion order.
4. CLOSED does not limit concurrency: requests admitted before the transition to OPEN still reach the provider; only requests arriving after it fail fast (documented).

### Request-level behavior (documented contract)

| Request | Breaker before | Provider called | Latency | Client receives | Breaker after |
|---|---|---|---|---|---|
| 1st failing | CLOSED (0) | yes, fails | ~2 s | fallback `PROVIDER_ERROR` | CLOSED (1) |
| 2nd failing | CLOSED (1) | yes, fails | ~2 s | fallback `PROVIDER_ERROR` | CLOSED (2) |
| 3rd failing | CLOSED (2) | yes, fails | ~2 s | fallback `PROVIDER_ERROR` | OPEN |
| next | OPEN | no | milliseconds | fallback `CIRCUIT_OPEN` ("Service Busy") | OPEN |
| first after cooldown | OPEN → HALF_OPEN | yes (probe) | ~2 s | reply, or fallback `PROVIDER_ERROR` | CLOSED or OPEN |
| concurrent with probe | HALF_OPEN | no | milliseconds | fallback `CIRCUIT_OPEN` | HALF_OPEN |

The third failing request receives the `PROVIDER_ERROR` fallback, not an HTTP error: it did reach the provider, and that call is what failed; opening the circuit is a consequence of its outcome. Every fallback is HTTP 200 with `status: DEGRADED` (contract from the design phase); the `reason` field tells clients why.

### Adapter and fallback

- `CircuitBreakerAiProvider(inner, breaker)`: `reply` runs `inner.reply` through `breaker.execute`; `CircuitOpenError` becomes `AiProviderUnavailableError('CIRCUIT_OPEN')`; other errors pass through unchanged. The breaker instance is built with a classifier that ignores `AiRequestCancelledError`.
- Application `ai-fallback.ts`: `SERVICE_BUSY_REPLY` (single source of the "Service Busy" text) and `resolveFallback(error)` mapping `AiProviderUnavailableError` (any reason) to `{ reason, reply: SERVICE_BUSY_REPLY }`, returning `undefined` for anything else so the use case rethrows it. HTTP formatting stays in the presenter.

### Configuration and wiring

- Rename `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` to `CIRCUIT_BREAKER_COOLDOWN_MS` (default 30000, > 0); keep `CIRCUIT_BREAKER_FAILURE_THRESHOLD` (default 3, integer ≥ 1).
- The composition root builds exactly one breaker per process (a per-request instance would never open) and logs transitions through `onStateChange`: `warn` on OPEN, `info` on HALF_OPEN and CLOSED, with no request data.

## Test plan

- Initial state CLOSED; success passes the value through; failure rethrows the identical error.
- Exact threshold: two failures stay CLOSED and the third call still invokes the operation; the third failure opens. Thresholds 1 and 5 behave accordingly.
- Reset: F, F, S, F, F stays CLOSED; one more F opens.
- OPEN: operation spy never called; rejection with `CircuitOpenError` even when the operation would never settle.
- Cooldown boundary with a fake clock: `cooldownMs - 1` still rejects; exactly `cooldownMs` admits the probe.
- HALF_OPEN: probe success closes and resets the count; probe failure reopens and restarts the cooldown.
- Single probe: while a deferred probe is pending, concurrent calls reject immediately and the operation runs once.
- Stale outcomes: a burst of 5 admitted in CLOSED, 3 fail (OPEN), the remaining 2 fail later without moving `openedAt`; a stale success after OPEN does not close; a stale outcome during HALF_OPEN does not settle the probe.
- Ignored errors: cancellation in CLOSED neither increments nor resets; a cancelled probe lets the next call probe.
- `onStateChange` fires in transition order; a throwing listener does not corrupt state.
- A classifier that throws counts the error as a failure (amendment from T3).
- Options validation rejects threshold < 1, non-integer threshold, cooldown ≤ 0.
- Adapter with `MockAiProvider` (`delayMs: 2000`, spied injected delay, `failFirst(3)` and `alwaysFail()`): calls 1–3 reject `PROVIDER_ERROR`; call 4 rejects `CIRCUIT_OPEN` in well under 50 ms; the mock's delay ran exactly 3 times; after the cooldown the probe succeeds and later calls return `Generated Answer: ...`.
- `resolveFallback`: every `AiProviderUnavailableError` reason maps to `SERVICE_BUSY_REPLY` with its reason; cancellation and unknown errors map to `undefined`.
- Config: cooldown rename, defaults, validation; composition-root smoke tests still pass; transition logging contains no request data.

## Workflow settings

- TDD: strict, ON. Source: global `~/.claude/CLAUDE.md`. Runner: Vitest (`npm test`).
- Route: delegated direct (writer trigger: 2+ non-trivial files) via one forked writer, started after `mock-ai-provider` completes (it moves `circuit-breaker-ai-provider.ts` and edits the resilience contract, config, and composition root).
- Commits: blocked. Not a git repository yet.
- RDD assessment: not run. No work-unit commit exists.
- Delivery: forecast ~650 authored changed lines; strategy pending until a repository exists.
- Engram mirror `odd/circuit-breaker/tasks`: PENDING. Engram MCP failed to connect this session.

## Tasks

- [x] T1 Contract: options (`cooldownMs`, `classifyError`, `onStateChange`), `CircuitOpenError`, validation (TDD for validation)
- [x] T2 State machine: CLOSED/OPEN/HALF_OPEN transitions, threshold, reset, cooldown boundary (TDD with fake clock)
- [x] T3 Concurrency: generation guard, single probe, ignored errors, listener safety (TDD with deferred operations)
- [x] T4 `CircuitBreakerAiProvider` + application `ai-fallback.ts` (TDD with `MockAiProvider`)
- [x] T5 Config rename, staged `env.example`, composition-root wiring with transition logging, smoke tests
- [x] T6 `docs/circuit-breaker.md` (state table, request-level contract, concurrency rules, third-request definition); full `npm run check` and `npm run build`

## Acceptance criteria

- Every test-plan item passes; `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.
- `shared/resilience` has no feature, Express, logger, or `setTimeout`/`setInterval` usage (Grep).
- No dependency added to `package.json`.

## Progress and evidence

Baseline before writing: `npm run check` green, 17 files, 356/356 tests.

### T1 Contract (route: delegated writer)

- RED: `npx vitest run test/shared/resilience/consecutive-failures-circuit-breaker.test.ts` → 9 failed, 3 passed (validation missing; initial state and `CircuitOpenError` already held).
- GREEN: same command → 12/12. `npm run typecheck` pass; ESLint on touched files clean.
- `resetTimeoutMs` renamed to `cooldownMs` in the contract; composition root maps the old config field until T5 renames it.
- Validation throws `RangeError`, matching `MockAiProvider`'s option validation.
- Commit: blocked (no git repository).

### T2 State machine (route: delegated writer)

- RED: 17 new tests failed against the stub (29 total, 12 passing from T1).
- GREEN: 29/29 after implementing lazy transitions with the fake clock; `npm run typecheck` pass; ESLint clean.
- Deliberately minimal: no generation guard, single-probe flag, error classification, or listener isolation yet, so T3 starts from a genuine RED.
- An operation that throws synchronously counts as a failure (the private `run` is `async`, so the throw becomes a rejection).
- Commit: blocked (no git repository).

### T3 Concurrency (route: delegated writer)

- RED: 11 new tests; 8 failed (single probe ×2, burst cooldown extension, late outcomes during HALF_OPEN ×2, ignored errors ×2, throwing listener). 3 passed already because T2 never closed from OPEN, counted in completion order by construction, and had no classifier to throw.
- GREEN: 40/40 after adding the generation guard, `probeInFlight`, the classifier (a throwing classifier counts as failure), and listener isolation. Two `no-confusing-void-expression` lint errors in the new test fixed; ESLint and typecheck clean.
- Amendment: a classifier that throws is treated as `failure` (safer than hiding a provider failure); added to the test plan.
- Commit: blocked (no git repository).

### T4 Adapter and fallback (route: delegated writer)

- RED: `ai-fallback.test.ts` failed (module missing); `circuit-breaker-ai-provider.test.ts` 8/8 failed against the stub.
- GREEN: 17/17 (9 fallback, 8 adapter). `npm run typecheck` pass; ESLint clean.
- The 4th call after three `failFirst(3)` failures rejects `CIRCUIT_OPEN` in under 50 ms with the mock configured at `delayMs: 2000`; the spied delay ran exactly 3 times; the error's `cause` is the `CircuitOpenError`.
- `classifyAiProviderError` lives next to the adapter (infrastructure knows both the breaker vocabulary and the application errors) and is shared by the composition root and tests.
- `resolveFallback` returns `{ reason: AiProviderFailureReason, reply }`, including `TIMEOUT`; `InquiryResult` and the presenter are untouched (open item below).
- Commit: blocked (no git repository).

### T5 Config and wiring (route: delegated writer)

- RED: 9 failed (config defaults/explicit values, old-variable test, 4 cooldown validations; `buildAiProvider` missing ×2). Threshold validation cases already passed (existing rule).
- GREEN: 54/54 across `app-config.test.ts` and `composition-root.test.ts`; `npm run typecheck` pass; `eslint src test` clean.
- `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` → `CIRCUIT_BREAKER_COOLDOWN_MS` (`config.circuitBreaker.cooldownMs`); the old variable is ignored.
- Amendment: the AI provider chain is built by an exported `buildAiProvider(config, logger, clock?)` called once from `compose()`, so the shared breaker and its transition logging are testable without exposing internals. Logged as `AI provider circuit state changed` with `{ circuit: { from, to } }`: `warn` on OPEN, `info` otherwise; a test asserts the prompt never reaches the logs.
- Staged scratchpad `env.example` updated (project `.env*` untouched).
- Commit: blocked (no git repository).

### T6 Docs and full verification (route: delegated writer)

- `docs/circuit-breaker.md` written (responsibilities, state table, request-level contract with the third-request definition, fail-fast guarantee, concurrency rules, failure classification, configuration, wiring, limitations). `docs/ai-provider.md` updated: breaker no longer "pending", demo recipe uses `CIRCUIT_BREAKER_COOLDOWN_MS`.
- `npm run check` (typecheck, lint, test): exit 0, 20 files, 423/423 tests (67 new; 356 before).
- `npm run build`: exit 0.
- Grep: `src/shared/resilience/` has no feature, `express`, pino/logger, `console`, `setTimeout`, `setInterval`, or `process` usage. `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` appears only in the removal test and the docs rename note. `package.json` dependencies unchanged.
- Boot: `dist/main.js` with a generated key and `PORT=3999` → `GET /health` 200 `{"status":"ok"}`; process stopped, port free.
- Commit: blocked (no git repository).

## Open items for the use case slice

- Wire `resolveFallback` in `ProcessSecureInquiry`: every `AiProviderUnavailableError` becomes a `FALLBACK` result with `SERVICE_BUSY_REPLY`; `AiRequestCancelledError` and unknown errors are rethrown.
- Decide how `TIMEOUT` surfaces: `FallbackReason` (application) is still `'CIRCUIT_OPEN' | 'PROVIDER_ERROR'`, while `resolveFallback` can return `TIMEOUT`. Either add `TIMEOUT` to `FallbackReason` and the presenter contract, or map it to `PROVIDER_ERROR` in the use case.
- Add the HTTP-level test: with `AI_PROVIDER_FAILURES=first:3`, requests 1–3 return `DEGRADED`/`PROVIDER_ERROR`, request 4 returns `DEGRADED`/`CIRCUIT_OPEN` in milliseconds.
- Optional: expose the breaker state on `/health` for the demo.

## Next step

Use case slice (audit repository + orchestration), then wire the fallback end to end.
