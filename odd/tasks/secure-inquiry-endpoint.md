# Feature: secure-inquiry-endpoint

## Objective

Implement `POST /secure-inquiry` end to end: thin Express controller, `ProcessSecureInquiry` use case orchestrating sanitize → encrypt → audit (revision 1) → AI provider through timeout and circuit breaker → audit (revision 2) → response, with a consistent JSON schema, correct status codes, centralized error handling, and documented audit behavior for every outcome.

## Problem / Why

All building blocks exist (sanitizer, encryption, pseudonymizer, audit store, mock provider, timeout, breaker, fallback), but the use case still throws `NotImplementedError` and a valid request returns 501.

## Scope

- In: use case orchestration, `InquiryResult`/`AuditOutcome` contract updates, `AuditFailureReporter` port and adapter, thin controller with abort-on-disconnect, presenter, error-handler fixes, composition-root test overrides, use case unit tests, HTTP integration tests with real components, `docs/secure-inquiry-api.md`.
- Out: Docker packaging, README, health-endpoint circuit state, authentication, rate limiting.

## Constraints

- Business logic only in the use case; the route handler parses, delegates, presents.
- Responses never contain stack traces, ciphertext, IV, tag, keys, `userRef`, or the original message; logs never contain request bodies or sensitive values.
- No new dependencies. Do not create or edit `.env*` files in the project; update only the staged scratchpad `env.example` if configuration changes.

## Design

### Use case `ProcessSecureInquiry.execute(command, options?)`

`command = { userId, message }`, `options = { signal?: AbortSignal }`.

1. `sanitizer.sanitize(message)` → `{ text, findings }`.
2. `auditId = ids.next()`, `createdAt = clock.now()`, `userRef = pseudonymizer.pseudonymize(userId)`.
3. `encryptedMessage = encryption.encrypt(message, auditAssociatedData(auditId, userRef))`.
4. Append revision 1 (`PENDING`). On failure the `AuditPersistenceError` propagates and the provider is never called.
5. `ai.reply(text, { signal })`:
   - success → outcome `COMPLETED`, result `AI_PROVIDER` with the reply;
   - `AiProviderUnavailableError` → `resolveFallback` → outcome `PROVIDER_FAILURE` / `PROVIDER_TIMEOUT` / `CIRCUIT_OPEN_FALLBACK`, result `FALLBACK` with `reason` and `SERVICE_BUSY_REPLY`;
   - `AiRequestCancelledError` → outcome `CANCELLED`, rethrow;
   - any other error → outcome `INTERNAL_ERROR`, rethrow.
6. Append revision 2 with the outcome. If it fails, call `AuditFailureReporter.outcomeNotRecorded({ auditId, outcome, cause })` and still return the result (revision 1 already audits the inquiry; the provider call already happened, and failing the response would only trigger client retries and duplicate provider calls). Never silent: the reporter logs at `error`.

Contract updates: `FallbackReason` gains `TIMEOUT`; `AuditOutcome` gains `INTERNAL_ERROR`; `inquiryId` in results and responses equals `auditId`.

`AuditFailureReporter` is a deliberately narrow application port: it accepts only `auditId`, `outcome`, and `cause`, so it cannot be used to log message content. Its adapter logs `auditId`, `outcome`, and the cause's error code/name, never the cause message of unknown errors.

### HTTP

- Thin controller: `requireJson` → `validateBody` → create an `AbortController` aborted on `res.on('close')` when `!res.writableFinished` (not `req.on('close')`, which fires once the body is read) → `useCase.execute` → `presenter` → `200`.
- Response schema (success and fallback share it):

```json
{ "requestId": "…", "inquiryId": "…", "status": "COMPLETED | DEGRADED", "source": "AI_PROVIDER | FALLBACK",
  "reason": "PROVIDER_ERROR | TIMEOUT | CIRCUIT_OPEN (fallback only)", "sanitizedMessage": "…", "reply": "…" }
```

- Error schema: `{ "requestId": "…", "error": { "code": "…", "message": "…", "details": [ … ] } }`.

| Status | Code | When |
|---|---|---|
| 200 | — | `COMPLETED` or `DEGRADED` fallback (contract from the design phase) |
| 400 | `VALIDATION_ERROR` / `MALFORMED_JSON` / `BAD_REQUEST` | schema violation (missing, wrong type, empty, blank, unknown field, too long) / invalid JSON / other parser 4xx |
| 413 | `PAYLOAD_TOO_LARGE` | body over `REQUEST_BODY_LIMIT_BYTES` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | not JSON, or an unsupported charset (including `utf-7`, which currently yields 500: fix) |
| 404 | `NOT_FOUND` | unknown route |
| 500 | `AUDIT_UNAVAILABLE` | revision 1 could not be persisted (provider not called) |
| 500 | `INTERNAL_ERROR` | anything unexpected; generic message, no stack |

- Error handler: `AiRequestCancelledError` with a destroyed socket or finished response → no response, `info` log only; otherwise `499 REQUEST_CANCELLED`. Remove the `NOT_IMPLEMENTED`/501 mapping and `NotImplementedError` if nothing uses them anymore.
  - Amended: the response code is `AI_REQUEST_CANCELLED` (the error's own code); error mappings set status and message, never rename codes.
  - Amended: only `charset=utf-8` (case-insensitive, optionally quoted) is accepted; `utf8` is rejected because body-parser itself refuses charsets without the `utf-` prefix, and accepting it would require rewriting headers.

### Audit behavior per scenario (documented contract)

| Scenario | Revision 1 `PENDING` | Provider called | Revision 2 outcome | HTTP response |
|---|---|---|---|---|
| Invalid body | no | no | — | 400 / 413 / 415 |
| Revision 1 write fails | fails | no | — | 500 `AUDIT_UNAVAILABLE` |
| Provider success | yes | yes | `COMPLETED` | 200 `COMPLETED` |
| Provider failure | yes | yes | `PROVIDER_FAILURE` | 200 `DEGRADED` / `PROVIDER_ERROR` |
| Provider timeout | yes | yes (aborted) | `PROVIDER_TIMEOUT` | 200 `DEGRADED` / `TIMEOUT` |
| Circuit open | yes | no | `CIRCUIT_OPEN_FALLBACK` | 200 `DEGRADED` / `CIRCUIT_OPEN`, milliseconds |
| Client disconnects | yes | yes (aborted) | `CANCELLED` | none (connection gone) |
| Unexpected error | yes | maybe | `INTERNAL_ERROR` | 500 `INTERNAL_ERROR` |
| Revision 2 write fails | yes | yes | missing, reported at `error` | the response the outcome dictates |

The 200 for fallbacks keeps the contract documented since the design phase; switching circuit-open responses to `503` + `Retry-After` is a presenter-only change if ever required, and is listed as an alternative in the docs.

### Composition root and test injection

`compose(config, logger, overrides?)` accepts optional `clock`, `idGenerator`, `aiOutcomeSchedule`, `aiDelay`, and `auditFileSystem` overrides, so integration tests run the real sanitizer, encryption, pseudonymizer, JSONL repository (temp directory), timeout, breaker, and mock provider with fast, deterministic time and injected failures. Production wiring is unchanged when no overrides are given.

## Test plan

Use case unit tests (fakes):

- Order: sanitize → encrypt (original plaintext, associated data from `[auditId, userRef]`) → revision 1 → provider (receives only the sanitized `RedactedText`) → revision 2.
- Revision 1 failure: `AuditPersistenceError` propagates; provider never called.
- Outcome mapping for success, `PROVIDER_ERROR`, `TIMEOUT`, `CIRCUIT_OPEN`, cancellation (rethrown), unexpected error (rethrown).
- Revision 2 failure: result still returned; reporter called once with `auditId` and outcome.
- Signal is forwarded to the provider.

HTTP integration tests (supertest, real components via `compose` overrides, temp audit dir, silent or captured logger):

- Valid request: 200 `COMPLETED`, `reply` is `Generated Answer: <sanitized>`, `X-Request-Id` set, `inquiryId` present; audit file holds revisions `PENDING` then `COMPLETED`; the decryptor recovers the original from the stored record.
- PII redaction: email + card + SSN message; a spy around the mock provider sees only labels; neither the response nor the audit file nor captured logs contain the original values or the raw `userId`.
- Invalid bodies: missing fields, wrong types, empty and whitespace-only strings, unknown field, 5,001-character message → 400 with `details`; body over the limit → 413; malformed JSON → 400; `text/plain` → 415; `charset=utf-7` → 415. None writes an audit record or calls the provider.
- Provider failure: `first:1` → 200 `DEGRADED` / `PROVIDER_ERROR` with `SERVICE_BUSY_REPLY`; audit outcome `PROVIDER_FAILURE`.
- Timeout: provider delay above the timeout → `TIMEOUT`, audit `PROVIDER_TIMEOUT`.
- Circuit open: `always` → requests 1–3 `PROVIDER_ERROR`; request 4 `CIRCUIT_OPEN` well under the provider delay; provider invoked exactly 3 times; audit `CIRCUIT_OPEN_FALLBACK`; after advancing the fake clock past the cooldown with a recovering schedule, the probe returns `COMPLETED`.
- Persistence failures: injected `ENOSPC` on revision 1 → 500 `AUDIT_UNAVAILABLE`, provider not called; injected failure on revision 2 only → 200 response, captured `error` log with `auditId`, no content.
- Unexpected error → 500 `INTERNAL_ERROR` with a generic message.
- Leakage sweep: no response body in the suite contains `stack`, stack frames, `ciphertext`, `authTag`, `iv`, `userRef`, key material, or the original message.
- Client disconnect (real server on an ephemeral port, request destroyed mid-delay): audit outcome `CANCELLED`; breaker failure count unchanged.

## Workflow settings

- TDD: strict, ON. Source: global `~/.claude/CLAUDE.md`. Runner: Vitest (`npm test`).
- Route: delegated direct (writer trigger: 2+ non-trivial files) via one forked writer, started after `audit-store` completes (shared composition root, `main`, presenter, audit contracts, and test runs).
- Commits: blocked. Not a git repository yet.
- RDD assessment: not run. No work-unit commit exists.
- Delivery: forecast ~900 authored changed lines; strategy pending until a repository exists.
- Engram mirror `odd/secure-inquiry-endpoint/tasks`: PENDING. Engram MCP failed to connect this session.

## Tasks

- [x] T1 Contracts: `FallbackReason` + `TIMEOUT`, `AuditOutcome` + `INTERNAL_ERROR`, `AuditFailureReporter` port, use case command/options (plus the pino reporter adapter, pulled forward from T4 so the build stays green between tasks)
- [x] T2 Use case orchestration (unit TDD with fakes)
- [x] T3 HTTP: thin controller with abort-on-disconnect, presenter, error-handler cancellation mapping, `utf-7` → 415 fix, remove unused 501 path (TDD)
- [x] T4 Composition root: overrides, pino `AuditFailureReporter` adapter, wiring; smoke tests updated (valid POST → 200)
- [x] T5 HTTP integration tests with real components (full test plan)
- [x] T6 `docs/secure-inquiry-api.md` (request, response and error schemas, status table, audit behavior table, fallback status rationale and 503 alternative); full `npm run check`, `npm run build`, and a booted demo

## Acceptance criteria

- Every test-plan item passes; `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.
- The route handler contains no business logic (only parse, delegate, present).
- Booted `dist/main.js` (real 2-second delay, `AI_PROVIDER_FAILURES=first:3`): requests 1–3 return `DEGRADED`/`PROVIDER_ERROR` after ~2 s, request 4 returns `CIRCUIT_OPEN` in milliseconds; with `never`, a PII message returns `COMPLETED` with labels.
- No dependency added to `package.json`.

## Progress and evidence

### Baseline

- `npm run check`: exit 0, 497 passed + 1 skipped (Windows-only mode assertion) across 27 files.

### `charset=utf-7` root cause (investigated before T3)

- A probe through the real app showed `utf-7` is not a server error: body-parser 2's JSON parser accepts any `utf-*` charset iconv-lite can decode (`utf-7`, `utf-16`, `utf-32`), so the request was decoded and reached the use case. `utf-16`/`utf-32` usually fail as `MALFORMED_JSON`; `utf-9`/`utf-x` already return 415.
- The 500 the scaffold saw came from its test double: `buildApp()` defaults to a bare `vi.fn()` that resolves `undefined`, and the presenter threw on it.
- Real defect: the API accepts non-UTF-8 JSON (RFC 8259 §8.1 requires UTF-8 between systems), and UTF-7 (`+...-` shift sequences) is a classic filter-evasion encoding. Fix in T3: accept only `application/json` with no charset or `utf-8`, reject everything else with 415 before the body is parsed.

### T1 Contracts (route: delegated writer)

- `FallbackReason` gains `TIMEOUT`; `AUDIT_OUTCOMES` gains `INTERNAL_ERROR`; new `AuditFailureReporter` port; `ProcessSecureInquiry.execute(command, { signal })` and a new `auditFailureReporter` dependency (body still `NotImplementedError`).
- `LoggingAuditFailureReporter` pulled forward from T4 so the composition root compiles: RED `npx vitest run test/secure-inquiry/infrastructure/logging-audit-failure-reporter.test.ts` (module missing, no tests), GREEN 3/3.
- `npm run typecheck`, `npx eslint src test`: pass; `npm test`: 500 passed + 1 skipped.
- Commit: blocked (no git repository).

### T2 Use case (route: delegated writer)

- RED: `npx vitest run test/secure-inquiry/application/process-secure-inquiry.test.ts`: 15/15 failed (`NotImplementedError`).
- GREEN: same command, 15/15 passed. Covers operation order, associated data, sanitized-only prompt with signal forwarding, full v1 revisions, raw `userId` never stored, fail-closed revision 1, the three fallback reasons and their audit outcomes, cancellation and unexpected errors rethrown unchanged, and revision-2 failures reported without changing the response or the original error.
- Composition-root smoke test now runs the real use case (temp audit file, zero delay): expects 200 `COMPLETED` instead of 501.
- `npm test`: 515 passed + 1 skipped; `npm run typecheck`, `npx eslint src test`: pass; no `./data` directory created.
- Commit: blocked (no git repository).

### T3 HTTP (route: delegated writer)

- RED: `npx vitest run test/app.test.ts`: 10 failed / 25 passed (signal not forwarded; `utf-7`/`UTF-7`/`utf-16`/`utf-32` decoded instead of 415; no 499 mapping; disconnect never aborted; unknown route parsed bodies).
- GREEN: `npx vitest run test/app.test.ts test/logging-hygiene.test.ts`: 39/39.
- Changes: `requireJson` parses `Content-Type` itself and accepts only `application/json` with no charset or `utf-8`; JSON parsing moved from app-level to the route, after `requireJson` (unknown routes now return 404 without parsing); `clientDisconnectSignal(res)` uses `res.once('close')` + `!res.writableFinished`; error handler skips writing and logs `info` when the socket is destroyed; `AI_REQUEST_CANCELLED` → 499 (feature mapping); `NOT_IMPLEMENTED` mapping and `NotImplementedError` removed (no remaining users).
- `npm run check`: exit 0, 526 passed + 1 skipped.
- Commit: blocked (no git repository).

### T4 Composition root (route: delegated writer)

- RED: `npx vitest run test/composition-root.test.ts`: 2 failed / 10 passed (overrides ignored: real 2 s delay, default audit path). That RED run wrote `./data/audit.jsonl` through the ignored override; the directory was deleted and the test now always uses a temp path.
- GREEN: same command, 12/12.
- `compose(config, logger, overrides?)` accepts `clock`, `idGenerator`, `aiOutcomeSchedule`, `aiDelay`, `auditFileSystem`; `buildAiProvider(config, logger, { clock, schedule, delay })` replaces the positional clock. Production wiring is unchanged without overrides. The reporter adapter (T1) is wired; a test proves a failed revision-2 write is logged at `error` with `auditId` and `rootCode: ENOSPC` while the response stays 200.
- `npm run check`: exit 0, 528 passed + 1 skipped; no `./data` directory.
- Commit: blocked (no git repository).

### T5 Integration tests (route: delegated writer)

- `test/secure-inquiry.integration.test.ts`: 25 tests through `compose()` with the real sanitizer, AES-GCM, HMAC pseudonymizer, JSONL store (temp directory), timeout, breaker, and mock provider; fake clock; provider calls counted through the injected delay.
- Covered: valid request (both revisions, decryption round trip); PII across response, audit file, logs, and decryption; 11 invalid bodies + 413 + malformed JSON + `text/plain` + `utf-7`, none audited or sent to the provider; `PROVIDER_ERROR`, `TIMEOUT`, unexpected error (generic 500, `INTERNAL_ERROR` audited); breaker 1–3 ≥ 250 ms, 4th `CIRCUIT_OPEN` < 150 ms with 3 provider calls, recovery after the cooldown; revision-1 failure (injected `ENOSPC` and a real directory path) → 500 with no provider call; revision-2 failure → 200 plus an `error` log without content; client disconnect → `CANCELLED`, and with threshold 1 the next request still completes.
- Passed 25/25 on the first run, because they integrate behavior built in T2–T4. To show they are not vacuous, two temporary mutations (audit after egress; never abort on disconnect) made 3 of them fail; both mutations reverted (`rg MUTATION` empty).
- Stability: `test/secure-inquiry.integration.test.ts` + `test/app.test.ts` run 3 more times, 60/60 each.
- `npm run check`: exit 0, 553 passed + 1 skipped across 30 files; no `./data` directory.
- Commit: blocked (no git repository).

### T6 Docs and verification (route: delegated writer)

- New `docs/secure-inquiry-api.md` (request rules, success/fallback/error schemas, status table, processing order, audit behavior table, revision-2 failure policy, 200-vs-503 rationale, cancellation). Updated `docs/ai-provider.md` (demo no longer pending), `docs/circuit-breaker.md` (`TIMEOUT` reason, link to the API doc), `docs/audit-store.md` (`INTERNAL_ERROR` outcome, revision-2 failure policy).
- `npm run typecheck`, `npm run lint`, `npm test` (553 passed + 1 skipped, 30 files), `npm run build`: all exit 0.
- Booted `dist/main.js` (two generated keys, `PORT=3999`, temp audit file, real 2000 ms delay, `NODE_ENV=production`):
  - `never`: PII message → 200 `COMPLETED` in 2040 ms with all three labels; audit `rev1:PENDING, rev2:COMPLETED`; the original values appear in neither the audit file, the response, nor the server output.
  - `first:3`: requests 1–3 → 200 `DEGRADED/PROVIDER_ERROR` in 2038, 2023, 2022 ms; request 4 → 200 `DEGRADED/CIRCUIT_OPEN` in 8 ms; final outcomes `PROVIDER_FAILURE ×3, CIRCUIT_OPEN_FALLBACK`; server warnings: failure injection enabled, circuit state changed.
  - Both processes stopped; port 3999 free; temp files removed.
- `package.json` dependencies unchanged (express, pino, zod); no `./data` directory; no `NotImplementedError` or mutation leftovers.
- Commit: blocked (no git repository).

## Next step

Feature complete. Open items for the Docker/README slice: named volume and non-root write permissions for `AUDIT_FILE_PATH`; `.env.example` still blocked by the permission rule (staged copy in the scratchpad, unchanged by this slice); README demo recipe (curl for PII, `first:3` breaker sequence); optional circuit state on `/health`; optional 503 + `Retry-After` presenter switch if the contract changes.
