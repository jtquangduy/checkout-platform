# ADR-0003 — Transactional outbox, relayed to RabbitMQ

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** Platform, Checkout, Fulfilment

## Context

When payment-service captures funds it must both change its own state and tell three other services. Those are two different systems, so there are two possible orderings and both are broken. Publishing first means a broker accept followed by a failed database write, producing an invoice for a charge that never happened. Writing first means a committed database change followed by a crash before publishing — money captured, no invoice, no Production push, no email, silently, forever.

The second is the failure this system cannot tolerate. It is also the one that fails in the direction the customer notices last: they paid, they got a receipt page, and nothing happened.

Separately, we need a broker. The requirements are reliable per-entity task delivery, per-message retry with backoff, dead-lettering with operator replay, and independent consumer failure — not a high-throughput replayable log.

## Decision

**Transactional outbox.** Domain events are inserted into an `outbox` collection in the *same MongoDB transaction* as the state change they describe. A relay loop in each service claims pending rows, publishes them to RabbitMQ with publisher confirms, and marks them published. Provided by `packages/kernel` as `withOutbox()`, so no team implements it twice.

**RabbitMQ**, one durable topic exchange (`checkout.events`), one **quorum** queue per consumer, an `x-delayed-message` retry exchange, and a dead-letter exchange with a DLQ per queue.

The relay **polls** on an indexed `{status, availableAt}` query every 250 ms rather than using change streams.

Delivery is therefore **at-least-once**, which is only safe because every consumer is idempotent via an inbox table ([DATA-INTEGRITY §4](../DATA-INTEGRITY.md#4-idempotent-consumers-the-inbox)). The two decisions are inseparable: the outbox guarantees no event is lost, and the inbox guarantees no event is applied twice.

## Consequences

**Positive.** The dual-write problem is eliminated: it is structurally impossible for money to be captured without the follow-on obligations existing durably. The outbox doubles as an audit log of every event a service emitted. `platform_outbox_lag_seconds` is a free, high-value health signal — a rising value is the earliest possible warning that events have stopped flowing, ahead of any customer noticing. Quorum queues survive a broker node loss, which classic mirrored queues do not reliably do.

**Negative.** Duplicates are guaranteed, so idempotent consumers are mandatory rather than good practice — enforced by the shared `defineConsumer` helper so it cannot be forgotten. There is a small publish latency added by polling — a mean of ~125 ms and a worst case of 250 ms at a 250 ms interval. The outbox collection needs a TTL on published rows to avoid unbounded growth. And the relay needs leader-safe claiming, solved with `findOneAndUpdate` leases rather than a separate lock.

**Neutral.** RabbitMQ gives no long-term replay. A bug that corrupts a projection therefore needs a rebuild-from-aggregate job, which exists (`POST /ops/projections/order-search/rebuild`) rather than being implied.

## Alternatives considered

**Publish directly from the use case, best-effort.** Rejected — it is exactly the dual-write bug, and its failure mode is silent.

**MongoDB change streams instead of polling.** More elegant and lower-latency; this was the first choice. Rejected because a change-stream consumer must persist a resume token and correctly handle `ChangeStreamHistoryLost` after an outage longer than the oplog window — a subtle failure mode whose payload is *silently skipped events*, which is the one outcome this ADR exists to prevent. Polling at 250 ms costs a few hundred trivial indexed queries per second and yields a lag metric for free. Revisit if outbox volume grows an order of magnitude.

**Kafka instead of RabbitMQ.** Stronger for replay, retention, ordering per partition, and analytics. Rejected for now because our need is per-message retry and DLQ with operator replay, which is RabbitMQ's core competence and Kafka's weak point — per-message nack and delayed redelivery require building a retry-topic ladder by hand. Kafka becomes the right answer when we want an analytics log or event sourcing; the migration path is straightforward because the outbox already produces a complete, ordered event stream and only the relay's sink would change.

**Two-phase commit between MongoDB and RabbitMQ.** Not available, and would be undesirable anyway — a coordinator failure would hold locks across both systems.

**Event sourcing the aggregates.** Would make the outbox unnecessary since the event log *is* the state. Genuinely attractive here, and rejected on team-cost grounds in [ADR-0004](0004-saga-over-two-phase-commit.md).
