# Audit encryption

The original inquiry message is encrypted with AES-256-GCM before it reaches the audit store. The adapter (`src/secure-inquiry/infrastructure/aes-gcm-encryption-service.ts`) uses only `node:crypto`, holds no logger, and never puts plaintext, ciphertext, or key material in an error.

## Payload v1

```json
{
  "algorithm": "aes-256-gcm",
  "version": 1,
  "keyId": "v1",
  "iv": "<base64, 12 random bytes>",
  "authTag": "<base64, 16 bytes>",
  "ciphertext": "<base64, same length as the UTF-8 plaintext>"
}
```

| Field | Purpose |
|---|---|
| `algorithm`, `version` | Let future readers reject or migrate payloads they do not understand |
| `keyId` | Names the key that encrypted the payload, so keys can rotate |
| `iv` | Fresh `randomBytes(12)` for every encryption, never reused |
| `authTag` | GCM authentication tag; any change to IV, ciphertext, or associated data invalidates it |
| `ciphertext` | The encrypted original message |

Deliberately **not** stored: the key, the plaintext, and the associated data.

## Associated data binds a ciphertext to its record

GCM authenticates extra "associated data" without encrypting it. The associated data is the audit record identity, `JSON.stringify([auditId, userRef])`, built by the shared domain function `auditAssociatedData` (`src/secure-inquiry/domain/audit-associated-data.ts`). Decrypting requires the same value, so a ciphertext copied onto another record, or a record whose `userRef` was altered, fails authentication.

It is rebuilt from the audit record's own stored fields at verification time, never stored separately, and never needs the raw `userId` (which is not stored; see [audit-store.md](audit-store.md)). A JSON array keeps it unambiguous, unlike `auditId + ':' + userRef`, whatever characters the values contain.

## Failure behavior

- **Startup.** A missing, non-canonical, or wrong-length `AUDIT_ENCRYPTION_KEY`, or an invalid `AUDIT_ENCRYPTION_KEY_ID`, stops the process with exit code 1 and an `Invalid configuration` message that names variables, never values. The adapter re-checks the key (32-byte secret `KeyObject`) and key id, so a bypassed config still fails fast.
- **Decryption.** Failures throw `DecryptionError` with a reason code only:

| Reason | When |
|---|---|
| `UNSUPPORTED_PAYLOAD` | Unknown algorithm or version, wrong IV or tag length, non-canonical base64, missing or non-string fields |
| `UNKNOWN_KEY` | `keyId` does not match the configured key |
| `AUTHENTICATION_FAILED` | Wrong key, tampered IV/tag/ciphertext, or wrong associated data |

`AUTHENTICATION_FAILED` deliberately does not distinguish its causes: GCM cannot, and the API must not offer an oracle.

- **Tag length is pinned.** Decryption requires a 16-byte tag and passes `authTagLength: 16`. Without that option, Node 24 still accepts truncated tags down to 4 bytes (only a deprecation warning), which makes forging a valid tag far cheaper.

## Key handling inside the process

- The configuration converts the base64 key into an opaque `KeyObject` and zero-fills the decoded buffers. Logging, inspecting, or serializing the configuration or the adapter never prints key bytes; tests pin this.
- Limitation: the original string in `process.env` cannot be wiped and stays readable by any code in the process. In production prefer a mounted secret file or a secret-manager fetch at startup over a plain environment variable.

## Development key setup

1. Generate two keys (run the command twice):

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

2. Put them in a local `.env` file (gitignored):

   ```dotenv
   AUDIT_ENCRYPTION_KEY=<first generated value>
   AUDIT_ENCRYPTION_KEY_ID=v1
   AUDIT_USER_REF_KEY=<second, different generated value>
   ```

   `AUDIT_USER_REF_KEY` keys the userId pseudonym ([audit-store.md](audit-store.md)); startup rejects it if it equals the encryption key.

3. Run `npm run dev`, which loads `.env` through Node's `--env-file-if-exists`.

Rules:

- `.env.example` documents the variables with an **empty** key. Never fill it in.
- A dev key never leaves your machine: not in tickets, chat, docs, screenshots, or another environment.
- Losing the key makes every original encrypted with it unrecoverable. That is acceptable in development; generate a new one.

## Production key management

- **Use a KMS or secret manager** (AWS KMS / Secrets Manager, Google Cloud KMS / Secret Manager, Azure Key Vault, HashiCorp Vault). Never a committed file.
- **Envelope encryption.** A master key stays inside the KMS and wraps a data key. The service unwraps the data key at startup and uses it here; `keyId` names the wrapped data key.
- **Rotation via `keyId`.** New writes use the newest key; retired keys stay decrypt-only in a keyring looked up by `keyId`. The current adapter holds one key, so a payload from another key fails with `UNKNOWN_KEY`. A keyring is the planned extension.
- **Least privilege.** The gateway only needs to encrypt. Verification tooling runs under a separate, narrowly granted role, and every decrypt is logged by the KMS for audit.
- **Runtime injection.** Inject secrets at runtime (orchestrator secrets, mounted files, CSI secret drivers). Never bake them into images, Dockerfiles, or Compose files. Compose with a local `.env` is for development only.
- **Secret scanning.** Run a scanner such as gitleaks in pre-commit and CI. Treat any exposed key as compromised: rotate immediately.
- **IV budget.** With random 96-bit IVs, NIST SP 800-38D caps a key at about 2^32 encryptions. Rotate well before that (for example, alert at 2^30 audit writes per key).

## Decryption policy

- `PayloadDecryptor` exists for automated tests and authorized internal verification only.
- It is never wired into the use case or exposed over HTTP: the composition root hands the adapter to the use case typed as `EncryptionService`.
- Future verification tooling must run offline, under an identified operator and the dedicated decrypt role, and record who decrypted which record.
