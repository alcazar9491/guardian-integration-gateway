# AI provider

The gateway talks to its AI provider through one port. The provider is simulated: no external API, no network, no randomness.

## Port contract

```ts
interface AiProvider {
  reply(prompt: RedactedText, options?: { signal?: AbortSignal }): Promise<string>;
}
```

| Outcome | Result |
|---|---|
| Success | Resolves with the reply text |
| Provider failed | Rejects with `AiProviderUnavailableError`, `reason: 'PROVIDER_ERROR'` |
| Too slow | Rejects with `AiProviderUnavailableError`, `reason: 'TIMEOUT'` |
| Circuit open | Rejects immediately with `AiProviderUnavailableError`, `reason: 'CIRCUIT_OPEN'` |
| Caller aborted | Rejects with `AiRequestCancelledError` |

Error messages never contain the prompt.

## Adapter chain

```
CircuitBreakerAiProvider      counts failures, short-circuits while open (docs/circuit-breaker.md)
  └─ TimeoutAiProvider        AI_PROVIDER_TIMEOUT_MS → TIMEOUT
       └─ MockAiProvider      AI_PROVIDER_DELAY_MS latency, AI_PROVIDER_FAILURES schedule
```

Each decorator has one job. All three live in `src/secure-inquiry/infrastructure/ai-provider/`; none imports Express, HTTP, `process`, or a logger.

## MockAiProvider

- Replies `Generated Answer: <sanitized message>` after `AI_PROVIDER_DELAY_MS` (default 2000).
- Failures also arrive after the delay, like a remote error would.
- The delay uses `node:timers/promises`: concurrent calls overlap and the event loop stays free.
- Aborting the signal clears the timer and rejects immediately.

## Deterministic failure injection

`AI_PROVIDER_FAILURES` selects an outcome schedule:

| Value | Behavior |
|---|---|
| `never` (default) | Every call succeeds |
| `always` | Every call fails with `PROVIDER_ERROR` |
| `first:<n>` | The first `n` calls fail, then every call succeeds |

The outcome is fixed **when a call is made**, so concurrent calls fail in call order, not completion order. A call made with an already-aborted signal consumes no outcome; a call aborted during the delay has already consumed its own.

The service logs one warning at startup whenever the value is not `never`. Failure behavior exists only in infrastructure and configuration; the domain and use case know nothing about it.

Tests use the schedules directly: `alwaysSucceed()`, `alwaysFail()`, `failFirst(n)`, and `scripted([...], { then })` for any sequence.

## Circuit breaker demo recipe

The breaker is wired into `POST /secure-inquiry` (see `docs/circuit-breaker.md` and `docs/secure-inquiry-api.md`):

1. Start with `AI_PROVIDER_FAILURES=first:3` (default threshold 3).
2. Requests 1–3 wait ~2 s each and return the fallback (`PROVIDER_ERROR`).
3. Request 4 returns the "Service Busy" fallback immediately (`CIRCUIT_OPEN`): the provider is not called.
4. After `CIRCUIT_BREAKER_COOLDOWN_MS`, one probe reaches the provider, succeeds (the schedule has recovered), and closes the circuit.

## Timeout vs cancellation

| | Timeout | Cancellation |
|---|---|---|
| Who gives up | The gateway, after `AI_PROVIDER_TIMEOUT_MS` | The caller (e.g. client disconnected) |
| Error | `AiProviderUnavailableError('TIMEOUT')` | `AiRequestCancelledError` |
| Counts as a breaker failure | **Yes**: the provider is too slow | **No**: the provider did nothing wrong |

If both happen at once, cancellation wins. Counting cancellations would let impatient clients open the circuit on a healthy provider.

`TimeoutAiProvider` passes an abort signal down **and** races the reply, so even a provider that ignores its signal still times out. Its timer is cleared as soon as the call settles.

## The provider never sees the original message

Three layers, each enforced by tooling:

1. **Compile time.** `reply` accepts only `RedactedText`, a branded string. Passing a raw `string` does not compile; a `@ts-expect-error` test fails the typecheck if that ever changes.
2. **Lint.** `no-restricted-syntax` forbids `as RedactedText`, `<RedactedText>`, and `RedactedText` as an explicit call type argument anywhere in `src/` except `src/secure-inquiry/domain/sanitization/`. The sanitizer is the only producer.
3. **Runtime test.** Real sanitizer output piped through the provider yields `<REDACTED: …>` labels and never the original email, card, or SSN.
