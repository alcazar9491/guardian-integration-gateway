# Feature: known-issues-fixes

## Objective

Fix the five issues left open after the full-project review and listed as known issues in the README, each with a regression test that fails first, then update the docs so nothing claims an issue that no longer exists.

## Issues

| ID | Location | Defect | Fix |
|---|---|---|---|
| REL-002 | `src/secure-inquiry/domain/sanitization/detectors/email-detector.ts` | An email whose local part exceeds 64 characters is not redacted at all | Remove the 64-character cap on the local part; the token-start lookbehind keeps matching linear |
| UNICODE-EMAIL | same | Non-ASCII local parts are partially redacted (`müller.hans@example.com` → `mü<REDACTED: EMAIL>`); non-ASCII domains are not redacted (`user@bücher.example`) | Unicode letters and digits (`\p{L}\p{N}`) in the local part, domain labels, TLD, and the token boundary |
| REL-001 | `src/shared/config/app-config.ts` | Whitespace-only numeric env values coerce to 0 (`AI_PROVIDER_DELAY_MS=" "` disables the delay) | Numeric variables must match `^\d+$` before conversion; signs, exponents, hex, decimals, and whitespace are rejected without echoing values |
| REL-003 | `src/shared/http/error-handler.ts`, `test/secure-inquiry.integration.test.ts` | Unexpected 5xx errors are logged with their message (and stack, whose first line repeats it); the integration test never asserts the logs | Log unexpected errors as `{ type, code?, stack frames without the message line }`; never the message or `cause` chain; the test asserts the planted SSN never reaches the logs |
| RISK-003 | `eslint.config.js` | The domain/application boundary is a deny-list: other `node:*` modules, dynamic `import()`, and `globalThis.process` bypass it | Allow-list: only relative imports (the existing relative-path layer rules stay); ban `ImportExpression`; ban `globalThis.process` / `global.process` |

## Constraints

- Strict TDD: every fix starts with a test that fails on the current code.
- No behavior change beyond each fix; no new dependencies.
- Work on branch `fix/review-known-issues`; one Conventional Commit per task, no AI attribution; do not push.

## Workflow settings

- TDD: strict, ON (global CLAUDE.md), runner Vitest.
- Route: delegated direct, one writer.
- RDD: unavailable (`gentle-ai` has no `review` command); delivery `disabled/unmanaged`.
- Engram mirror `odd/known-issues-fixes/tasks`: PENDING (Engram MCP unavailable).

## Tasks

- [x] T1 REL-002 + UNICODE-EMAIL: email detector (RED: 65-character local part, `müller.hans@example.com`, `user@bücher.example`, IDN TLD; keep every existing email test green; adversarial 100k inputs still within bound)
- [x] T2 REL-001: strict integer env parsing (RED: `" "`, `" 5"`, `"1e3"`, `"0x10"`, `"-1"`, `"2.5"` rejected for every numeric variable; error names the variable, never echoes the value)
- [x] T3 REL-003: message-free logging of unexpected errors (RED: integration test asserts the planted SSN is absent from logs; unit test on the error handler: type and a stack frame logged, message and cause absent)
- [x] T4 RISK-003: allow-list boundary rules (prove with temporary probes: `node:http`, `node:child_process`, dynamic `import()`, `globalThis.process.env` all rejected in domain and application; relative imports still allowed; probes removed)
- [x] T5 Docs: `docs/pii-sanitization.md`, `README.md` (Known issues → resolved, Known limitations updated), `odd/reviews/2026-10-27-full-project-review.md` (follow-ups marked fixed); full `npm run check` and `npm run build`

## Acceptance criteria

- Each fix has a regression test that failed before the change.
- `npm run check` and `npm run build` exit 0.
- No document still lists a fixed issue as open.

## Progress and evidence

_Updated after each task. A commit cannot contain its own hash, so each hash is recorded by the next task's update._

- Baseline: `npm run check` exit 0, 573 passed + 2 skipped.
- T1 (route: inline, one source file plus its tests).
  - RED: 14 failures, e.g. `detects the whole address müller.hans@example.com` → `expected [ 'ller.hans@example.com' ] to strictly equal [ 'müller.hans@example.com' ]`; `detects an address whose local part has 65 characters` → `expected [] to strictly equal [ Array(1) ]`; sanitizer `redacts Schreib an müller.hans@example.com!` → received `Schreib an mü<REDACTED: EMAIL>!`.
  - Fix: unbounded local part anchored at a Unicode token start; `\p{L}\p{M}\p{N}` in the local part, domain labels, TLD, and boundary. Combining marks (`\p{M}`) are included so decomposed input (`müller`) and Indic domains (`डाटामेल.भारत`) are matched whole.
  - Changed expectations: `ignores local parts longer than the 64-character limit` became `detects an address whose local part has 65/300 characters`; `josé@ejemplo.com` moved from "documented limitations" to the redacted cases.
  - GREEN: sanitization suites 212 passed; adversarial test 8 ms (bound 1000 ms); extra probes on 100k Unicode inputs ≤ 11 ms each. `npm run check` exit 0, 585 passed + 2 skipped.
  - Trade-off: in scripts written without spaces, adjacent letters join the token, so `メールはjohn@example.comです` is redacted whole (over-redaction, not a leak).
  - Commit: `ec63b48 fix(sanitizer): redact long and internationalized email addresses`.
- T2 (route: inline, one source file plus its test).
  - RED: 60 failures over the six numeric variables. `" "`, `"\t"`, `" 5"`, `"5 "`, `"1e3"`, `"0x10"`, `"+5"` were accepted (`Error: Expected loadConfig to throw a ConfigError`); `"-1"`, `"2.5"`, `"١٢"` were rejected with value-specific rule messages (`Too small: expected number to be >=0`).
  - Fix: numeric variables are `z.string().regex(/^\d+$/)` piped through `Number` into the existing integer range; empty strings still fall back to the default (normalized to `undefined` before parsing).
  - GREEN: config suite 120 passed (each variable also reads `"0010"` as 10 and uses its default for `""`). `npm run check` exit 0, 652 passed + 2 skipped.
  - Commit: `d1653c9 fix(config): reject non-decimal numeric environment values`.
- T3 (route: inline, one source file plus two test files).
  - RED: integration `hides an unexpected provider error behind a generic 500 and audits INTERNAL_ERROR` → `expected '{"level":50,…' not to contain '123-45-6789'` (the log held `"message":"socket hang up near 123-45-6789"` and the same text as the stack's first line). New `test/shared/http/error-handler.test.ts`: 5 failures; pino's `err` serializer also appended `caused by: Error: upstream rejected jane.doe@example.com`.
  - Fix: the unmapped `INTERNAL_ERROR` path logs `error: { type, code?, stack }`, where `type` is the constructor name, `code` only when it is a string, and `stack` keeps only `at` frames after stripping the exact `Name: message` header (so a multi-line message cannot smuggle a frame-shaped line). Non-Error values log `{ type: typeof value }`. 4xx, body-parser, and mapped 5xx (`AUDIT_UNAVAILABLE`) logging are unchanged.
  - GREEN: HTTP, integration, app, and logging-hygiene suites 74 passed. `npm run check` exit 0, 657 passed + 2 skipped.
  - Commit: `b2cb4f0 fix(http): keep error messages out of unexpected-error logs`.
- T4 (route: inline, one config file; proof by temporary probes, all removed).
  - RED: probes in `domain/`, `domain/sanitization/`, and `application/` importing `node:child_process` and `node:http`, calling `await import('node:fs')`, and reading `globalThis.process.env`, `global.process.env`, and `const { process } = globalThis`: the old config reported only the relative `../infrastructure/...` import (1 problem).
  - Fix: `no-restricted-imports` allow-list `^(?!\.{1,2}/)|(^|/)node_modules(/|$)` replaces the framework/Node deny-list; the relative outer-layer patterns stay; `no-restricted-properties` bans `globalThis.process` and `global.process` (destructuring included); `no-restricted-syntax` bans `ImportExpression`, merged with the RedactedText selectors because flat config replaces rule options (the sanitizer gets the import ban only).
  - GREEN: 15 violations on the three probes (every import, dynamic import, and process access above); a probe with only relative imports (`./pii-type.js`, `../../shared/errors/app-error.js`) passes with exit 0; preserved rules still fire (`express` type import, relative `node_modules` path, RedactedText cast in the domain, `process` global) while the sanitizer's own cast passes. Probes deleted; `npm run lint` exit 0; `npm run check` exit 0, 657 passed + 2 skipped.
  - Residual: a relative import of a `src/` root module (`../../composition-root.js`) and aliasing the global object (`const g = globalThis; g.process`) are still not caught.
  - Commit: `2442d9c fix(lint): enforce layer boundaries with an import allow-list`.
- T5 (route: inline, docs only).
  - `docs/pii-sanitization.md`: email row covers any script and any local-part length; Unicode token-boundary note; over-redaction in scripts without spaces; non-ASCII local-part limitation removed; ReDoS note explains the one unbounded quantifier.
  - `README.md`: "Known issues" replaced by "Resolved review findings" (five rows with fix commit subjects) and its contents link; partial non-ASCII redaction dropped from Known limitations; numeric-variable rule, lint allow-list, and unexpected-error logging described where the old text was.
  - Review record: REL-001, REL-002, REL-003, RISK-003 follow-ups marked fixed with hashes; the non-ASCII local-part residual marked fixed (frozen ledger untouched).
  - Final: `npm run check` exit 0, 657 passed + 2 skipped; `npm run build` exit 0. This commit's own hash is reported outside the document.

## Next step

None in scope: push and pull request are the user's decisions. Engram mirror `odd/known-issues-fixes/tasks` still PENDING.
