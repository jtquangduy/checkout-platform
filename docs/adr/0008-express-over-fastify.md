# ADR-0008 — Express 5 as the HTTP framework, gRPC on two internal hot paths

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** Platform

## Context

Ten services need an HTTP layer. MERN specifies Express, but that is worth examining rather than accepting reflexively, because Fastify benchmarks roughly twice as fast on synthetic request throughput and has first-class JSON Schema validation and serialisation.

Separately, two internal calls sit on the checkout critical path and are invoked on every checkout: orchestrator → order-service (validate, reserve, confirm) and orchestrator → payment-service (authorise and capture).

## Decision

**Express 5** for all north–south HTTP and for internal REST, with the standard middleware set (Helmet, compression, a zod validation layer, the idempotency middleware, and RFC 9457 problem-details error handling), all provided by a shared `createHttpServer()` factory in `packages/kernel` so no service configures it by hand.

**gRPC for the two hot internal paths**, with `.proto` definitions living in `packages/contracts/src/proto`.

## Consequences

**Positive.** Every engineer we hire already knows Express, which with 10–20 engineers is a material and recurring benefit — no framework onboarding, no idiom debates, and the largest middleware ecosystem if we need something unusual. Express 5's native async error handling removes the main historical annoyance. Meanwhile gRPC gives the checkout path a generated, breaking-change-detectable contract plus HTTP/2 multiplexing and binary framing, worth ~8 ms per call against JSON over HTTP/1.1 — and the strong typing was wanted regardless of the latency.

**Negative.** Express is measurably slower per request than Fastify. This is accepted because our latency budget is not framework-bound: in the trace in [OBSERVABILITY §3](../OBSERVABILITY.md#3-tracing), 77% of checkout latency is the PSP and the rest is dominated by MongoDB round trips; framework overhead is on the order of tens to hundreds of microseconds per request against a 780 ms total. Optimising it would be optimising the wrong thing. Express's validation and serialisation are also not built in — supplied by zod, which we wanted anyway as the single source of truth for types, OpenAPI, and runtime validation.

Two protocols is a small extra cost, bounded by keeping gRPC to exactly two service pairs rather than converting everything.

**Neutral.** Because HTTP setup is centralised in one factory, migrating to Fastify later would be a change to that factory plus route-handler signatures — a contained refactor, not a rewrite. Revisit if profiling ever shows framework overhead in the top three latency contributors, which current numbers say it is not.

## Alternatives considered

**Fastify everywhere.** The better choice on raw performance and on built-in schema validation. Rejected because MERN was specified, the performance advantage is invisible against our actual latency profile, and familiarity across a large team is worth more than throughput we do not need. Recorded honestly as a trade-off rather than dressed up as a win.

**NestJS.** Provides structure, DI, and conventions out of the box, which is genuinely attractive for a large team. Rejected because it prescribes an architecture that conflicts with the explicit hexagonal layering in [CODEBASE-STRUCTURE §3](../CODEBASE-STRUCTURE.md#3-inside-a-service-identical-everywhere), and because decorator-based DI makes the dependency graph implicit — whereas our composition root makes it a plain, readable function. The framework's abstraction also becomes something engineers debug instead of the application.

**gRPC for all internal traffic.** Rejected as disproportionate: most internal calls are infrequent, and losing curl-debuggability everywhere for a few milliseconds on cold paths is a bad trade.

**tRPC between the portal and the gateway.** Attractive end-to-end type safety for a TypeScript-only stack. Rejected because it couples the client to server function signatures, and we want a documented, versioned, language-agnostic public API — the portal is unlikely to be the only client forever.
