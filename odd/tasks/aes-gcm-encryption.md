# Feature: aes-gcm-encryption

## Objective

Encrypt the original inquiry message with AES-256-GCM using only `node:crypto`, producing an audit payload that holds nothing but ciphertext, IV, authentication tag, and algorithm/version/key metadata. Decryption exists only for automated tests and authorized internal verification.

## Problem / Why

The audit store must keep the original message recoverable for authorized review while making it useless to anyone who reads the JSON file. The key must never reach the audit file, logs, error messages, or the repository.

## Scope

- In: `EncryptionService` and `PayloadDecryptor` ports, `EncryptedPayload` v1 format, `AesGcmEncryptionService` (infrastructure), key hardening in `app-config` (KeyObject), composition-root wiring, unit tests, `docs/encryption.md`.
- Out: use case orchestration, audit persistence, key rotation keyring, KMS integration, decryption CLI or endpoint.

## Constraints

- Only `node:crypto`; no new dependencies.
- No logger in the service; errors never contain plaintext, ciphertext, or key material.
- Decryption is never wired into the use case or any HTTP route.
- Do not create or edit `.env*` files (permission rule); `.gitignore` must keep ignoring `.env` and allow `.env.example`.

## Design

### Ports (application layer)

- `EncryptionService.encrypt(plaintext, associatedData): EncryptedPayload` (request path; exists).
- `PayloadDecryptor.decrypt(payload, associatedData): string` (new, separate port; verification only). Interface segregation keeps the request path physically unable to decrypt.
- `DecryptionError` (application error, generic message, `reason: 'UNSUPPORTED_PAYLOAD' | 'UNKNOWN_KEY' | 'AUTHENTICATION_FAILED'`). Wrong key, tampered data, and wrong associated data all surface as `AUTHENTICATION_FAILED`; GCM cannot tell them apart and the API must not try (no oracle).

### Payload v1 (domain)

`{ algorithm: 'aes-256-gcm', version: 1, keyId, iv, authTag, ciphertext }`, binary fields base64. No associated data stored: it is recomputed from the audit record fields at verification time.

### Adapter (infrastructure)

`AesGcmEncryptionService implements EncryptionService, PayloadDecryptor`, options `{ key: KeyObject, keyId: string }`.

- Constructor validates: secret `KeyObject` with `symmetricKeySize === 32`; `keyId` matches `^[A-Za-z0-9._-]{1,64}$`. Otherwise throws `InvalidEncryptionKeyError` (generic message).
- Holds only the `KeyObject` (opaque: `util.inspect` and `JSON.stringify` never reveal key bytes). No raw `Buffer` key in any field.
- `encrypt`: fresh `randomBytes(12)` IV per call, `createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })`, `setAAD(utf8(associatedData))`, UTF-8 plaintext, 16-byte tag.
- `decrypt`: checks `algorithm`, `version`, `keyId`; decodes and requires a 12-byte IV and a 16-byte tag before use; `createDecipheriv(..., { authTagLength: 16 })` so truncated tags are rejected; any `final()` failure becomes `DecryptionError('AUTHENTICATION_FAILED')`.

### Configuration

`AUDIT_ENCRYPTION_KEY` validation stays (canonical base64, exactly 32 bytes) and runs at startup; `main` exits 1 without printing values. `loadConfig` now returns `audit.encryptionKey` as a `KeyObject` (`createSecretKey`), zero-filling the intermediate decoded `Buffer`. `AUDIT_ENCRYPTION_KEY_ID` is validated with the `keyId` pattern.

### Notes for the use case slice

Associated data must be built unambiguously from the record identity, e.g. `JSON.stringify([inquiryId, userId])`, never plain concatenation with a delimiter that `userId` may contain.

## Test plan

- Round trip: ASCII, Unicode/emoji, empty string, 5,000-character message.
- Payload shape: exact key set `{ algorithm, version, keyId, iv, authTag, ciphertext }`; IV decodes to 12 bytes, tag to 16; ciphertext byte length equals plaintext UTF-8 byte length; plaintext absent from the serialized payload.
- Unique IVs: 1,000 encryptions of the same plaintext yield 1,000 distinct IVs and ciphertexts.
- Wrong key (different key, same `keyId`) → `DecryptionError` `AUTHENTICATION_FAILED`.
- Tampering: one flipped bit in ciphertext, tag, or IV; wrong associated data; truncated 4-byte tag → `DecryptionError`.
- Metadata: unknown `keyId` → `UNKNOWN_KEY`; unsupported algorithm or version → `UNSUPPORTED_PAYLOAD`; malformed IV/tag lengths → `UNSUPPORTED_PAYLOAD`.
- Construction: 16-byte key, invalid `keyId` → `InvalidEncryptionKeyError`.
- No leakage: `util.inspect(service)`, `JSON.stringify(service)`, and every thrown error's message and stack contain neither the key (base64 or hex) nor the plaintext.
- Config: `encryptionKey` is a 32-byte secret `KeyObject`; `JSON.stringify(config)` contains no key material; invalid keys still rejected without echoing values.
- Composition-root smoke still passes.

## Workflow settings

- TDD: strict, ON. Source: global `~/.claude/CLAUDE.md`. Runner: Vitest (`npm test`).
- Route: delegated direct (writer trigger: 2+ non-trivial files) via one forked writer, started after `pii-sanitizer` completes (shared `composition-root.ts` and test runs).
- Commits: blocked. Not a git repository yet.
- RDD assessment: not run. No work-unit commit exists.
- Delivery: forecast ~450 authored changed lines; strategy pending until a repository exists.
- Engram mirror `odd/aes-gcm-encryption/tasks`: PENDING. Engram MCP failed to connect this session.

## Tasks

- [x] T1 Contracts: `EncryptedPayload` v1 (`version`), `PayloadDecryptor` port, `DecryptionError`, `InvalidEncryptionKeyError`
- [x] T2 Config hardening: `KeyObject` key, zeroed intermediate buffer, `keyId` validation (TDD, update existing config tests)
- [x] T3 `AesGcmEncryptionService` encrypt/decrypt (TDD, full test plan)
- [x] T4 Composition-root wiring (encrypt-only view into the use case), smoke test green
- [x] T5 `docs/encryption.md`: payload format, dev-key setup, production key management, IV budget; full `npm run check` and `npm run build`

## Acceptance criteria

- Every test-plan item passes; `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.
- No dependency added to `package.json`.
- Grep finds no hardcoded key material in `src/` or `docs/` and no logger import in the encryption adapter.

## Progress and evidence

### Baseline

- `npm run check`: exit 0, 13 files, 249/249 tests.
- Node 24.19 probe: `createSecretKey` copies key bytes (source buffer zeroed, export still matches); `util.inspect(KeyObject)` → `SecretKeyObject {}`; `JSON.stringify` → `{}`. A decipher WITHOUT `authTagLength` verified a 4-byte truncated tag (only DEP0182 warning); WITH `authTagLength: 16` it throws `ERR_CRYPTO_INVALID_AUTH_TAG`.

### T1 Contracts (route: delegated writer)

- Added `ENCRYPTED_PAYLOAD_ALGORITHM`/`ENCRYPTED_PAYLOAD_VERSION` and `version` to `EncryptedPayload`; `PayloadDecryptor` port; `DecryptionError` (reason codes, fixed message); `InvalidEncryptionKeyError` (fixed per-field messages).
- Types and error classes only; behavior is covered in T3.
- `npm run typecheck`, `npx eslint src/secure-inquiry`: pass.
- Commit: blocked (no git repository).

### T2 Config hardening (route: delegated writer)

- RED: `npx vitest run test/shared/config/app-config.test.ts` → 6 failed / 19 passed. The serialization test proved the old leak: `JSON.stringify(config)` contained the key bytes as a decimal array (`Buffer#toJSON`). A first version of that test checked only base64/hex and passed against the leaky `Buffer`; it was strengthened to also check Buffer's inspect (spaced hex) and JSON (decimal list) renderings.
- GREEN: same command → 25/25. `loadConfig` returns a secret `KeyObject`; decoded buffers are zero-filled in validation and conversion; `AUDIT_ENCRYPTION_KEY_ID` validated against `^[A-Za-z0-9._-]{1,64}$` with a message that never echoes the value.
- Adapter stub option type switched to `KeyObject` so the build stays green between tasks.
- `npm run check`: exit 0, 13 files, 256/256 tests.
- Commit: blocked (no git repository).

### T3 Adapter (route: delegated writer)

- RED: `npx vitest run test/secure-inquiry/infrastructure/aes-gcm-encryption-service.test.ts` → 36 failed / 2 passed (38); failures were `NotImplementedError` from the stub.
- GREEN: same command → 38/38. Covers round trips (ASCII, Unicode/emoji, empty, 5,000 chars, second instance with the same key), exact payload key set, 12-byte IV / 16-byte tag, ciphertext length = UTF-8 plaintext length, no plaintext/associated data in the payload, frozen payload, 1,000 unique IVs and ciphertexts, wrong key, flipped bit in ciphertext/tag/IV, wrong associated data, truncated ciphertext, truncated 4-byte tag, unknown key id, unsupported algorithm/version, wrong IV/tag lengths, non-canonical base64, non-string and missing fields, invalid keys (16/64 bytes, asymmetric) and key ids, no key material in `JSON.stringify`/`inspect(showHidden)` of the service, no plaintext/ciphertext/associated data/key in decryption errors.
- Refactor: removed a redundant double type assertion flagged by `no-unnecessary-type-assertion` in the test helper; no product change.
- Spec refinement (stricter, no behavior loss): IV, tag, and ciphertext must be canonical base64; non-canonical values are `UNSUPPORTED_PAYLOAD` instead of being silently repaired by Node's lenient decoder.
- `npm run check`: exit 0, 14 files, 294/294 tests.
- Commit: blocked (no git repository).

### T4 Composition-root wiring (route: delegated writer)

- No new runtime behavior: the adapter is now bound to a variable typed `EncryptionService` before reaching the use case, making the encrypt-only view explicit.
- Added a characterization test (not RED-driven, since there was no new implementation to drive): `compose()` with a 16-byte `KeyObject` throws `InvalidEncryptionKeyError`, so startup fails fast even if config validation were bypassed. Passed on first run.
- Grep `decrypt|PayloadDecryptor` in `src/`: only the port, the adapter, the error message, and a comment; nothing in the use case, presentation, or app wiring.
- `npx vitest run test/composition-root.test.ts` → 4/4. `npm run check`: exit 0, 14 files, 295/295 tests.
- Commit: blocked (no git repository).

### T5 Docs and final verification (route: delegated writer)

- `docs/encryption.md`: payload v1 and what is not stored, associated-data binding (JSON array, never delimiter concatenation), failure behavior and reason codes, pinned tag length, in-process key handling and the `process.env` limitation, dev-key setup, production key management (KMS/envelope, `keyId` rotation with a keyring, least privilege, runtime injection, secret scanning, IV budget), decryption policy.
- `npm run typecheck` exit 0; `npm run lint` exit 0; `npm test` exit 0 with 14 files, 295/295 tests; `npm run build` exit 0.
- `node dist/main.js` without `AUDIT_ENCRYPTION_KEY`: exit 1, printed only `Invalid configuration: - AUDIT_ENCRYPTION_KEY: Invalid input: expected string, received undefined`.
- Grep: the adapter imports only `node:crypto` (no pino, logger, or `console`); no 44-char base64 key or 64-char hex literal in `src/`, `test/`, or `docs/`; `package.json` dependencies unchanged.
- `.gitignore` ignores `.env` and `.env.*` and allows `.env.example`; `.env.example` does not exist yet (blocked by the `.env*` permission rule since the scaffold).
- Commit: blocked (no git repository).

### Outcome

All five tasks done. 46 new tests (38 adapter, 7 config, 1 composition root); suite 249 → 295.

Open items:

- `.env.example` still needs to be created by the user.
- Optional hardening not implemented: deleting `AUDIT_ENCRYPTION_KEY` from `process.env` after startup (documented as a limitation instead).
- Keyring for multi-key decryption is documented as the rotation path, not implemented.

## Next step

None for this feature. The use case slice must build associated data as `JSON.stringify([inquiryId, userId])`.
