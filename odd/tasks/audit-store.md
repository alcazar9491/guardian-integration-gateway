# Feature: audit-store

## Objective

`AuditRepository` port and an append-only JSON Lines adapter that persists, per inquiry, an audit ID, timestamps, a pseudonymized user reference, the AES-256-GCM encrypted original, the plaintext sanitized message, redaction counts, and the processing outcome, without ever persisting the original in plaintext and without losing records under concurrent requests in one process.

## Problem / Why

The gateway must prove what it received and what left it, while keeping the original message recoverable only by authorized decryption. A naive JSON array rewritten per request loses records under concurrency and can corrupt the whole file on a crash.

## Scope

- In: `AuditRecord` v1, `AuditOutcome`, associated-data builder, `AuditRepository`/`AuditReader`/`UserPseudonymizer` ports, `HmacUserPseudonymizer`, `AUDIT_USER_REF_KEY` config, stored-record schema and whitelist serializer, `JsonlAuditRepository` (write and read paths, `close()`), composition-root wiring and graceful-shutdown drain, security integration tests, presenter exposure test, `docs/audit-store.md`.
- Out: use case orchestration (next slice builds records and calls the repository), retention enforcement, compaction/rotation, multi-process coordination, a real database.

## Constraints

- The original message is never persisted, logged, or returned in plaintext.
- The repository and pseudonymizer have no logger; errors never contain record contents.
- Only `node:fs/promises`, `node:crypto`, and existing dependencies (zod for read validation); no new dependencies.
- Do not create or edit `.env*` files in the project; update only the staged scratchpad `env.example`.
- Never claim JSON-file storage is safe for multi-container or multi-replica deployments.

## Design

### Record v1 (domain)

```json
{
  "schemaVersion": 1,
  "auditId": "uuid",
  "revision": 1,
  "createdAt": "ISO-8601 (inquiry received)",
  "recordedAt": "ISO-8601 (this revision written)",
  "userRef": "base64url HMAC-SHA256 of userId",
  "sanitizedMessage": "Email <REDACTED: EMAIL>",
  "redactions": { "EMAIL": 1 },
  "encryptedMessage": { "algorithm": "aes-256-gcm", "version": 1, "keyId": "v1", "iv": "…", "authTag": "…", "ciphertext": "…" },
  "outcome": "PENDING"
}
```

`AuditOutcome = 'PENDING' | 'COMPLETED' | 'PROVIDER_FAILURE' | 'PROVIDER_TIMEOUT' | 'CIRCUIT_OPEN_FALLBACK' | 'CANCELLED'`.

### Audit-before-egress (two revisions, append-only)

Keeps the documented fail-closed assumption: no sanitized text reaches the provider unless its encrypted original is durably audited first.

1. Revision 1, `outcome: PENDING`, is appended before the provider call. If it fails, the provider is never called (`AUDIT_UNAVAILABLE`).
2. Revision 2 carries the final outcome and is appended after the provider settles. Every line is a complete record; readers take the highest revision per `auditId`.
3. A crash between the two leaves a `PENDING` record as evidence. If revision 2 fails to persist, the response is still returned (revision 1 already audits the inquiry); the use case slice logs the failure without request data.

### Data minimization for `userId`

- `userId` is client-asserted and may itself contain PII (an email, a 9-digit ID), so the raw value is never written.
- Stored as `userRef = base64url(HMAC-SHA256(userRefKey, userId))`: stable, non-reversible without the key, and lets authorized investigators locate a user's records by recomputing it.
- `userRefKey` comes from a dedicated `AUDIT_USER_REF_KEY` (32 bytes, canonical base64, validated at startup like the encryption key, and rejected if equal to `AUDIT_ENCRYPTION_KEY`): key separation and an independent lifecycle (rotating it breaks lookups for older records, so it rotates rarely and deliberately).
- The AI reply is not stored (derivable from the sanitized message; nothing to gain).
- Associated data for encryption is `JSON.stringify([auditId, userRef])`, recomputable from the stored record, so verification never needs the raw `userId`.

### Ports (application)

- `AuditRepository.append(record): Promise<void>` (request path).
- `AuditReader.findById(auditId): Promise<AuditRecord | undefined>` and `scan(): Promise<{ records; invalidLines }>` (verification and tests only; not wired into the use case).
- `UserPseudonymizer.pseudonymize(userId): string`.

### JSONL adapter (infrastructure)

Write path:

- Explicit whitelist serializer (`toStoredRecord`): only the v1 fields are written, so a stray runtime property (for example an accidental `originalMessage`) is never persisted.
- One JSON object per line, newline-terminated (`JSON.stringify` escapes embedded newlines).
- Directory created on first write (`recursive`, mode `0o700`); file opened in append mode with mode `0o600` (POSIX; documented as ignored on Windows).
- Torn-tail repair: before the first append in a process, if the file is non-empty and does not end with `\n`, a newline is appended first so a fragment from a previous crash cannot swallow the next record.
- Each append: open `'a'` → write full line → `datasync()` → close. Never rewrites or truncates the file.
- In-process FIFO queue serializes appends; a failed append rejects only its caller and never poisons the queue.
- Filesystem errors (`ENOSPC`, `EACCES`, `EISDIR`, `ENOTDIR`, `EROFS`, …) become `AuditPersistenceError` with a generic message and the original error as `cause`.
- `close()` drains pending appends; appends after `close()` reject with `AuditPersistenceError`.
- A minimal injectable `AuditFileSystem` (subset of `node:fs/promises`) enables deterministic failure tests; the default uses the real module.

Read path:

- Missing file → no records.
- Lines are parsed and validated with a zod schema; malformed JSON, wrong shapes, and torn fragments are skipped and counted in `invalidLines`, never thrown, never logged with content.
- Highest `revision` per `auditId` wins.

### Wiring

- The composition root creates one repository and one pseudonymizer and returns a `shutdown()` that drains the repository; `main` calls it after `server.close()` on SIGINT/SIGTERM.
- The presenter never exposes `encryptedMessage`, IV, tag, ciphertext, `userRef`, or the original; a test pins the exact response key set.

### Notes for the use case slice

Build records with `auditId` from `IdGenerator`, `createdAt` from `Clock`, `userRef` from `UserPseudonymizer`, associated data from the shared builder; append revision 1 before `ai.reply`, revision 2 after; map `AiProviderFailureReason` (`PROVIDER_ERROR`, `TIMEOUT`, `CIRCUIT_OPEN`) and cancellation to `AuditOutcome`. The API `inquiryId` is the `auditId`.

## Test plan

- Pseudonymizer: deterministic per key; different keys and different `userId`s give different refs; output never contains the raw `userId`; base64url format.
- Config: `AUDIT_USER_REF_KEY` required, canonical base64, exactly 32 bytes, rejected when equal to the encryption key, never echoed; held as a `KeyObject`.
- Serializer: exact key set; extra runtime properties dropped.
- Write path (temp directories): creates missing directory and file (mode `0o600` asserted on POSIX only); 200 parallel appends yield 200 valid, non-interleaved lines in call order; torn tail repaired so the next record stays valid; injected `ENOSPC`/`EACCES` → `AuditPersistenceError` without record content in message or stack, and the next append succeeds; target path that is a directory → `AuditPersistenceError`; `close()` waits for pending appends and rejects later ones.
- Read path: missing file → empty; malformed JSON, wrong shape, and torn lines skipped and counted; latest revision wins.
- Security integration: real sanitizer + `AesGcmEncryptionService` + pseudonymizer + repository. The raw file contains the sanitized message with labels and contains neither the original message, its email/SSN/card values, nor the raw `userId`. `findById` + `PayloadDecryptor` with the record's associated data recovers the original; a different key, or a ciphertext swapped between two records, fails with `DecryptionError`.
- Presenter: response key set excludes every encryption internal and `userRef`.
- Composition root: smoke tests still pass; `shutdown()` drains pending appends.

## Workflow settings

- TDD: strict, ON. Source: global `~/.claude/CLAUDE.md`. Runner: Vitest (`npm test`).
- Route: delegated direct (writer trigger: 2+ non-trivial files) via one forked writer, started after `circuit-breaker` completes (shared config, composition root, `main`, and test runs).
- Commits: blocked. Not a git repository yet.
- RDD assessment: not run. No work-unit commit exists.
- Delivery: forecast ~900 authored changed lines; strategy pending until a repository exists.
- Engram mirror `odd/audit-store/tasks`: PENDING. Engram MCP failed to connect this session.

## Tasks

- [x] T1 Domain and ports: `AuditRecord` v1, `AuditOutcome`, associated-data builder, `AuditRepository`, `AuditReader`, `UserPseudonymizer`
- [x] T2 Config `AUDIT_USER_REF_KEY` (TDD), staged `env.example`
- [x] T3 `HmacUserPseudonymizer` (TDD)
- [x] T4 Stored-record schema, whitelist serializer, line parser (TDD)
- [x] T5 JSONL write path: directory/file creation, torn-tail repair, FIFO queue, `datasync`, error mapping, `close()` (TDD)
- [x] T6 JSONL read path: `findById`, `scan`, latest revision wins, invalid lines skipped and counted (TDD)
- [x] T7 Security integration test, presenter exposure test, composition-root wiring, graceful-shutdown drain, smoke tests
- [x] T8 `docs/audit-store.md` (format, minimization policy, safe-write practices, limits, production replacement); full `npm run check` and `npm run build`

## Documentation must cover

- Why JSON Lines and append-only, and every safe-write practice above.
- Limits: single writer per file and single process only; no cross-process lock; O_APPEND guarantees do not hold on network filesystems; each replica would keep its own file (split audit trail); O(n) lookups, no indexes, no transactions, no retention or erasure without rewriting, unbounded growth, no tamper evidence, file-level access control only.
- Explicit statement: not safe for multi-container or multi-replica production.
- Production replacement: PostgreSQL with an append-only `audit_records` table (INSERT-only role, no UPDATE/DELETE grants, outcome as a second row or a separate `audit_outcomes` table), JSONB payload, indexes on `user_ref` and `created_at`, monthly partitioning for retention, point-in-time recovery, TLS, and KMS envelope encryption; optionally WORM storage (for example S3 Object Lock) or a hash chain for tamper evidence.

## Acceptance criteria

- Every test-plan item passes; `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.
- Grep: no logger or `console` in the audit adapter or pseudonymizer; no `JSON.stringify(record)` of an unwhitelisted object in the write path.
- No dependency added to `package.json`.

## Progress and evidence

Baseline before writing: `npm run check` green, 423 tests across 20 files.

### T1 Domain and ports (route: delegated writer)

- Added `AuditRecord` v1 (`schemaVersion`, `auditId`, `revision`, `createdAt`, `recordedAt`, `userRef`, `sanitizedMessage`, `redactions`, `encryptedMessage`, `outcome`), `AUDIT_OUTCOMES`, and `PersistedAuditRecord` (read model whose `sanitizedMessage` is a plain `string`: text read back from disk is not sanitizer output, and only the sanitizer may create `RedactedText`).
- Ports: `AuditRepository.append` (revision semantics documented), `AuditReader` (`findById`, `scan`), `UserPseudonymizer`; new `AuditReadError` for the verification-side read path.
- RED: `npx vitest run test/secure-inquiry/domain/audit-associated-data.test.ts` failed (module missing, 1 file failed).
- GREEN: same command, 6/6 passed. `npm run typecheck`, `npm run lint`: pass.
- Commit: blocked (no git repository).

### T2 Config `AUDIT_USER_REF_KEY` (route: delegated writer)

- RED: `npx vitest run test/shared/config/app-config.test.ts` → 7 failed / 46 passed (KeyObject missing; missing, short, non-canonical, and equal-to-encryption keys accepted).
- GREEN: 53/53. The key is canonical base64, exactly 32 bytes, held as a `KeyObject`, rejected when equal to `AUDIT_ENCRYPTION_KEY` (object-level refine on `AUDIT_USER_REF_KEY`); the leak test now covers base64, hex, Buffer inspect and Buffer JSON renderings of both keys.
- Composition-root test helpers supply both keys; `test/composition-root.test.ts` 8/8. Staged scratchpad `env.example` documents `AUDIT_USER_REF_KEY` (empty). `npm run typecheck`, `npm run lint`: pass.
- Commit: blocked (no git repository).

### T3 `HmacUserPseudonymizer` (route: delegated writer)

- RED: `npx vitest run test/secure-inquiry/infrastructure/hmac-user-pseudonymizer.test.ts` failed (module missing).
- GREEN: 11/11. Base64url HMAC-SHA256 over the UTF-8 userId, matching an independent `createHmac` computation; stable per key; distinct across users and keys; never contains the raw userId (email, SSN-like, Unicode, newline cases); holds only a `KeyObject` (inspect/JSON reveal no key bytes); non-32-byte key → `InvalidUserRefKeyError` with a fixed message.
- `npm run typecheck`, `npm run lint`: pass. Commit: blocked (no git repository).

### T4 Stored record (route: delegated writer)

- RED: `npx vitest run test/secure-inquiry/infrastructure/audit/stored-audit-record.test.ts` failed (module missing).
- GREEN: 18/18. `toStoredRecord` copies v1 fields by name (stray `originalMessage`, `userId`, payload `key`, unknown redaction types dropped); `serializeAuditRecord` validates with a strict zod schema before writing (invalid timestamp, revision 0, unknown outcome, empty id → `AuditPersistenceError` whose message, stack, and cause name only field paths) and emits exactly one newline-terminated line; `parseAuditLine` rejects malformed JSON, torn fragments, non-objects, unknown schema versions, extra fields, missing fields, and `__proto__` keys.
- Spec amendment: the read schema is strict (unknown fields make a line invalid) rather than stripping them, so a tampered or foreign line is counted in `invalidLines` instead of silently trusted.
- `npm run typecheck`, `npm run lint`: pass. Commit: blocked (no git repository).

### T5 JSONL write path (route: delegated writer)

- Moved the repository to `src/secure-inquiry/infrastructure/audit/jsonl-audit-repository.ts` (old stub deleted, composition-root import updated); added `audit-file-system.ts` (`nodeAuditFileSystem`: `mkdir` recursive 0700, append via `open('a', 0o600)` + `writeFile` + `datasync` + `close`, last-byte probe, line reader).
- RED: `npx vitest run test/secure-inquiry/infrastructure/audit/jsonl-audit-repository.write.test.ts` failed (module missing).
- GREEN: 14 passed, 1 skipped (file/directory mode assertion is POSIX-only and skipped on win32). Covered: missing nested directory and file created; earlier content never rewritten; 200 concurrent appends → 200 valid lines in call order; torn tail terminated once so later records stay intact; no blank lines added to empty or newline-terminated files; target path that is a directory → `AuditPersistenceError`; injected `ENOSPC`/`EACCES`/`EROFS` → `AuditPersistenceError` with the errno as `cause` and no record content in message, stack, or cause, while the next append still succeeds; failed preparation retried; invalid record rejected with nothing written; an append never starts before the previous one finishes; `close()` drains pending appends and rejects later ones.
- One lint fix in the test fake (async generator without `await` → `Readable.from`); no product change.
- `npm run typecheck`, `npm run lint`: pass. Commit: blocked (no git repository).

### T6 JSONL read path (route: delegated writer)

- RED: `npx vitest run test/secure-inquiry/infrastructure/audit/jsonl-audit-repository.read.test.ts` → 7/7 failed (`scan`/`findById` missing).
- GREEN: 7/7 (audit directory total 39 passed, 1 POSIX-only skip). Missing file → empty store; highest revision per `auditId` wins regardless of line order; malformed JSON, torn fragment, tampered (extra field), and incomplete lines skipped and counted (4), blank lines ignored; reads wait for pending appends; every scan re-reads the file; read failures → `AuditReadError` with the errno as `cause`.
- `npm run typecheck`, `npm run lint`: pass. Commit: blocked (no git repository).

### T7 Integration, exposure, wiring (route: delegated writer)

- RED: `npx vitest run test/composition-root.test.ts ...` → 2 failed (`compose` did not build the pseudonymizer, so an invalid `userRefKey` was accepted; no `shutdown`).
- GREEN after wiring: `compose()` builds one `JsonlAuditRepository` and one `HmacUserPseudonymizer` (new `userPseudonymizer` dependency on `ProcessSecureInquiry`, still NotImplemented) and returns `shutdown()` = `auditRepository.close()`; `main` awaits it inside `server.close()` before exiting. Composition root 10/10.
- `audit-store.security.test.ts` (7) and `secure-inquiry.presenter.test.ts` (2) passed on their first run: they are cross-component acceptance tests over behavior already built in T1–T6 and the presenter's existing explicit field mapping, recorded honestly as characterization rather than RED→GREEN. They prove: the raw file holds neither the original, its email/card/SSN values, nor the raw userId; the redacted message and redaction counts are readable without keys; decryption with the record's associated data recovers the original; a different key, a ciphertext swapped between records, and an altered `userRef` all fail with `DecryptionError`; recomputing `userRef` finds a user's records; responses never expose IV, tag, ciphertext, `userRef`, `userId`, or an original even when the result object carries them at runtime.
- One lint fix in the presenter test (unnecessary assertion); no product change.
- `npm run check`: pass, 27 files, 497 passed, 1 skipped (POSIX-only mode test). Commit: blocked (no git repository).

### T8 Docs and full verification (route: delegated writer)

- `docs/audit-store.md`: record format and field table, never-stored list, two-revision rationale, data-minimization policy (HMAC `userRef`, separate key, rotation impact, retention not enforced), safe-write practices table, failure-handling table, limits of a JSON file as a database, explicit "not safe for multiple containers, replicas, or processes" statement, PostgreSQL replacement (INSERT-only append-only table, JSONB, indexes, monthly partitions, PITR, TLS, KMS envelope encryption, hash chain or WORM option).
- `docs/encryption.md`: associated data is now `JSON.stringify([auditId, userRef])` via `auditAssociatedData`; dev-key setup generates both keys.
- `npm run check`: exit 0, 27 files, 497 passed, 1 skipped. `npm run build`: exit 0.
- Grep: no pino/logger/`console` in `infrastructure/audit/` or the pseudonymizer; no 32-byte base64 or 64-char hex literal in `src/`, `test/`, `docs/`; the only `JSON.stringify` in the write path serializes the validated whitelist output; `package.json` dependencies unchanged.
- Boot (`dist/main.js`, generated keys, `PORT=3999`, temp audit path): equal `AUDIT_USER_REF_KEY` and `AUDIT_ENCRYPTION_KEY` → exit 1, output only `Invalid configuration: - AUDIT_USER_REF_KEY: must differ from AUDIT_ENCRYPTION_KEY` (no key value); distinct keys → `GET /health` 200 `{"status":"ok"}`, no key in server output; process stopped.
- Commit: blocked (no git repository).

### Spec amendments

- `AuditReader` returns `PersistedAuditRecord` (`sanitizedMessage: string`), not `AuditRecord`: text read from disk is not sanitizer output, and only the sanitizer may create `RedactedText` (lint-enforced).
- Read failures raise a new `AuditReadError` (`AUDIT_READ_FAILED`) instead of reusing `AuditPersistenceError`, whose message is about writing.
- The read schema is strict: unknown fields make a line invalid (counted), rather than being stripped and trusted.
- Directory `fsync` after first file creation is not performed; documented as an honest durability gap.

## Next step

Feature complete. The use case slice builds records (revision 1 before `ai.reply`, revision 2 after), maps provider outcomes to `AuditOutcome`, and decides how `TIMEOUT` surfaces in the API.
