# ADR-0002 — Logical database per service on one MongoDB replica set

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** Platform, Orders, Checkout

## Context

Nine of the ten services need domain persistence (api-gateway holds only the shared idempotency store). MongoDB is the required datastore (the "M" in MERN). Two decisions have to be made: how data is partitioned between services, and how many physical clusters run.

Shared-schema access — several services reading and writing the same collections — is the pattern that most reliably turns microservices into a distributed monolith. It makes every schema change a cross-team coordination problem, and it means no team can reason about who mutates their data.

At the same time, the transactional outbox pattern that the whole design rests on ([ADR-0003](0003-transactional-outbox-with-rabbitmq.md)) requires multi-document transactions, which MongoDB provides only on a replica set.

## Decision

**One logical database per service, exclusive ownership, no cross-database queries in application code.** Ten logical databases: nine domain databases plus the api-gateway's idempotency store. A service reads and writes only its own database. Anything it needs from another domain arrives as an event and is stored as a locally-owned copy — a deliberate denormalisation, recorded as such.

**One physical replica set (`rs0`) for all logical databases**, in the initial deployment. Per-service physical clusters are a later operational change, not a code change, and the split can be done service by service when a service's load or availability requirements justify it.

Additionally: every document carries `tenantId` as its first field and as the leading field of every compound index; the connection string per service names only its own database; and cross-service joins are impossible by construction because a service holds no credentials for another's database.

## Consequences

**Positive.** Each team owns its schema and can change it without coordination, which is the property that makes independent deploys real. Multi-document transactions are available for the outbox, aggregate writes, and the search projection. Blast radius is bounded — a bad migration in invoice-service cannot corrupt orders. Per-service physical separation later requires no application change.

**Negative.** No cross-service joins, so any view spanning domains is assembled by the BFF (with DataLoader batching) or served from a locally-maintained projection. Denormalised copies can drift, which is why the nightly reconciliation job in [DATA-INTEGRITY §11](../DATA-INTEGRITY.md#11-reconciliation-the-backstop) exists rather than being optional. A single physical cluster is a shared failure domain and a shared noisy-neighbour surface until we split it; accepted at current scale, monitored per-database.

**Neutral.** Sharding, when it comes, is on `tenantId` — already the leading field of every index, which is precisely why that convention is enforced by a lint rule rather than left to preference.

## Alternatives considered

**Shared database, shared collections.** Simplest to start and the fastest path to a distributed monolith. Rejected outright: it eliminates the autonomy that justifies having services at all.

**Shared database, schema-per-service with read-only cross-access.** Tempting because it permits joins for reporting. Rejected because read access to another team's tables becomes a de facto contract that they cannot change — the coupling is real even though it is read-only, and it is invisible in the code.

**Separate physical cluster per service from day one.** The correct end state for payment-service, and probably invoice-service. Rejected for now on operational cost: nine clusters to provision, monitor, back up, and upgrade before we have the traffic to justify any of it. Because the logical boundaries are already strict, deferring this costs nothing in code and everything it defers is operational.

**PostgreSQL instead.** Would give stronger relational guarantees for financial data, which is a genuine argument for invoice-service. Rejected because MongoDB was specified, the document model genuinely fits order-with-items as one aggregate, and the integrity requirements are met by integer money, aggregate-enforced invariants, and reconciliation. Recorded as a real trade-off rather than a non-issue.
