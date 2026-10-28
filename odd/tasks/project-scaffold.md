# Feature: project-scaffold

## Objective

Initial, compiling project structure for Guardian Integration Gateway: strict TypeScript, Clean Architecture layers (domain, application, infrastructure, presentation), configuration management, centralized error handling, structured logging, request validation, contracts for every port, and an explicit composition root. No business logic yet.

## Problem / Why

The business slices (sanitizer, encryption, circuit breaker, audit store, use case orchestration) need a stable, enforced architecture to land on, test-first.

## Scope

- In: npm scripts, tsconfig (typecheck + build), ESLint with layer-boundary rules, Vitest, `.gitignore`, `.env.example`, shared config/errors/logging/http, domain and application contracts, infrastructure stubs, presentation for `POST /secure-inquiry` (validation only), composition root, process bootstrap.
- Out: redaction rules, AES-256-GCM implementation, circuit breaker state machine, JSONL persistence, use case orchestration, Docker.

## Constraints

- Domain and application must not import Express, fs, crypto, pino, zod, or read `process.env` (ESLint-enforced).
- Only necessary dependencies.
- No request bodies or PII in logs or error responses.
- English artifacts.

## Workflow settings

- TDD: strict, ON. Source: global `~/.claude/CLAUDE.md` ("Strict TDD Mode: enabled"). Runner: Vitest (`npm test`).
- Route: delegated direct (writer trigger: 2+ non-trivial files) via one forked writer.
- Runtime: Node v24.19.0, npm 11.17.0.
- Commits: blocked. The directory is not a git repository yet; ask the user before `git init`.
- RDD assessment: not run. No work-unit commit exists to assess.
- Delivery: forecast ~1,300 authored changed lines (lockfile excluded). Strategy pending until a repository exists.
- Engram mirror `odd/project-scaffold/tasks`: PENDING. Engram MCP failed to connect this session.

## Tasks

- [x] T1 Tooling: `package.json` scripts and dependencies, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js` with layer boundaries, `vitest.config.ts`, `.gitignore`, `.env.example` (`.env.example` blocked by permission settings, see evidence)
- [x] T2 Shared: `app-config` (TDD), `app-error`, logger with redaction
- [x] T3 Contracts: domain types and interfaces, application ports, errors, use case skeleton, resilience contract, infrastructure stubs
- [x] T4 HTTP: request context, require-json, validate-body, error handler, 404, health, secure-inquiry schema/presenter/routes (TDD via supertest)
- [x] T5 Composition root and `main` bootstrap (TDD smoke), full verification

## Acceptance criteria

- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` pass.
- `node dist/main.js` without an encryption key exits non-zero with a configuration error that never prints secret values.
- The boundary lint rule demonstrably rejects a domain-to-Express import.
- `POST /secure-inquiry`: invalid body returns 400 `VALIDATION_ERROR`; valid body returns 501 `NOT_IMPLEMENTED` until the use case slice lands.
- Logs never contain request bodies, including malformed JSON payloads.

## Progress and evidence

### T1 Tooling (route: delegated writer)

- Installed: express 5.3.0, zod 4.6.7, pino 10.4.0; dev: typescript 6.0.3, tsx 4.23.15, @types/node 24.19.2, @types/express 5.0.6, vitest 5.0.5, supertest 7.3.1, @types/supertest 7.2.1, eslint 10.13.0, @eslint/js 10.0.1, typescript-eslint 8.72.1.
- TypeScript pinned to `~6.0.3`: latest is 7.0.2, but typescript-eslint 8.72.1 peers `typescript >=4.8.4 <6.1.0`.
- `engines.node` set to `>=22.13` (ESLint 10 requires `^22.13.0 || >=24`).
- `npm run typecheck` and `npm run lint`: pass (exit 0).
- `.env.example`: Write denied by permission settings (`.env*` deny rule). Content staged in the session scratchpad as `env.example`; not bypassed.
- Commit: blocked (no git repository).

### T2 Shared (route: delegated writer)

- RED: `npx vitest run test/shared/config/app-config.test.ts` failed (module `app-config` missing, 1 file failed).
- GREEN: same command, 18/18 passed.
- `npm run typecheck`, `npm run lint`: pass.
- Commit: blocked (no git repository).

### T3 Contracts (route: delegated writer)

- Types, interfaces and NotImplemented stubs only; no tests needed (no behavior).
- `CircuitBreakerOptions` gained `callTimeoutMs` (wired from `AI_PROVIDER_TIMEOUT_MS`); the breaker takes a structural `TimeSource` so `shared/resilience` never imports a feature port.
- Boundary proof: temporary probes produced 6 `no-restricted-*` errors (domain → express, domain → node:fs, domain → application, domain → `process`; application → infrastructure, application → shared/logging). Application → domain import allowed. Probes deleted; `npm run lint` exit 0.
- `npm run typecheck`, `npm run lint`: pass.
- Commit: blocked (no git repository).

### T4 HTTP (route: delegated writer)

- RED: `npx vitest run test/app.test.ts test/logging-hygiene.test.ts` failed (module `src/app.js` missing, 2 files failed).
- First GREEN run: 27/28. The `charset=utf-7` case returned 500 because body-parser accepts any `utf-*` charset (iconv decodes UTF-7), so the request reached the bare fake. Test corrected to `charset=iso-8859-1`, which body-parser rejects with `charset.unsupported`.
- GREEN: 28/28 (app 24, logging hygiene 4).
- Verified in `node_modules/body-parser/lib/read.js`: parse failures are created with `{ body: str, type: 'entity.parse.failed' }`, confirming the raw-payload logging risk the error handler guards against.
- `InquiryResult.requestId` renamed to `inquiryId` (audit record id). The response carries both `requestId` (HTTP correlation, equals `X-Request-Id`) and `inquiryId`, so a client-supplied request id never becomes an audit key.
- HTTP status mapping is open for extension: shared codes live in `error-handler.ts`, and the feature contributes `secureInquiryErrorMappings` (AUDIT_UNAVAILABLE), so `shared/http` never imports feature code.
- `npm run typecheck`, `npm run lint`: pass (test bodies typed through an `ErrorEnvelope` helper to satisfy `no-unsafe-*`).
- Commit: blocked (no git repository).

### T5 Composition root and verification (route: delegated writer)

- RED: `npx vitest run test/composition-root.test.ts` failed (module `composition-root` missing).
- GREEN: 3/3 (health 200, invalid body 400, valid body 501 through the real wiring).
- `npm run check` (typecheck + lint + test): exit 0, 4 files, 49/49 tests.
- `npm run build`: exit 0, 39 JS files in `dist/` (one per source file).
- `node dist/main.js` without `AUDIT_ENCRYPTION_KEY`: exit 1, output `Invalid configuration: - AUDIT_ENCRYPTION_KEY: Invalid input: expected string, received undefined` (no stack, no values).
- Boot with a freshly generated key on PORT 3999: `GET /health` 200 `{"status":"ok"}` with `X-Request-Id`; `POST /secure-inquiry` 501 `NOT_IMPLEMENTED` envelope; JSON logs show the listen line, access logs with path/status/duration, and the 501 error. The email in the POST body did not appear in the logs. Process stopped afterwards.
- Commit: blocked (no git repository).

### Acceptance criteria status

- typecheck, lint, test, build: met.
- Fail-fast boot without key, no secret values printed: met.
- Boundary lint rule rejects domain → Express: met (T3 proof).
- `POST /secure-inquiry`: 400 on invalid body, 501 on valid body: met.
- Logs never contain request bodies, including malformed JSON: met (logging-hygiene tests).
- Open: `.env.example` not written (permission deny rule on `.env*`); content staged in the session scratchpad as `env.example`.

## Next step

User decisions: create `.env.example` from the staged content (or allow the write), then `git init` + first work-unit commit. Then slice 2: `RuleBasedMessageSanitizer` with redaction rules, test-first.
