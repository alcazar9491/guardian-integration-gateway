# Circuit breaker

The AI provider sits behind a consecutive-failure circuit breaker. When the provider keeps failing, the gateway stops calling it and answers immediately with the "Service Busy" fallback instead of making every client wait for another failure.

## Where the responsibilities live

| Layer | Owns | File |
|---|---|---|
| `shared/resilience` | **When** a call is allowed (policy, state machine) | `consecutive-failures-circuit-breaker.ts` |
| Infrastructure | Wrapping the AI provider, mapping "open" to a provider error | `ai-provider/circuit-breaker-ai-provider.ts` |
| Application | **What** the fallback says (`SERVICE_BUSY_REPLY`, `resolveFallback`) | `application/ai-fallback.ts` |
| Presentation | **How** the result looks over HTTP | `presentation/secure-inquiry.presenter.ts` |

The breaker knows nothing about AI, HTTP, or logging.

## States

| From | Event | To | Effect |
|---|---|---|---|
| CLOSED | success | CLOSED | consecutive failures reset to 0 |
| CLOSED | failure below the threshold | CLOSED | consecutive failures + 1 |
| CLOSED | failure reaching the threshold (3) | OPEN | cooldown starts |
| OPEN | call during the cooldown | OPEN | rejected immediately; the provider is not called |
| OPEN | first call after the cooldown | HALF_OPEN | that call is the single recovery probe |
| HALF_OPEN | call while the probe is in flight | HALF_OPEN | rejected immediately |
| HALF_OPEN | probe succeeds | CLOSED | consecutive failures reset to 0 |
| HALF_OPEN | probe fails | OPEN | cooldown restarts |

There are no timers: OPEN → HALF_OPEN is decided when the next call arrives, using an injected clock. Until a call arrives, `state` keeps reporting OPEN.

## Request-level contract

| Request | Breaker before | Provider called | Latency | Client receives | Breaker after |
|---|---|---|---|---|---|
| 1st failing | CLOSED (0) | yes, fails | ~2 s | fallback, `reason: PROVIDER_ERROR` | CLOSED (1) |
| 2nd failing | CLOSED (1) | yes, fails | ~2 s | fallback, `reason: PROVIDER_ERROR` | CLOSED (2) |
| **3rd failing** | CLOSED (2) | yes, fails | ~2 s | fallback, `reason: PROVIDER_ERROR` | **OPEN** |
| next | OPEN | **no** | milliseconds | fallback, `reason: CIRCUIT_OPEN` ("Service Busy") | OPEN |
| first after cooldown | OPEN → HALF_OPEN | yes (probe) | ~2 s | reply, or fallback `PROVIDER_ERROR` | CLOSED or OPEN |
| concurrent with the probe | HALF_OPEN | no | milliseconds | fallback, `reason: CIRCUIT_OPEN` | HALF_OPEN |

**The third failing request receives a fallback with `reason: PROVIDER_ERROR`, not an HTTP error.** It reached the provider and waited the full latency; that call is what failed. Opening the circuit is a consequence of its outcome, not something it experiences. Only requests arriving after the transition get `CIRCUIT_OPEN`.

All fallbacks share one reply text, `SERVICE_BUSY_REPLY`, which is exactly `"Service Busy"`. The `reason` field tells clients why: `PROVIDER_ERROR`, `TIMEOUT`, or `CIRCUIT_OPEN`. HTTP formatting (status 200, `status: DEGRADED`) is the presenter's job; the full contract is in [secure-inquiry-api.md](secure-inquiry-api.md).

## Fail-fast guarantee

`execute` is deliberately not `async`. It checks the state synchronously and, while short-circuiting, returns `Promise.reject(new CircuitOpenError())`: the operation function is never called and nothing is awaited. Tests prove it with an operation that would never settle, and with the mock provider configured at 2000 ms: the fourth call rejects in under 50 ms and the provider's delay ran only 3 times. The end-to-end test `test/e2e/circuit-breaker.e2e.test.ts` proves the whole request-level contract above through `POST /secure-inquiry`, with the real 2-second delay, the real audit store, and an injected clock for the cooldown.

## Concurrency

Node runs callbacks on one thread, so state changes between `await`s are atomic. The risks are interleavings:

1. **Generation guard.** Every transition increments a generation number. Each call records the generation it was admitted under; its outcome is applied only if the generation is unchanged. A burst of late failures cannot extend the cooldown, and a late success cannot close an OPEN or HALF_OPEN circuit.
2. **Single probe.** A `probeInFlight` flag admits exactly one HALF_OPEN call. Ten requests arriving after the cooldown produce one provider call and nine instant fallbacks.
3. **Completion order.** "Consecutive" is measured in the order outcomes arrive, not the order requests started.
4. **Admitted-before-open caveat.** CLOSED does not limit concurrency. Requests admitted before the circuit opened still reach the provider and wait; only requests arriving after the transition fail fast. Their late outcomes are ignored by rule 1.

## What counts as a failure

| Error | Counted |
|---|---|
| `AiProviderUnavailableError` (`PROVIDER_ERROR`, `TIMEOUT`) | yes |
| Any unexpected error | yes |
| `AiRequestCancelledError` (the caller gave up) | **no**: neither counted nor resetting the streak; a cancelled probe frees the slot for the next caller |

The classification is injected (`classifyError`); a classifier that throws is treated as a failure. A throwing `onStateChange` listener never affects the breaker or the caller's outcome.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `3` | Consecutive failures that open the circuit (integer ≥ 1) |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | `30000` | Time OPEN before one recovery probe (> 0) |

`CIRCUIT_BREAKER_RESET_TIMEOUT_MS` was renamed and is no longer read.

## Wiring

`buildAiProvider()` in the composition root creates **exactly one** breaker per process, called once from `compose()`. A breaker created per request would never see three consecutive failures and would never open.

`compose()` also returns `circuit`, a read-only view (`state`, `consecutiveFailures`) of that breaker for in-process observation and tests. It has no setters, cannot run calls through the breaker, and is not exposed over HTTP. `consecutiveFailures` holds the threshold while OPEN or HALF_OPEN and returns to 0 after a success or on close.

Transitions are logged as `AI provider circuit state changed` with `{ circuit: { from, to } }`: `warn` when opening, `info` otherwise. No request data is logged.

## Limitations

- State lives in memory, per process. Multiple replicas each have their own breaker.
- No bulkhead: CLOSED does not cap concurrent provider calls.
- One recovery probe at a time; there is no gradual ramp-up after closing.
