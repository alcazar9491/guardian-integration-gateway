# Feature: pii-sanitizer

## Objective

Deterministic, side-effect-free PII sanitizer that redacts emails, credit card numbers, and SSN-like values (including standalone 9-digit identifiers) with the exact labels `<REDACTED: EMAIL>`, `<REDACTED: CREDIT_CARD>`, `<REDACTED: SSN>`, preserving all unrelated content.

## Problem / Why

The gateway must never forward PII to the AI provider. Redaction must be predictable for ambiguous and overlapping inputs, never leave fragments of a detected value, and never redact twice.

## Scope

- In: domain detectors (email, credit card, SSN), shared numeric boundary rules, overlap resolution, single-pass redaction, findings counts, `PiiSanitizer` implementing `MessageSanitizer`, composition-root wiring, unit tests, `docs/pii-sanitization.md`.
- Out: use case orchestration, encryption, persistence, HTTP changes, Luhn/SSN validity checks, non-ASCII digits, other PII types.

## Constraints

- Domain layer only: no logger, no Express, no fs, no `process` (ESLint-enforced).
- Never log or expose the original input or detected values; matches carry offsets and type only; errors never include input.
- Separate small detection passes; no single mega-regex; bounded quantifiers (ReDoS-safe).
- Global regexes are only consumed through `String.prototype.matchAll`; never `.test()`/`.exec()` on shared `/g` instances.

## Design

### Pipeline

`detect` (every detector scans the ORIGINAL text, independently) → `resolveOverlaps` → `applyRedactions` (one left-to-right pass) → `countFindings`.

Contracts (replace the scaffold `RedactionRule` stub):

- `PiiMatch { readonly type: PiiType; readonly start: number; readonly end: number }` (half-open, UTF-16 offsets; never the matched value).
- `PiiDetector { readonly type: PiiType; detect(text: string): readonly PiiMatch[] }`.
- `PiiSanitizer implements MessageSanitizer` with `constructor(detectors: readonly PiiDetector[])` and a `createPiiSanitizer()` factory wiring the default detectors.

### Precedence rule (deterministic, documented)

1. Each detector scans the original message; no detector ever sees another detector's output.
2. Candidates that share at least one character are merged (transitively) into one redaction covering their union, so no fragment of a detected value survives.
3. A merged redaction takes the label of its longest candidate; equal lengths break ties by the fixed priority EMAIL > CREDIT_CARD > SSN.
4. Candidates are sorted by `(start asc, end desc, priority asc)` before merging, so the result never depends on detector registration order.
5. Labels are written once and never re-scanned; labels contain no digits or `@`, so `sanitize` is idempotent.

### Numeric token boundary rule

A numeric match must be a complete token:

1. Not glued to a letter, digit, or underscore on either side (Unicode-aware: `[\p{L}\p{N}_]`).
2. Not part of a decimal number (`\d.` before, `.\d` after). Amended during T1: commas were dropped from this rule because a comma-joined 9+ digit run is never a valid thousands group, and treating commas as joins would leak comma-separated identifiers such as `123456789,987654321`.
3. Grouped formats use one consistent separator (space or hyphen) and are not continued by that same separator plus a digit on either side, so a window of a longer grouped number never matches.

### Formats

- EMAIL: pragmatic ASCII `local@domain.tld`; local part `[A-Za-z0-9._%+-]{1,64}` starting at a token boundary; domain labels `[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?` joined by dots; TLD `[A-Za-z]{2,63}`. Trailing sentence punctuation is not consumed.
- CREDIT_CARD: contiguous 13–19 digits, or grouped shapes 4-4-4-4 (16), 4-4-4-4-3 (19), 4-6-5 (15, Amex), 4-6-4 (14, Diners), each with a consistent space or hyphen separator. No Luhn check (over-redaction preferred over leaking mistyped numbers).
- SSN: `3-2-4` with a consistent space or hyphen separator, or a standalone contiguous 9-digit identifier. No SSN validity rules (assessment treats any standalone 9-digit identifier as sensitive).

### Acceptance examples (TDD contract)

| Input | Expected |
|---|---|
| `Contact john.doe+tag@mail.example.co.uk today` | `Contact <REDACTED: EMAIL> today` |
| `Mail me: a@b.io.` | `Mail me: <REDACTED: EMAIL>.` |
| `john@`, `@example.com`, `john@example`, `john@@example.com`, `john@.com` | unchanged |
| `4111111111111111`, `4111 1111 1111 1111`, `4111-1111-1111-1111` | `<REDACTED: CREDIT_CARD>` |
| `378282246310005`, `3782 822463 10005`, `3056 930902 5904`, `4222222222222` | `<REDACTED: CREDIT_CARD>` |
| `Card:4111111111111111.` | `Card:<REDACTED: CREDIT_CARD>.` |
| `4111 1111 1111` (12), `12345678901234567890` (20), `4111 1111 1111 1111 2222` | unchanged |
| `4111-1111 1111-1111` (mixed separators), `ID4111111111111111`, `3.1415926535897932` | unchanged |
| `123-45-6789`, `123 45 6789`, `123456789`, `(123456789)` | SSN redacted, punctuation kept |
| `ids 123456789 and 987654321` | both redacted, findings `{ SSN: 2 }` |
| `123-45-6789 2026` | `<REDACTED: SSN> 2026` |
| `12345678`, `1234567890`, `ID123456789`, `123456789abc`, `123-456-789`, `12-345-6789`, `123-45-67890`, `123-45-6789-0000`, `0.123456789`, `123456789.50` | unchanged |
| `123456789@example.com`, `john@123456789.com`, `4111111111111111@pay.example` | `<REDACTED: EMAIL>` |
| `Email a@b.com, card 4111 1111 1111 1111, SSN 123-45-6789.` | all three redacted, findings `{ EMAIL: 1, CREDIT_CARD: 1, SSN: 1 }` |

Also covered: empty string, whitespace-only, multiline/tabs/emoji preserved, text without PII returned identical, idempotency, detector-order independence, runtime non-string input throws `InvalidSanitizerInputError` with a generic message, control characters and lone surrogates preserved without throwing, pre-existing `<REDACTED: SSN>` text untouched, fullwidth and Arabic-Indic digits not detected (pinned limitation), 100k-char adversarial inputs complete within a generous time bound.

## Workflow settings

- TDD: strict, ON. Source: global `~/.claude/CLAUDE.md`. Runner: Vitest (`npm test`).
- Route: delegated direct (writer trigger: 2+ non-trivial files) via one forked writer, started after `project-scaffold` completes (shared domain files).
- Commits: blocked. Not a git repository yet.
- RDD assessment: not run. No work-unit commit exists.
- Delivery: forecast ~700 authored changed lines; strategy pending until a repository exists.
- Engram mirror `odd/pii-sanitizer/tasks`: PENDING. Engram MCP failed to connect this session.

## Tasks

- [x] T1 Contracts and helpers: `PiiMatch`, `PiiDetector`, redaction label formatter, numeric boundary fragments, `matchAll`-based regex detector helper; remove the `RedactionRule` and `RuleBasedMessageSanitizer` stubs (stub removal moved to T6, see evidence)
- [x] T2 Email detector (TDD)
- [x] T3 Credit card detector (TDD)
- [x] T4 SSN detector (TDD)
- [x] T5 `resolveOverlaps` and `applyRedactions` (TDD)
- [x] T6 `PiiSanitizer` + `createPiiSanitizer()`, findings, idempotency, determinism, malformed input, limitation and performance tests; wire into the composition root
- [x] T7 `docs/pii-sanitization.md`: precedence rule, boundary rule, formats, limitations; full `npm run check` and `npm run build`

## Acceptance criteria

- Every acceptance example above passes as a unit test.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.
- Sanitizer modules import nothing outside the domain and the framework-free shared errors.
- Composition-root smoke test still passes.

## Progress and evidence

Baseline before T1: `npm run check` exit 0, 49/49 tests.

### T1 Contracts and helpers (route: delegated writer)

- Files: `sanitization/{pii-detector,redaction-label,regex-detector,numeric-token}.ts`.
- RED: `npx vitest run test/secure-inquiry/domain/sanitization` failed, 3 files (modules missing).
- GREEN: same command, 3 files, 37/37 passed.
- `npm run typecheck` and ESLint on domain and tests: pass.
- Stub removal deferred to T6: `composition-root.ts` still instantiates `RuleBasedMessageSanitizer`, and removing it before `PiiSanitizer` exists would break the build between tasks.
- Rule 2 amended (commas no longer join numbers); see the boundary rule section.
- Commit: blocked (no git repository).

### T2 Email detector (route: delegated writer)

- File: `sanitization/detectors/email-detector.ts`.
- RED: `npx vitest run test/secure-inquiry/domain/sanitization/detectors/email-detector.test.ts` failed (module missing).
- GREEN: same command, 24/24 passed.
- Commit: blocked (no git repository).

### T3 Credit card detector (route: delegated writer)

- File: `sanitization/detectors/credit-card-detector.ts` (contiguous 13–19 plus 4 groupings × 2 separators).
- RED: `npx vitest run test/secure-inquiry/domain/sanitization/detectors/credit-card-detector.test.ts` failed (module missing).
- GREEN: same command, 32/32 passed, including 4 pinned limitation cases.
- Commit: blocked (no git repository).

### T4 SSN detector (route: delegated writer)

- File: `sanitization/detectors/ssn-detector.ts` (contiguous 9 plus 3-2-4 × 2 separators).
- RED: `npx vitest run test/secure-inquiry/domain/sanitization/detectors/ssn-detector.test.ts` failed (module missing).
- GREEN: same command, 22/22 passed.
- Commit: blocked (no git repository).

### T5 Overlap resolution and redaction (route: delegated writer)

- Files: `sanitization/{resolve-overlaps,apply-redactions}.ts`.
- RED: `npx vitest run` on both test files failed, 2 files (modules missing).
- GREEN: same command, 16/16 passed, including all 24 permutations of a 4-candidate input.
- ESLint on domain and tests, `npm run typecheck`: pass.
- Commit: blocked (no git repository).

### T6 Sanitizer and wiring (route: delegated writer)

- Files: `sanitization/{pii-sanitizer,invalid-sanitizer-input-error}.ts`; `composition-root.ts` now uses `createPiiSanitizer()`; removed `domain/redaction-rule.ts` and `domain/rule-based-message-sanitizer.ts`.
- RED: `npx vitest run test/secure-inquiry/domain/sanitization/pii-sanitizer.test.ts` failed (module missing).
- GREEN: same command, 69/69 passed (acceptance table, overlaps, idempotency, preservation, determinism, malformed input, 7 pinned limitations, 5 × 100k-char adversarial inputs under 1000 ms).
- Refactor: two lint errors in the new test (vitest `it.each` typing and an `any` matcher) fixed by labelled tuples and a plain error capture.
- `npm run check`: exit 0, 13 files, 249/249 tests (composition-root smoke still returns 501).
- Commit: blocked (no git repository).

### T7 Documentation and final verification (route: delegated writer)

- File: `docs/pii-sanitization.md` (pipeline, precedence rule, boundary rule, formats, non-goals, limitations).
- `npm run check`: exit 0, 13 files, 249/249 tests. `npm run build`: exit 0.
- Built-output smoke: `createPiiSanitizer().sanitize('Email a@b.com, card 4111 1111 1111 1111, SSN 123-45-6789.')` returned all three labels with findings `{ EMAIL: 1, CREDIT_CARD: 1, SSN: 1 }`.
- Grep for framework, `node:*`, logger, `console.` and `process.` usage under `src/secure-inquiry/domain/sanitization/`: no matches.
- Commit: blocked (no git repository).

## Next step

All tasks complete. Pending user decisions: `git init` and a first work-unit commit; then the next slice (AES-256-GCM encryption service).
