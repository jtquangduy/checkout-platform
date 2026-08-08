# ADR-0006 — Idempotency keys required on every mutation, derived on internal steps

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** Checkout, Platform

## Context

The hardest failure in payments is not a decline — it is ambiguity. A capture request times out and we genuinely do not know whether the money moved. Retrying blind risks a double charge; assuming failure risks charging a customer and telling them it did not work.

The same ambiguity appears at every layer: a user double-clicks *Pay*, a mobile network retries a request, a saga step re-runs after a pod restart, a broker redelivers a message.

Many systems treat idempotency as an optional header that clients *may* supply. In practice, an optional safety mechanism is one that is missing precisely in the code path that needed it.

## Decision

**`Idempotency-Key` is required, not optional**, on every `POST`, `PATCH`, and `DELETE`. A request without one gets `400 IDEMPOTENCY_KEY_REQUIRED`. Enforced by shared middleware and a lint rule, so a new endpoint cannot forget it.

**Records are stored keyed on `{tenantId, method, path, key}`** with the request hash, the response status, and the response body. A replay returns the byte-identical original response. The same key with a *different* body returns `422` rather than silently applying whichever arrived second. `5xx` responses are not cached, so a server error remains genuinely retryable. TTL 24 hours, in Redis with a Mongo durable copy — a Redis eviction must not silently disable idempotency.

**Internal keys are derived, not random.** Saga steps compute theirs deterministically as `${checkoutSessionId}:${STEP_NAME}`. This is the crucial part: a retry of the capture step — even after a pod restart, even hours later — reaches the PSP with the *identical* key and therefore cannot produce a second charge.

**Ambiguous outcomes are resolved by query, not by guess.** On a PSP timeout, payment-service looks the intent up by idempotency key before retrying. If the lookup is also unavailable, the payment stays `PENDING` and a reconciliation job resolves it.

**Consumers dedupe separately** via the inbox ([ADR-0003](0003-transactional-outbox-with-rabbitmq.md)), and business-level unique indexes provide a third layer: one captured payment per order, one invoice per order, one production job per order, one email per `(event, template, recipient)`.

## Consequences

**Positive.** N identical requests produce one effect and N identical responses, which is a guarantee a client can actually build retry logic against. A double-clicked button is a non-event. A `504` on the checkout endpoint has a correct, documented client response. And the guarantee is enforced by unique indexes rather than by application logic, so a refactor cannot quietly remove it.

**Negative.** Clients must generate and reuse a key per attempt, which is a documented API requirement and one line in the portal (`useIdempotencyKey`). The idempotency store adds a Redis round trip (~3 ms) to every mutation. Storing response bodies costs storage, bounded by the 24-hour TTL.

**Neutral.** Duplicate detection is instrumented as a normal metric rather than an error, since at-least-once delivery makes duplicates expected. A *spike* in duplicates is the useful signal, and it is only visible because the baseline is measured.

## Alternatives considered

**Optional idempotency keys.** Rejected. The endpoint where a developer forgets the header is, by Murphy's law, the one that charges cards.

**Natural idempotency via unique business constraints only.** The unique indexes are kept as a defence layer, but they are not sufficient alone: they prevent the duplicate *effect* while returning a confusing duplicate-key error rather than the original successful response. The client needs the latter.

**Client-generated request IDs with server-side "have I seen this?" lookup.** This is essentially the chosen design; the important refinement is that the *insert itself* is the check (unique index), because a read-then-write has a race window that two concurrent deliveries will find.

**Rely on the PSP's own idempotency only.** Necessary but insufficient — it protects the charge, not our own state transitions, our invoice creation, or our email sending.
