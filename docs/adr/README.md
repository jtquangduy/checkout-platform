# Architecture Decision Records

Append-only. A decision that turns out to be wrong is **superseded** by a new ADR, never edited — the value of an ADR is that it preserves the reasoning and the context that existed at the time, including the alternatives that were rejected and why.

Each record states the context, the decision, its consequences (positive *and* negative), and the alternatives considered. The negative consequences matter most: a design document that lists only benefits is marketing, and the honest cost is what a reviewer needs in order to disagree usefully.

| # | Decision | Status |
|---|---|---|
| [0001](0001-monorepo-with-independent-deploys.md) | Monorepo with independently deployable services | Accepted |
| [0002](0002-database-per-service.md) | Logical database per service on one MongoDB replica set | Accepted |
| [0003](0003-transactional-outbox-with-rabbitmq.md) | Transactional outbox, relayed to RabbitMQ | Accepted |
| [0004](0004-saga-over-two-phase-commit.md) | Hybrid saga: orchestrated pre-capture, choreographed post-capture | Accepted |
| [0005](0005-bff-gateway-with-scoped-graphql.md) | REST-first BFF gateway with one scoped GraphQL read endpoint | Accepted |
| [0006](0006-idempotency-on-every-mutation.md) | Idempotency keys required on every mutation, derived on internal steps | Accepted |
| [0007](0007-transactional-search-read-model.md) | Dedicated search read model, updated transactionally | Accepted |
| [0008](0008-express-over-fastify.md) | Express 5 as the HTTP framework, gRPC on two internal hot paths | Accepted |
| [0009](0009-money-as-integer-minor-units.md) | Money as integer minor units, rounded once, frozen in a snapshot | Accepted |
| [0010](0010-container-apps-now-aks-as-the-exit.md) | Azure Container Apps now, AKS as the documented exit | Accepted |
| [0011](0011-azure-devops-pipelines.md) | Azure DevOps Pipelines with workload identity federation | Accepted |
| [0012](0012-mongodb-atlas-on-azure.md) | MongoDB Atlas on Azure, not Cosmos DB for MongoDB | Accepted |

## The three that carry the design

If you read only three, read **0004** (why the saga is hybrid, which is the central structural decision), **0003** (why the transactional outbox is the foundation everything else stands on), and **0009** (how monetary correctness is made structural rather than careful). For the Azure platform specifically, **0010** carries the most argument — it is the one that declines a default rather than adopting one.

## Decisions consciously deferred

Recorded here so that "we didn't think of it" is distinguishable from "we decided not to yet": event sourcing the order aggregate (deferred in 0004 on team-cost grounds, with the outbox already producing the event stream that would make it possible); Kafka in place of RabbitMQ (deferred in 0003 until a replayable log or analytics stream is actually needed); Elasticsearch for search (deferred in 0007 in favour of the Atlas Search upgrade path); per-service physical database clusters (deferred in 0002 as an operational change requiring no code change); **AKS** (deferred in 0010 with six explicit migration triggers and a costed migration path); **Azure Service Bus** in place of RabbitMQ (deferred in 0010 — it would supersede 0003 and rewrite the messaging topology to buy something the design already has); and **GitOps with Flux** (deferred in 0011, and the natural thing to revisit alongside the AKS move).
