# Review: full project (2026-10-27)

Non-authoritative mirror. No git repository and no review artifact store exist, so this file is the only record of the review; it is not a durable receipt.

## Transaction

- Target: whole working tree (`src/`, `test/`, `docs/`, configs), Docker not yet built.
- Snapshot: `files=108 snapshot=d4d5233b268bb57dec56b0702d7c11d360050bf66ad5d62bbfff0052f14d26dd` (content hash; stands in for a commit SHA).
- Tier: high (security hot path, >400 authored lines) → full 4R: risk, reliability, resilience, readability. One sweep each.
- Baseline: typecheck 0, lint 0, tests 553 passed + 1 skipped (Windows-only POSIX file-mode test), build 0, `npm audit --omit=dev` 0 vulnerabilities, no warnings, snapshot unchanged after the run.

## Frozen ledger

| ID | Lens | Location | Severity | Claim | Evidence | Status |
|---|---|---|---|---|---|---|
| RISK-001 | risk | `src/app.ts:19-31` | CRITICAL | No security response headers (`nosniff`, `Cache-Control: no-store`, frame/CSP) on responses carrying user text | deterministic | corroborated |
| RES-001 | resilience | `src/secure-inquiry/infrastructure/audit/jsonl-audit-repository.ts:90-106` | CRITICAL | Torn-tail repair runs once per process; a mid-write failure at runtime lets the next append concatenate onto the fragment | inferential | corroborated (refuter) |
| RISK-002 | risk | `jsonl-audit-repository.ts:28-54` | WARNING | Unbounded audit queue, provider concurrency, file growth; no rate limiting | inferential | info |
| RISK-003 | risk | `eslint.config.js:6-15` | WARNING | Layer-boundary rule is a deny-list; other `node:*` modules, dynamic `import()`, `globalThis.process` bypass it | deterministic | info |
| RISK-004 | risk | `aes-gcm-encryption-service.ts:52` | SUGGESTION | Lone UTF-16 surrogates are replaced with U+FFFD before encryption | inferential | info |
| REL-001 | reliability | `src/shared/config/app-config.ts:63,100,103` | WARNING | Whitespace-only numeric env values coerce to 0 (e.g. `AI_PROVIDER_DELAY_MS=" "` disables the delay) | deterministic | info |
| REL-002 | reliability | `email-detector.ts:5` | WARNING | Emails with a local part of 65+ characters are not redacted at all | deterministic | info |
| REL-003 | reliability | `test/secure-inquiry.integration.test.ts:308-320` | WARNING | Unexpected-error test plants an SSN in the error but asserts only the response, not logs; 5xx logs include message and stack | deterministic | info |
| REL-004 | reliability | `test/secure-inquiry.integration.test.ts:337-346` | SUGGESTION | Fail-fast latency bound is 150 ms against a 300 ms delay; provider-call count carries the guarantee | inferential | info |
| READ-001 | readability | `README.md` (absent) | WARNING | No README entry point (planned for the Docker slice) | deterministic | info |
| READ-002 | readability | `src/composition-root.ts:40-53,77-122` | WARNING | Overlapping override shapes copied by hand | deterministic | info |
| READ-003 | readability | `application/errors.ts:4-6` | SUGGESTION | `FallbackReason` and `AiProviderFailureReason` duplicated without a declared relationship | deterministic | info |
| READ-004 | readability | `shared/resilience/circuit-breaker.ts:24-26` | SUGGESTION | `TimeSource` and `Clock` identical; deliberate split undocumented | deterministic | info |
| READ-005 | readability | `process-secure-inquiry.ts:73,106` | SUGGESTION | Revision numbers are inline literals | inferential | info |
| READ-006 | readability | `secure-inquiry.routes.ts:15-18` | SUGGESTION | Error mappings keyed by string literals duplicating error codes | deterministic | info |
| READ-007 | readability | config + constructors | SUGGESTION | Numeric ranges validated twice with slightly different rules | inferential | info |

WARNING and SUGGESTION rows are non-blocking `info` under the bounded review contract: they do not drive this correction transaction. Deterministic WARNING rows are listed as recommended follow-ups.

## Refuter batch

One batch: RES-001 → corroborated. `prepared` is never reset when `appendDurably` rejects (`jsonl-audit-repository.ts:91-106`); `FileHandle.writeFile` does not roll back bytes already written; the existing ENOSPC test uses a fake that writes nothing before rejecting, so it cannot detect the defect; docs promise repair only before the first append.

## Correction transaction

One transaction, two atomic work units, delegated to one writer:

- WU-1 → RISK-001: `src/shared/http/security-headers.ts` (new) registered first in `src/app.ts`; sets `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`; HSTS left to the TLS terminator (documented). RED: 5 header tests (success, 400, 415, 404, `/health`) failed on the header assertion. GREEN: `test/app.test.ts` 40/40. Runtime: built app on an ephemeral port, real `fetch` on all five paths, all headers exact, no HSTS.
- WU-2 → RES-001: `writeLine` resets `prepared = false` and rethrows when `appendDurably` fails. RED: `terminates the fragment a failed append left on disk so the next record stays intact` (real temp file, 40-byte partial write, then `ENOSPC`) failed with `expected [] to deeply equal [ '<next.auditId>' ]`. GREEN: audit suites 47 passed + 1 skipped. Runtime: covered by the real-filesystem test; a real `ENOSPC` cannot be produced safely on this machine.
- Delta: 7 files, +109/−5 (`scratchpad/review-fix/fix-delta.diff`); rollback copies in `scratchpad/review-fix/before/`.

## Scoped fix-delta validation

Verdict: **approve**. Both acceptance criteria met; queue invariants hold (re-arm happens inside the serialized chain, order unchanged, original error rethrown); both regression tests fail without their fix and assert behavior.

Non-blocking follow-ups: the 40-byte partial-write slice assumes the fixture line is longer than 40 bytes; a future route setting its own `Cache-Control` would override `no-store`.

## Final verification

Independent run on snapshot `files=109 snapshot=9a1ccf5604502fb8aa435b6fa1569d486aa15f2812cdda52193ffe6737a713f8` (matches): typecheck 0, lint 0, tests 559 passed + 1 skipped on two consecutive runs (identical counts), build 0, no warnings.

Terminal state: **approved**.

## Recommended follow-ups (non-blocking, not fixed in this transaction)

- REL-001: reject non-digit numeric env values before coercion.
- REL-002: redact over-long email local parts instead of leaking the whole address.
- REL-003: assert logs in the unexpected-error test; decide whether 5xx logs keep error messages.
- RISK-003: turn the layer-boundary rule into an allow-list and ban dynamic `import()` and `globalThis.process`.
- READ-002: collapse the overlapping composition-root override shapes.
- READ-001: README (planned for the Docker slice).

## Residual limitations

Already documented: in-memory per-process breaker; single-process, single-writer JSONL store, no rotation or retention, O(n) reads, no directory fsync on first create; regex coverage gaps (ASCII emails, glued or non-ASCII digits, mixed separators, back-to-back grouped numbers, decimal context); key remains readable in `process.env`; failure injection reachable in production wiring (startup warning).

Not yet documented (should be):

- Unbounded audit queue and provider concurrency, no rate limiting or authentication (RISK-002).
- Non-ASCII email local parts are partially redacted, leaking the prefix up to the last non-ASCII character: measured on the built code, `müller.hans@example.com` → `mü<REDACTED: EMAIL>` (the reliability lens's original example `müller<…>` was inaccurate; corrected during delivery). Now documented in the README.
- Random 96-bit IV budget: rotate the key before ~2^32 encryptions.
- File modes apply only to newly created paths and are ignored on Windows; existing permissions are not tightened.
- A 5,000-character non-ASCII message can exceed the 16 KB body limit and get 413 before schema validation.
- No `unhandledRejection`/`uncaughtException` handlers; a second signal exits immediately; `/health` has no draining signal.
- Lone UTF-16 surrogates are replaced with U+FFFD before encryption (RISK-004).
