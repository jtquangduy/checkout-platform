# ADR-0004 — Hybrid saga: orchestrated pre-capture, choreographed post-capture

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** Checkout, Fulfilment, Finance, Staff Engineers

## Context

A checkout spans five systems with no shared transaction: order-service, catalog-pricing, payment-service (and behind it a third-party PSP), invoice-service (and behind it an accounting ledger), and the internal Production system. We need a consistency strategy.

The critical observation is that a checkout has **two phases with opposite failure philosophies**. Before the PSP confirms capture, nothing external has changed, so a failure should abort cleanly and the customer should be told nothing happened. After capture, the customer *has paid*, and every remaining step — invoice, Production push, email — is an obligation we now owe them, so a failure must be retried rather than rolled back.

Forcing one mechanism to serve both is what makes most checkout implementations fragile.

## Decision

A **saga**, not distributed transactions — and specifically a **hybrid** one.

**Pre-capture: orchestrated and synchronous.** `checkout-orchestrator` owns a persisted state machine that runs validate → verify quote → reserve → capture in strict order, each step with its own retry policy and compensation. Failure aborts: the reservation is released, nothing is charged, no email is sent, and the API returns a mapped, human-readable reason.

**Post-capture: choreographed and asynchronous.** One `checkout.completed.v1` event fans out to three independent consumers, each owning its own obligation, retry ladder, and dead-letter queue. Failure retries — for up to ~75 minutes, then escalates to a human — and never automatically reverses the payment.

**The one exception:** a *permanent* rejection from the Production system (a structurally unprocessable job) triggers an automatic refund saga. A *transient* failure never does. That transient/permanent classification is explicit, unit-tested code in the anti-corruption layer, not a retry library's default.

Saga state is persisted in `saga_instances`, so a pod restart resumes rather than abandoning a customer's transaction. Every step is idempotent, and every step's compensation is idempotent, because compensations are retried aggressively and may run against already-compensated state.

## Consequences

**Positive.** Checkout returns in ~780 ms instead of the 8–15 s a fully synchronous flow would take, because the three slow obligations are off the critical path. Each obligation fails and recovers independently — an accounting outage does not delay the Production push. The pre-capture sequence lives in one readable place with one timeout policy, so "what order do these happen in?" has an answer in code rather than in a diagram. And the post-capture flow is extensible: adding analytics or a partner webhook is a new queue binding, with no change to the orchestrator.

**Negative.** Two mechanisms to understand instead of one, which is a real onboarding cost — mitigated by [CHECKOUT-SAGA](../CHECKOUT-SAGA.md) documenting every branch. There is no global atomicity, so intermediate states are observable: `PAID_AWAITING_PRODUCTION` is a state a customer can be in, which is why it is explicitly modelled and alerted on rather than treated as impossible. Debugging spans services, which is why trace context propagates through AMQP headers as well as HTTP.

**Neutral.** The choreographed half is what makes assumption [A1](../ASSUMPTIONS.md#a1-otherwise-in-the-brief-means-and-not-or-highest-risk) — the ambiguous "otherwise" in the brief — cost half a day to change instead of a redesign. That was a deliberate hedge against the least certain requirement.

## Alternatives considered

**Two-phase commit / XA.** Not available across a third-party PSP or the internal Production system. Would also be undesirable: a coordinator failure holds locks across every participant, converting any single outage into a total one. Sagas trade atomicity for availability, which is correct when participants are external.

**Fully orchestrated, including invoice, production, and email.** Rejected because it makes the orchestrator the availability floor for everything downstream. With a Production outage, the orchestrator would either block the customer or persist a retry loop — which is a queue, implemented worse.

**Fully choreographed, including pre-capture.** Rejected because nobody would own the sequence. Reserve-then-capture has a strict order and a hard timeout; expressing that as events scatters the protocol across services and leaves the complete flow existing only in documentation, where it rots.

**Do everything synchronously in one request.** Simplest to read and wrong. Checkout latency becomes the sum of the slowest of three external systems, and a post-capture failure leaves the request with no correct response.

**Event sourcing the order aggregate.** Genuinely attractive: a perfect audit trail, free temporal queries, natural projections, and no need for a separate outbox. Rejected on team-cost grounds — it is a substantial conceptual load for 10–20 engineers of mixed seniority, and the audit requirement is met more cheaply by `statusHistory` plus the append-only payment transaction log. Deliberately not precluded: the outbox already emits a complete domain event stream, so adopting event sourcing later means treating that stream as the source of truth rather than rewriting the model. Revisit once the team is larger and the domain has stopped moving.
