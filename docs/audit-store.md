# Audit store

Every inquiry leaves an audit trail: what was received (encrypted), what was forwarded (sanitized), for whom (pseudonymized), and how it ended. The store sits behind the `AuditRepository` port (`append`) and the verification-only `AuditReader` port (`findById`, `scan`). The adapter is `JsonlAuditRepository` in `src/secure-inquiry/infrastructure/audit/`.

> **Not production storage.** The JSON Lines file is safe for **one process** writing **one local file**. It is **not** safe for multiple containers, replicas, or processes sharing the file. See [Production replacement](#production-replacement).

## Record format (v1)

One JSON object per line:

```json
{
  "schemaVersion": 1,
  "auditId": "3f0c9a5e-…",
  "revision": 1,
  "createdAt": "2026-10-27T12:00:00.000Z",
  "recordedAt": "2026-10-27T12:00:00.004Z",
  "userRef": "kq1V…43 base64url chars",
  "sanitizedMessage": "Contact <REDACTED: EMAIL> about my order",
  "redactions": { "EMAIL": 1 },
  "encryptedMessage": { "algorithm": "aes-256-gcm", "version": 1, "keyId": "v1", "iv": "…", "authTag": "…", "ciphertext": "…" },
  "outcome": "PENDING"
}
```

| Field | Meaning |
|---|---|
| `auditId` | Generated per inquiry; the API returns it as `inquiryId` |
| `revision`, `recordedAt` | Which version of the record this line is, and when it was written |
| `createdAt` | When the inquiry was received |
| `userRef` | Keyed pseudonym of `userId` (see [Data minimization](#data-minimization)) |
| `sanitizedMessage` | The redacted text, readable in plaintext: exactly what may leave the service |
| `redactions` | Counts per PII type; never the values |
| `encryptedMessage` | The original, AES-256-GCM encrypted ([encryption.md](encryption.md)) |
| `outcome` | `PENDING`, `COMPLETED`, `PROVIDER_FAILURE`, `PROVIDER_TIMEOUT`, `CIRCUIT_OPEN_FALLBACK`, `CANCELLED`, `INTERNAL_ERROR` |

Never stored: the original in plaintext, the raw `userId`, any key, the associated data (rebuilt from `auditId` and `userRef`), and the AI reply (derivable from the sanitized message, so storing it adds exposure without adding evidence).

## Two revisions: audit before egress

1. **Revision 1, `PENDING`**, is appended **before** the AI provider is called. If it cannot be persisted, the provider is never called and the client gets `AUDIT_UNAVAILABLE`. No sanitized text leaves the service unaudited.
2. **Revision 2** carries the final outcome once the provider settles (or the circuit short-circuits it).

Every line is a complete record; readers keep the highest `revision` per `auditId`. A crash between the two writes leaves a `PENDING` record as evidence that the inquiry arrived.

If revision 2 cannot be persisted, the response is still returned and the failure is logged at `error` with the `auditId`, the outcome, and error codes only. The per-scenario table is in [secure-inquiry-api.md](secure-inquiry-api.md#audit-behavior).

## Data minimization

- `userId` is client-asserted and may itself be PII (an email, a 9-digit ID). The raw value is never written.
- Stored instead: `userRef = base64url(HMAC-SHA256(AUDIT_USER_REF_KEY, userId))`. Without the key it reveals nothing; an authorized investigator holding the key recomputes it to find a user's records.
- `AUDIT_USER_REF_KEY` is its own 32-byte key, validated at startup like the encryption key and **rejected if equal to it**: one key never serves two purposes, and the two rotate independently.
- Rotating `AUDIT_USER_REF_KEY` breaks lookups for older records (their `userRef` was computed under the old key). Rotate it rarely and deliberately, keeping the old key for lookups during the retention period.
- Retention and erasure are **not enforced** by the file store (that would require rewriting it). A production database enforces them (see below).

## Safe-write practices

| Practice | Why |
|---|---|
| JSON Lines, append-only | The file is never rewritten or truncated, so a crash cannot destroy earlier records |
| Open with `'a'` (`O_APPEND`) | Every write lands at the end of the file |
| `datasync()` before an append resolves | A record reported as written survives a crash or power loss |
| One in-process FIFO queue | Concurrent requests never interleave or lose lines; one failed write never blocks the next |
| Torn-tail repair | Before the first append of a process, and again after any failed append, a partial last line (from a crash, or bytes a failed write already put on disk) gets a newline, so it cannot swallow the next record |
| Whitelist serializer | Only the v1 fields are copied by name; a stray runtime property (say, an `originalMessage`) can never reach the file |
| Validate before writing | The store never holds a line it could not read back |
| File `0600`, directory `0700` | Only the service user can read the trail (POSIX; ignored on Windows) |
| `close()` on shutdown | `main` drains pending writes after the server stops accepting requests |

Not done (honest gap): `fsync` of the **directory** after the file is first created, so the very first record of a brand-new file can be lost if the machine crashes at that instant.

## Failure handling

| Situation | Behavior |
|---|---|
| Missing directory or file | Created on first append |
| `ENOSPC`, `EACCES`, `EROFS`, path is a directory, … | `AuditPersistenceError` (`AUDIT_UNAVAILABLE`); the errno is kept as `cause`, record content never appears in messages or logs; the next append is still attempted, after the torn-tail repair runs again |
| Invalid record (bad timestamp, unknown outcome, …) | Rejected before writing; error names field paths only |
| Missing file on read | Empty store |
| Malformed JSON, torn fragment, unknown fields, wrong schema version | Line skipped and counted in `invalidLines`; never thrown, never logged with its content |
| Unreadable file | `AuditReadError` (verification side only) |

The repository holds no logger. The API never returns encryption internals, `userRef`, or the original: the presenter copies only `requestId`, `inquiryId`, `status`, `source`, `reason`, `sanitizedMessage`, `reply`, and a test pins that.

## Limits of a JSON file as a database

- **Single writer only.** No cross-process lock: two processes, containers, or replicas appending to one file can interleave or corrupt lines, and torn-tail repair can race.
- **Network filesystems** (NFS, EFS, SMB) do not guarantee `O_APPEND` atomicity.
- **Replicas split the trail.** Each container with its own volume keeps its own partial file.
- **No indexes or queries.** `findById` scans the whole file: O(n).
- **No transactions.** The two revisions are independent writes.
- **No retention or erasure** without rewriting the file, and **unbounded growth** (no rotation or compaction).
- **No tamper evidence.** Anyone with write access can edit lines; strict parsing only flags malformed ones.
- **File-level access control only**, and the sanitized messages are plaintext to anyone who can read the file.

## Production replacement

Use **PostgreSQL** (or another managed relational database):

- An **append-only `audit_records` table**; the service role gets `INSERT` only, no `UPDATE` or `DELETE`. Store the outcome as a second row (or in an `audit_outcomes` table) to keep the two-revision model.
- `encrypted_message` as `JSONB`, `user_ref` and `created_at` indexed for investigations.
- **Monthly partitioning**, so retention is a cheap `DROP PARTITION` instead of a rewrite.
- **Point-in-time recovery** backups, TLS in transit, encryption at rest, and the application-level AES-GCM kept on top with **KMS envelope encryption** for the data key.
- For stronger tamper evidence, add a **hash chain** (each row stores the hash of the previous one) or ship records to **WORM storage** (for example S3 Object Lock).
- Concurrency, durability, and multi-replica writes then come from the database, and the in-process queue becomes unnecessary.
