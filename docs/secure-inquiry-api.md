# POST /secure-inquiry

Sanitizes a message, encrypts the original into the audit trail, asks the AI provider (through a timeout and a circuit breaker) using only the sanitized text, and returns the answer or a "Service Busy" fallback.

## Request

```http
POST /secure-inquiry
Content-Type: application/json

{ "userId": "user-123", "message": "My card is 4111 1111 1111 1111, can you help?" }
```

| Rule | Limit |
|---|---|
| Media type | `application/json`, no charset or `charset=utf-8` only (RFC 8259). Anything else → 415 |
| Body size | `REQUEST_BODY_LIMIT_BYTES` (default 16384) → 413 |
| Fields | exactly `userId` and `message`; unknown fields → 400 |
| `userId` | string, trimmed, 1–128 characters |
| `message` | string, 1–5000 characters, not blank |

## Responses

Success and fallback share one schema:

```json
{
  "requestId": "6f1c2a0e-…",
  "inquiryId": "0b7e9c4d-…",
  "status": "COMPLETED",
  "source": "AI_PROVIDER",
  "sanitizedMessage": "My card is <REDACTED: CREDIT_CARD>, can you help?",
  "reply": "Generated Answer: My card is <REDACTED: CREDIT_CARD>, can you help?"
}
```

```json
{
  "requestId": "…",
  "inquiryId": "…",
  "status": "DEGRADED",
  "source": "FALLBACK",
  "reason": "CIRCUIT_OPEN",
  "sanitizedMessage": "My card is <REDACTED: CREDIT_CARD>, can you help?",
  "reply": "Service Busy"
}
```

- `requestId` matches the `X-Request-Id` header (a well-formed incoming one is echoed).
- `inquiryId` is the audit record's `auditId`.
- `reason` (fallback only): `PROVIDER_ERROR`, `TIMEOUT`, or `CIRCUIT_OPEN`.
- Never returned: the original message, the raw `userId`, `userRef`, ciphertext, IV, auth tag, keys, stack traces.

Errors use one envelope; `details` appears only for validation errors and names fields, never values:

```json
{
  "requestId": "…",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": [{ "path": "message", "issue": "Message must not be blank" }]
  }
}
```

## Status codes

| Status | `code` | When |
|---|---|---|
| 200 | — | `COMPLETED`, or `DEGRADED` fallback |
| 400 | `VALIDATION_ERROR` | missing field, wrong type, empty or blank string, unknown field, too long |
| 400 | `MALFORMED_JSON` / `BAD_REQUEST` | invalid JSON / other body-parser 4xx |
| 404 | `NOT_FOUND` | unknown route (bodies are never parsed there) |
| 413 | `PAYLOAD_TOO_LARGE` | body over the limit |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | not JSON, or a charset other than UTF-8 |
| 499 | `AI_REQUEST_CANCELLED` | cancelled while the client was still connected (rare; a disconnected client gets nothing) |
| 500 | `AUDIT_UNAVAILABLE` | the `PENDING` audit revision could not be written; the provider was not called |
| 500 | `INTERNAL_ERROR` | anything unexpected; generic message only |

## Security headers

Every response carries these, errors, 404s, and `/health` included (`src/shared/http/security-headers.ts`, registered first in `src/app.ts`):

| Header | Value | Why |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Responses echo user text; a browser must never sniff them as HTML or script |
| `Cache-Control` | `no-store` | Sanitized messages and replies must not linger in browser or proxy caches |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` | A JSON API loads nothing and is never framed |
| `X-Frame-Options` | `DENY` | Framing protection for clients that ignore `frame-ancestors` |
| `Referrer-Policy` | `no-referrer` | No URL leaks to other origins |
| `Cross-Origin-Resource-Policy` | `same-origin` | Other origins cannot embed the responses |

`Strict-Transport-Security` is deliberately not set: TLS terminates upstream (load balancer or ingress), and HSTS belongs to the component that serves HTTPS. Setting it here over plain HTTP would be ignored by browsers and would mislead about where TLS is enforced.

## Processing order

1. Validate the body (zod schema).
2. Sanitize the message; pseudonymize the `userId`; encrypt the original bound to `[auditId, userRef]`.
3. Append audit revision 1 (`PENDING`). If this fails, stop with 500: nothing has left the service.
4. Call the provider with the sanitized text only, through the timeout and the circuit breaker.
5. Append audit revision 2 with the outcome, then respond.

## Audit behavior

| Scenario | Revision 1 `PENDING` | Provider called | Revision 2 outcome | HTTP response |
|---|---|---|---|---|
| Invalid body | no | no | — | 400 / 413 / 415 |
| Revision 1 write fails | fails | no | — | 500 `AUDIT_UNAVAILABLE` |
| Provider success | yes | yes | `COMPLETED` | 200 `COMPLETED` |
| Provider failure | yes | yes | `PROVIDER_FAILURE` | 200 `DEGRADED` / `PROVIDER_ERROR` |
| Provider timeout | yes | yes (aborted) | `PROVIDER_TIMEOUT` | 200 `DEGRADED` / `TIMEOUT` |
| Circuit open | yes | no | `CIRCUIT_OPEN_FALLBACK` | 200 `DEGRADED` / `CIRCUIT_OPEN`, in milliseconds |
| Client disconnects | yes | yes (aborted) | `CANCELLED` | none (connection gone) |
| Unexpected error | yes | maybe | `INTERNAL_ERROR` | 500 `INTERNAL_ERROR` |
| Revision 2 write fails | yes | yes | missing; logged at `error` | the response the outcome dictates |

**Revision 2 failure policy.** Revision 1 already holds the encrypted original and the sanitized text, and the provider has already been called. Failing the response at that point would only make the client retry and call the provider again. The response is returned, and the failure is never silent: `Audit outcome could not be recorded` is logged at `error` with the `auditId`, the outcome, and error names and codes only (for example `rootCode: ENOSPC`). Repeated failures surface on the next request anyway, because its revision 1 write fails closed.

## Why fallbacks are HTTP 200

The request was accepted, validated, sanitized, and audited, and the fallback is a deliberate, well-formed answer, so it is a degraded success, not an error. `status: DEGRADED` and `reason` let clients and dashboards tell it apart.

The legitimate alternative is **503 + `Retry-After`** while the circuit is open (seconds until the next probe). Load balancers, retry middleware, and 5xx alerting understand it natively. It is a presenter-only change if the contract ever requires it; the use case and the breaker would not change.

## Cancellation

The controller aborts the use case's signal when the response closes before it finished. It listens on `res`, not `req`: `req.on('close')` fires as soon as the body has been read. A cancelled call:

- aborts the provider's delay and audits `CANCELLED`;
- never counts as a circuit-breaker failure;
- sends no response (the socket is gone); the error handler logs `Client disconnected before the response was sent` at `info`.
