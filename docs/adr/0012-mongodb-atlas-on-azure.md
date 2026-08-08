# ADR-0012 — MongoDB Atlas on Azure, not Cosmos DB for MongoDB

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** Platform, Orders, Checkout, Finance
- **Related:** [ADR-0002](0002-database-per-service.md) (database per service), [ADR-0003](0003-transactional-outbox-with-rabbitmq.md) (outbox), [ADR-0007](0007-transactional-search-read-model.md) (search)

## Context

Deploying onto Azure raises the obvious question of whether the datastore should be first-party. Azure offers two MongoDB-compatible options — Cosmos DB for MongoDB (RU-based) and Cosmos DB for MongoDB vCore — and MongoDB Atlas runs as a managed service inside Azure regions.

The choice is unusually constrained, because two decisions already made depend on specific MongoDB capabilities rather than on the wire protocol.

**The transactional outbox requires multi-document ACID transactions.** [ADR-0003](0003-transactional-outbox-with-rabbitmq.md) writes the aggregate change and the outbox event in one transaction, and that single atomic write is what makes it structurally impossible for money to be captured without the follow-on obligations existing durably. It is the foundation the entire design rests on. A datastore with partial or awkward transaction support does not merely inconvenience us — it removes the guarantee.

**The search upgrade path is Atlas Search.** [ADR-0007](0007-transactional-search-read-model.md) meets its SLO today with a normalised token index, and names Atlas Search behind a feature flag as the route to fuzzy matching, autocomplete analysers, relevance scoring, and highlighting — with both implementations behind one repository interface so the switch is a config flag.

Secondary but real: `order_search_view` is updated in the same transaction as the aggregate ([ADR-0007](0007-transactional-search-read-model.md)), the outbox relay depends on efficient indexed polling with `findOneAndUpdate` leases, and the design assumes gapless invoice numbering via an atomic `$inc` inside a transaction ([DATA-INTEGRITY §10](../DATA-INTEGRITY.md#10-gapless-invoice-numbering)).

## Decision

**MongoDB Atlas, deployed into the same Azure region as the Container Apps environment**, reached over Azure Private Link with no public endpoint. M30 three-node zone-redundant replica set in production, M10 in staging and dev.

Full multi-document transactions, Atlas Search available when the flag flips, real change streams if we ever move the outbox relay off polling, continuous backup with minute-granularity point-in-time restore, and a cross-region replica for the DR posture in [DEPLOYMENT §11](../DEPLOYMENT.md#11-backup-and-disaster-recovery).

Physically one cluster; logically ten databases with exclusive per-service ownership, exactly as [ADR-0002](0002-database-per-service.md) specifies. Nothing about the data model changes.

## Consequences

**Positive.** Every capability the design already depends on is present, with the same semantics as local development and the same semantics the integration tests exercise against a real replica set in Testcontainers. Atlas Search keeps the [ADR-0007](0007-transactional-search-read-model.md) upgrade path intact rather than requiring it to be redesigned. Point-in-time restore at minute granularity is a genuinely better backup story than snapshot-based alternatives, which matters for a system holding invoices and payment records. And Atlas's own metrics, profiler, and index advisor are good, which shortens the feedback loop on the index work in [DATA-MODEL §3.4](../DATA-MODEL.md#34-indexes).

**Negative, and these are real.** It is a **third vendor** alongside Azure and CloudAMQP — a separate contract, a separate support relationship, separate billing, and a separate status page to check during an incident. Private Link between Atlas and our VNet is one more piece of networking to get right and to reason about during a failover. Some organisations have a first-party-only procurement policy, which would simply veto this. And at ~$750/month for M30 it is the largest single line in the cost model ([DEPLOYMENT §10](../DEPLOYMENT.md#10-cost)) — Cosmos vCore at comparable capacity would likely be cheaper, so this decision is knowingly not the cheapest one.

**Neutral.** Because the design already isolates persistence behind repository interfaces and the hexagonal dependency rule in [CODEBASE-STRUCTURE §3.1](../CODEBASE-STRUCTURE.md#31-the-dependency-rule), a future migration to Cosmos vCore would be an infrastructure and integration-test exercise rather than an application rewrite — provided the transaction semantics hold, which is the whole question.

## Alternatives considered

**Cosmos DB for MongoDB vCore.** The strongest alternative and the one I most wanted to say yes to: first-party, one vendor, one bill, native Private Link, and it does support multi-document transactions. Rejected on two grounds. It has **no Atlas Search**, so the search upgrade path in [ADR-0007](0007-transactional-search-read-model.md) would have to be redesigned around a different engine with different analysers and different relevance behaviour — turning a config-flag change into a project. And its MongoDB compatibility, while good, is a *reimplementation* rather than the engine itself; for a system where the correctness argument leans this hard on transaction and index semantics, "compatible" is a weaker guarantee than "the same". The honest position is that this is the option to re-evaluate if a first-party mandate arrives or if the Atlas bill becomes contentious, and the re-evaluation should begin by running the concurrency and outbox-atomicity tests from [TESTING §4](../TESTING.md#4-integration-tests-real-infrastructure) against it — those tests exist precisely to answer this question empirically.

**Cosmos DB for MongoDB (RU-based).** Rejected more firmly. RU provisioning is a poor fit for spiky load with a 15× peak, cross-partition transaction support is more constrained, and RU throttling under burst would surface as latency on the checkout path — the one place the design cannot absorb surprise.

**Cosmos DB with the native SQL API.** Rejected: it would mean rewriting every repository, every index, and the entire data model, discarding the document-shaped aggregate design in [DATA-MODEL](../DATA-MODEL.md) for no benefit the requirements ask for.

**Azure Database for PostgreSQL.** Genuinely tempting for the financial data — stronger relational guarantees, native `NUMERIC`, real foreign keys, and `SELECT … FOR UPDATE` for the reservation lock. Rejected because MongoDB was specified by the brief (the "M" in MERN), the document model does fit order-with-items as one aggregate, and the integrity requirements are already met by integer minor units, aggregate-enforced invariants, and nightly reconciliation. Recorded as a real trade-off rather than dismissed — if the constraint were lifted, invoice-service in particular would be a better fit on Postgres.

**Self-managed MongoDB on VMs or AKS.** Rejected: full control over the one component where control buys the least, in exchange for owning backups, patching, replica-set operations, and failover. This is a solved problem worth paying someone else for.
