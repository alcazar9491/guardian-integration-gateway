# Feature: circuit-breaker-e2e

## Objective

A deterministic end-to-end test proving the circuit breaker requirement through `POST /secure-inquiry` with the real composition (sanitizer, AES-GCM, HMAC pseudonymizer, JSONL audit store, timeout, breaker, mock provider with its real 2-second delay), plus the fixes it exposes.

## Known gaps before writing the test

- `SERVICE_BUSY_REPLY` is `"Service Busy: the assistant is temporarily unavailable. Please try again later."`; the requirement asks for the exact fallback message `"Service Busy"`.
- The breaker's `consecutiveFailures` is private and `compose()` does not expose the breaker, so the failure counter cannot be observed.

## Design

- Observability: `CircuitBreaker` gains a read-only `consecutiveFailures`; `compose()` additionally returns a read-only `circuit` view (`state`, `consecutiveFailures`). No HTTP change.
- Determinism: an injected manual clock drives the cooldown (`advance(ms)`); requests are awaited sequentially; the only real waiting is the provider's own 2-second delay, which is the behavior under test. Provider invocations are counted by wrapping the real abortable delay passed as the `aiDelay` override.
- Scenario: CLOSED/0 → three failing requests (`failFirst(3)`) each ~2 s `DEGRADED`/`PROVIDER_ERROR`, counter 1, 2, then OPEN/3 → fourth request timed, `CIRCUIT_OPEN`, reply exactly `"Service Busy"`, provider calls unchanged → cooldown − 1 ms still fails fast → +1 ms the probe succeeds, `COMPLETED`, CLOSED/0 → transition logs in order → audit assertions.
- Audit policy: every inquiry has exactly revision 1 `PENDING` and revision 2 with its outcome (`PROVIDER_FAILURE` ×3, `CIRCUIT_OPEN_FALLBACK` ×2, `COMPLETED` ×1); response `inquiryId`s match `auditId`s; the raw file never contains the original message, its PII values, or the raw `userId`; each record decrypts to the original only through the authorized decryptor with its associated data; zero invalid lines.

## Workflow settings

- TDD: strict, ON (global CLAUDE.md), runner Vitest.
- Route: delegated direct, one writer.
- Git: repository has no commits yet (the user's suggested commit series is pending review), so no commit is made; changed files are listed for the user's series.
- Engram mirror `odd/circuit-breaker-e2e/tasks`: PENDING (Engram MCP unavailable).

## Tasks

- [x] T1 RED: write `test/e2e/circuit-breaker.e2e.test.ts` (full scenario) and observe it fail
- [x] T2 Fix: exact `"Service Busy"` reply; update every test, doc, and README reference to the old text
- [x] T3 Fix: read-only `consecutiveFailures` on the breaker and a read-only `circuit` view from `compose()` (unit tests for the getter)
- [x] T4 GREEN: E2E passes three consecutive runs; full `npm run check` and `npm run build`; report measured values

## Acceptance criteria

- The E2E test passes three times in a row with identical assertions.
- The fourth request takes well under 2 s (asserted bound 500 ms) and leaves the provider call count at 3.
- `npm run check` and `npm run build` exit 0.

## Progress and evidence

Baseline before any change: `npm run check` exit 0, 567 passed + 2 skipped.

- T1 (route: delegated writer). E2E written first. RED 1: `TypeError: Cannot read properties of undefined (reading 'state')` at `readCircuit` (no `circuit` on `compose()`); typecheck `TS2339: Property 'circuit' does not exist on type 'ComposedApplication'`. Measured values are reported through Vitest's `annotate` API (shown on failure, or with `--reporter=verbose`).
- T3 (done before T2 so the E2E could expose the reply defect on its own). Unit RED: `cannot be changed from outside` failed (`expected function to throw an error, but it didn't`: the private field was writable at runtime) and typecheck `TS2341 ... is private`. Fix: `CircuitStatus` (`state`, `consecutiveFailures`) in `shared/resilience/circuit-breaker.ts`, `CircuitBreaker extends CircuitStatus`; the breaker's counter is now a private `failureCount` behind a getter; `buildAiProvider()` returns `{ aiProvider, circuit }` and `compose()` additionally returns a frozen, getter-only `circuit` view (existing fields unchanged, no HTTP change). GREEN: breaker, composition-root and AI provider tests 111 passed; `tsc --noEmit` exit 0. New tests: 4 in `consecutive-failures-circuit-breaker.test.ts` (1, 2, holds 3 while OPEN, 0 on close; 0 after a CLOSED success; holds 3 after a failed probe; not writable), 1 in `composition-root.test.ts` (view follows failures, has only `state` and `consecutiveFailures`, rejects assignment).
- E2E RED 2 after T3: request 1 `reply` was `"Service Busy: the assistant is temporarily unavailable. Please try again later."`, expected `"Service Busy"` (measured 2041 ms, provider calls 1, circuit CLOSED/1).
- T2. Root cause of the slip: `ai-fallback.test.ts` only asserted the prefix (`toMatch(/^Service Busy/)`). Tightened to `toBe('Service Busy')`; unit RED `expected 'Service Busy: the assistant is tempor…' to be 'Service Busy'`. Fix: `SERVICE_BUSY_REPLY = 'Service Busy'` in `application/ai-fallback.ts`. Old text replaced in `README.md` (fallback example) and `docs/secure-inquiry-api.md` (fallback example); `docs/circuit-breaker.md` now states the exact value, the read-only `circuit` view, and the E2E proof. Other tests already use the constant or the literal `'Service Busy'`. No old text remains outside `odd/` history. GREEN: application, presentation and integration tests 51 passed; E2E passed (8154 ms); ESLint on changed files exit 0.

- T4. `npx vitest run test/e2e/circuit-breaker.e2e.test.ts --reporter=verbose` three times in a row: all passed, exit 0, test 8161 / 8138 / 8155 ms (wall 8.51 / 8.48 / 8.56 s). Measured per run (ms):

  | Request | Result | Run 1 | Run 2 | Run 3 | Provider calls | Circuit after |
  |---|---|---|---|---|---|---|
  | 1 | `DEGRADED`/`PROVIDER_ERROR`, `"Service Busy"` | 2052 | 2044 | 2048 | 1 | CLOSED/1 |
  | 2 | `DEGRADED`/`PROVIDER_ERROR`, `"Service Busy"` | 2019 | 2016 | 2020 | 2 | CLOSED/2 |
  | 3 | `DEGRADED`/`PROVIDER_ERROR`, `"Service Busy"` | 2022 | 2020 | 2026 | 3 | OPEN/3 |
  | 4 | `DEGRADED`/`CIRCUIT_OPEN`, `"Service Busy"` | 10 | 10 | 9 | 3 | OPEN/3 |
  | 5 (cooldown − 1 ms) | `DEGRADED`/`CIRCUIT_OPEN`, `"Service Busy"` | 10 | 9 | 13 | 3 | OPEN/3 |
  | 6 (+1 ms, probe) | `COMPLETED`/`AI_PROVIDER`, `Generated Answer: <sanitized>` | 2023 | 2012 | 2016 | 4 | CLOSED/0 |

  Transition logs in order: CLOSED→OPEN (warn), OPEN→HALF_OPEN (info), HALF_OPEN→CLOSED (info); no log line contains the message, the email, the card (with or without spaces), the SSN, or the raw `userId`. Audit: 12 lines, 0 invalid (`parseAuditLine` and `JsonlAuditRepository.scan()`), each response `inquiryId` has exactly revision 1 `PENDING` and revision 2 `PROVIDER_FAILURE` ×3, `CIRCUIT_OPEN_FALLBACK` ×2, `COMPLETED` ×1 in request order; every `sanitizedMessage` is the three labels plus the phrase; one stable `userRef`; the raw file has none of the plaintext values; 12/12 records decrypt to the original with `auditAssociatedData({ auditId, userRef })`, and a freshly generated wrong key fails with `AUTHENTICATION_FAILED` for all 12. No response body contains the message or a PII value.
- `npm run check`: exit 0, 32 files, 573 passed + 2 skipped (baseline 567 + 6 new: 1 E2E, 4 breaker, 1 composition root). `npm run build`: exit 0.
- No other defect exposed. Note: the E2E adds about 8 s of real waiting to `npm test` (full suite 4.1 s → 8.8 s wall).
- Changed files: new `test/e2e/circuit-breaker.e2e.test.ts`; `src/shared/resilience/circuit-breaker.ts`, `src/shared/resilience/consecutive-failures-circuit-breaker.ts`, `src/composition-root.ts`, `src/secure-inquiry/application/ai-fallback.ts`, `test/shared/resilience/consecutive-failures-circuit-breaker.test.ts`, `test/composition-root.test.ts`, `test/secure-inquiry/application/ai-fallback.test.ts`, `README.md`, `docs/circuit-breaker.md`, `docs/secure-inquiry-api.md`, this file.

## Next step

User review and commit (suggested order: breaker status view, exact reply, then the E2E test, which depends on both). Engram mirror `odd/circuit-breaker-e2e/tasks` still PENDING: resync when Engram is reachable.
