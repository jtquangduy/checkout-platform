# ADR-0005 — REST-first BFF gateway with one scoped GraphQL read endpoint

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** Platform, Web

## Context

The portal needs data from ten services. Two questions: what protocol does the client speak, and where do cross-service concerns live?

One screen makes the question concrete. Order detail needs the order and its items (order-service), the payment (payment-service), the invoice (invoice-service), and the production job (production-gateway). In pure REST that is four sequential or parallel client calls, and on a slow connection a visible waterfall.

The tempting conclusion is "use GraphQL for everything". That solves the waterfall and creates three new problems: resolvers that fan out across service boundaries produce N+1 HTTP calls unless carefully batched; query cost becomes unbounded unless depth- and complexity-limited; and HTTP caching, idempotency headers, and status-code semantics all have to be rebuilt inside a single `POST /graphql`.

## Decision

**A BFF gateway that is REST-first**, owning only cross-cutting concerns: JWT verification against cached JWKS, per-tenant and per-user rate limiting, the `Idempotency-Key` middleware, correlation-id assignment, CORS and security headers, response shaping, and the SSE endpoint for checkout progress. It holds **no business rules and no domain data** — its only persistence is the shared idempotency store (Redis, with a durable Mongo copy), which is a cross-cutting concern rather than a domain.

**One read-only GraphQL endpoint** (`POST /api/v1/graphql`) exposing a small, curated schema whose purpose is the order-detail aggregation. Depth-limited to 6, cost-budgeted, no mutations, every cross-service field resolved through a `DataLoader` that batches per-service calls.

**All mutations stay REST**, because that is where `Idempotency-Key`, `If-Match`/`ETag`, `402`, `409`, `422`, and `Retry-After` already do exactly what we need. Reimplementing idempotency and optimistic concurrency inside GraphQL mutations would be work with no payoff.

## Consequences

**Positive.** The order-detail screen is one round trip. Mutations keep standard HTTP semantics, which matters enormously on the checkout path where an ambiguous `504` and a correct retry are the difference between one charge and two. Ten services do not each implement auth and rate limiting. Partial failure is graceful: a resolver hitting a slow dependency returns `null` with a partial error, so an unavailable invoice panel shows a retry rather than blanking the page.

**Negative.** The gateway is a single point of failure — run at least three replicas, no state, aggressive timeouts. Two API styles is a small cognitive cost, bounded by the rule that GraphQL is reads-only and REST is everything else. The GraphQL schema is another contract to version, kept small deliberately.

**Neutral.** Because the gateway holds no business logic, it can be replaced by an off-the-shelf gateway plus a thin aggregation service if that becomes preferable. Nothing depends on it being ours.

## Alternatives considered

**GraphQL as the only API.** Rejected for the reasons above — chiefly that we would lose idempotency and concurrency semantics on the money path, which is the last place to be inventing conventions.

**Pure REST, client-side composition.** Rejected for the order-detail waterfall, and because it pushes knowledge of which service owns which field into the browser — making a service boundary change a frontend release.

**No gateway; services exposed directly.** Rejected: auth, rate limiting, and idempotency would be duplicated nine times, and nine public surfaces is nine things to get wrong in a security review.

**Per-client BFFs (one for web, one for a future mobile app).** The right answer *if* a second client with materially different needs appears. Rejected as premature with one client; the current gateway is structured so splitting it later is straightforward.
