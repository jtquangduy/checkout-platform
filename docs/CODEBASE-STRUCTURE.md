# Codebase Structure

> *"This codebase might be handled by a team of 10 or 20 engineers. How do you structure the codebase?"* — the brief's third explicit question.

---

## 1. The actual problem

With 20 engineers on ten services, the bottleneck stops being code and becomes **coordination**. The failure modes are predictable: two teams blocked on the same pull request queue; a shared utility change breaking three services at once; nobody able to run the system locally so integration bugs surface only in staging; five different ways to write a repository, so moving between teams costs a week; and a release train where one team's bug delays everyone.

Every decision below is chosen to reduce coordination cost specifically, rather than to satisfy an abstract notion of clean architecture. The two structural bets are a **monorepo** (so shared contracts change atomically and cross-service refactors are one pull request) with **independently deployable services** (so no team waits on another to ship). Those are usually presented as opposites; they are not — the coupling that hurts is *deployment* coupling, not *repository* coupling.

---

## 2. Repository layout

```
checkout-platform/
├── docs/                        # This design set. Reviewed like code.
│   ├── ARCHITECTURE.md  DATA-MODEL.md  API.md  EVENTS.md
│   ├── CHECKOUT-SAGA.md  DATA-INTEGRITY.md  PERFORMANCE.md
│   ├── CODEBASE-STRUCTURE.md  FRONTEND.md
│   ├── SECURITY.md  OBSERVABILITY.md  TESTING.md
│   ├── ASSUMPTIONS.md  DELIVERY-PLAN.md  TIME-LOG.md
│   └── adr/                     # Architecture Decision Records — append-only
│
├── packages/                    # Shared libraries. Semver'd via changesets.
│   ├── contracts/               # ⭐ zod schemas → TS types → OpenAPI + AsyncAPI.
│   │   ├── src/value-objects.ts        # Money, TenantId, OrderId…
│   │   ├── src/events/                 # every event payload, versioned
│   │   ├── src/http/                   # every request/response shape
│   │   └── src/proto/                  # .proto for the gRPC hot paths
│   ├── kernel/                  # ⭐ Cross-cutting runtime. NO business logic.
│   │   ├── src/outbox/                 # withOutbox(), relay, claim
│   │   ├── src/inbox/                  # idempotent consumer helper
│   │   ├── src/mongo/                  # TenantScopedRepository, tx helpers
│   │   ├── src/rabbit/                 # publisher, defineConsumer, topology
│   │   ├── src/http/                   # server factory, idempotency, problem+json
│   │   ├── src/resilience/             # timeout, retry, circuit breaker, bulkhead
│   │   ├── src/observability/          # OTel bootstrap, logger, metrics
│   │   ├── src/context/                # AsyncLocalStorage request context
│   │   └── src/config/                 # zod-validated env loader
│   ├── testing/                 # Testcontainers fixtures, builders, fake clock
│   ├── ui/                      # Design system: Radix + Tailwind primitives
│   └── config-{eslint,ts,vitest}/
│
├── services/                    # One folder = one deployable = one owning team
│   ├── api-gateway/
│   ├── identity-service/
│   ├── catalog-pricing-service/
│   ├── order-service/
│   ├── checkout-orchestrator/
│   ├── payment-service/
│   ├── invoice-service/
│   ├── notification-service/
│   ├── production-gateway-service/
│   └── asset-service/
│
├── mocks/                       # Mocked third parties. Real HTTP servers,
│   ├── psp-mock/                # not in-process stubs — so integration tests
│   ├── email-mock/              # exercise real serialisation, timeouts, retries.
│   ├── production-mock/         # + injectable failure, so the resilience paths
│   └── accounting-mock/         #   are exercised on demand rather than described.
│
├── apps/
│   └── portal-web/              # React SPA
│
├── tests/
│   ├── e2e/                     # Playwright: full scenario across all services
│   └── contract/                # Pact broker config, consumer expectations
│
├── infra/
│   ├── mongo/  rabbitmq/  keys/
│   ├── bicep/   # Azure infrastructure modules + per-env parameter files
│   ├── k6/      # load scenarios
│   └── grafana/ # dashboards + alert rules as code
│
├── .azuredevops/
│   ├── templates/               # reusable pipeline steps: deploy, slo-gate, rollback
│   └── CODEOWNERS               # ⭐ ownership = review routing
├── azure-pipelines.yml          # multi-stage: validate → build → infra → deploy
│
├── docker-compose.yml           # `make up` → whole system on a laptop
├── turbo.json  pnpm-workspace.yaml  tsconfig.base.json
└── Makefile                     # the ~8 commands anyone actually needs
```

### 2.1 Why a monorepo

The decisive argument is `packages/contracts`. Ten services and one frontend share event and API schemas. In a polyrepo, changing `CheckoutCompletedV1` means publishing a package version, then opening four pull requests across four repositories, merging them in the right order, and living with a window where services disagree about the contract. In a monorepo it is **one pull request**, atomically reviewable, where CI type-checks every consumer against the change before it merges. A breaking change becomes visible at review time instead of at 3 a.m.

The other benefits follow: one `pnpm install` and `make up` gets a new hire the whole system running on day one; cross-service refactors are mechanical; `turbo run test --filter=...[origin/main]` builds and tests only what a change actually affects, so CI stays fast despite the repo being large; and a single tooling configuration means no team is on a two-year-old ESLint.

The costs are real and mitigated rather than denied. CI could become slow — handled by the affected-graph. Everyone can edit everything — handled by CODEOWNERS enforcing review routing. Coupling can creep in — handled by lint rules banning cross-service imports (see §3.3). And the repo grows — handled by shallow clones and sparse checkout in CI. [ADR-0001](adr/0001-monorepo-with-independent-deploys.md) records the decision.

---

## 3. Inside a service — identical everywhere

Every service has the same shape. Uniformity is worth more than local optimisation here: an engineer who has worked in one service can navigate any of them, code review transfers across teams, and generators can scaffold new services correctly.

```
services/order-service/
├── src/
│   ├── domain/                  # ⭐ Pure. No imports from infrastructure. Ever.
│   │   ├── order/
│   │   │   ├── order.aggregate.ts        # invariants + behaviour
│   │   │   ├── order.state-machine.ts    # legal transitions as data
│   │   │   ├── order-item.entity.ts
│   │   │   ├── order-name.vo.ts          # normalisation + tokenisation rules
│   │   │   └── order.events.ts
│   │   └── errors.ts                     # domain errors, no HTTP concepts
│   │
│   ├── application/             # Use cases. One class, one transaction.
│   │   ├── create-order.usecase.ts
│   │   ├── search-orders.usecase.ts
│   │   ├── reserve-for-checkout.usecase.ts
│   │   ├── confirm-paid.usecase.ts
│   │   └── ports/                        # interfaces ONLY — the hexagon's edge
│   │       ├── order.repository.ts
│   │       ├── search-view.repository.ts
│   │       └── event-publisher.ts
│   │
│   ├── infrastructure/          # Adapters. The only place drivers appear.
│   │   ├── mongo/
│   │   │   ├── order.mongo.repository.ts
│   │   │   ├── order-search.mongo.repository.ts
│   │   │   └── schemas/
│   │   ├── rabbit/
│   │   └── grpc/clients/
│   │
│   ├── interface/               # Driving adapters. Thin — no business logic.
│   │   ├── http/
│   │   │   ├── routes/           controllers/           middleware/
│   │   │   └── swagger.ts        # mountSwagger() from @platform/kernel
│   │   ├── grpc/order-internal.service.ts
│   │   ├── consumers/production-status.consumer.ts
│   │   └── jobs/reservation-reaper.job.ts
│   │
│   ├── composition-root.ts      # ⭐ The ONLY place wiring happens
│   ├── config.ts                # zod-validated env; process exits if invalid
│   └── main.ts
│
├── test/
│   ├── unit/                    # domain + application, mocked ports, no I/O
│   ├── integration/             # real Mongo + Rabbit via Testcontainers
│   └── contract/                # Pact provider verification
│
├── openapi.generated.json       # GENERATED at build time from the zod schemas.
│                                # Never hand-edited; baked into the image so a
│                                # container cannot serve a spec that disagrees
│                                # with its own code. Swagger UI at /docs.
├── Dockerfile                   # multi-stage, distroless, non-root
├── package.json
└── README.md                    # what it owns, who owns it, how to run it
```

### 3.1 The dependency rule

Dependencies point strictly inward: `interface` and `infrastructure` → `application` → `domain`, and `domain` imports nothing. This is not aesthetics; it buys three concrete things.

Domain logic is testable with zero infrastructure. The order state machine, `Money` arithmetic, and every pricing invariant are pure functions over plain objects — the whole unit suite runs in single-digit seconds with no Docker, which is what makes engineers actually run it on save.

Infrastructure becomes swappable. Migrating the PSP from mock to Stripe is a new class in `infrastructure/http/` plus a config value; `application` and `domain` do not change and their tests do not change. The same shape is what makes the planned Atlas Search cutover ([ADR-0007](adr/0007-transactional-search-read-model.md)) a config flag rather than a rewrite — two implementations behind one repository interface.

And business rules stay findable. When a new engineer asks "where is the rule that an order can't be checked out twice?", the answer is always `domain/`, never "somewhere in a controller".

### 3.2 The composition root

All wiring happens in exactly one file per service. No service locator, no decorators, no framework magic — a plain function that constructs the graph. It is longer than a DI container's configuration and dramatically easier to follow, and swapping any adapter for a fake in tests is a one-line change.

```ts
// services/order-service/src/composition-root.ts
export async function compose(cfg: Config) {
  const mongo  = await createMongo(cfg.MONGO_URI, cfg.MONGO_DB_ORDER);
  const rabbit = await createRabbit(cfg.RABBITMQ_URL);
  const redis  = await createRedis(cfg.REDIS_URL);

  // infrastructure implements the ports declared in application/ports
  const orders     = new MongoOrderRepository(mongo);
  const searchView = new MongoOrderSearchRepository(mongo, redis);
  const publisher  = new OutboxPublisher(mongo);

  // application depends only on those interfaces
  const useCases = {
    createOrder:   new CreateOrderUseCase(orders, searchView, publisher),
    searchOrders:  new SearchOrdersUseCase(searchView),
    reserve:       new ReserveForCheckoutUseCase(mongo, orders, searchView, publisher),
    confirmPaid:   new ConfirmPaidUseCase(mongo, orders, searchView, publisher),
  };

  return {
    http:      createHttpServer({ useCases, cfg }),
    grpc:      createGrpcServer({ useCases, cfg }),
    consumers: [productionStatusConsumer(useCases)],
    jobs:      [reservationReaperJob(useCases, redis), outboxRelay(mongo, rabbit)],
    shutdown:  async () => { /* drain, then close in reverse order */ },
  };
}
```

### 3.3 Rules the linter enforces

Conventions that are not mechanically enforced decay within two months, especially across 20 engineers. These are ESLint errors that fail CI, not guidelines in a wiki:

```js
// packages/config-eslint/boundaries.js
'import/no-restricted-paths': ['error', { zones: [
  // The hexagon's dependency rule, mechanically enforced.
  { target: './src/domain',      from: './src/infrastructure',
    message: 'domain must stay pure — depend on a port in application/ports instead' },
  { target: './src/domain',      from: './src/interface' },
  { target: './src/application', from: './src/interface' },
  { target: './src/application', from: './src/infrastructure',
    message: 'application depends on ports, not adapters' },
]}],

// A service reaching into another service's source is a distributed monolith
// with extra steps. Talk over HTTP/gRPC or events, or share via packages/contracts.
'no-restricted-imports': ['error', { patterns: [
  { group: ['**/services/*/src/**'], message: 'cross-service imports are forbidden' },
  // Money must go through addMoney/applyRate so currency mismatch and rounding
  // are impossible by construction.
  { group: ['**/money-utils-legacy'], message: 'use @platform/contracts Money helpers' },
]}],

// Raw model access bypasses tenant scoping. This rule is the reason a
// cross-tenant leak is structurally hard rather than merely unlikely.
'platform/no-unscoped-collection-access': 'error',
'platform/require-idempotency-on-mutation': 'error',
'platform/no-floating-money': 'error',            // bans `number` typed as an amount
```

The three custom rules in that list carry real weight. `no-unscoped-collection-access` forbids touching a Mongoose model outside a `TenantScopedRepository`, which is what turns multi-tenant isolation from a review discipline into a compile-time property.

---

## 4. Ownership

Ownership is the mechanism that makes 20 engineers work. Each service has exactly one owning team, and CODEOWNERS turns that into automatic review routing so nobody has to ask "who should look at this?".

| Team | Services | Domain focus |
|---|---|---|
| **Orders** | order-service, asset-service, catalog-pricing-service | Order lifecycle, search, pricing |
| **Checkout** | checkout-orchestrator, payment-service | Saga, payments, PSP integration, recurring billing |
| **Fulfilment** | production-gateway-service, notification-service | Production integration, comms |
| **Finance** | invoice-service | Invoicing, tax, accounting sync |
| **Platform** | api-gateway, identity-service, `packages/*`, infra | Auth, shared libraries, CI/CD, observability |
| **Web** | apps/portal-web, `packages/ui` | Portal, design system |

```
# .azuredevops/CODEOWNERS  (mirrored to .github/CODEOWNERS if hosted on GitHub)
/services/order-service/                 @platform/orders
/services/checkout-orchestrator/         @platform/checkout
/services/payment-service/               @platform/checkout @platform/security
/services/invoice-service/               @platform/finance
/services/production-gateway-service/    @platform/fulfilment
/apps/portal-web/                        @platform/web

# Shared contracts need the platform team AND every consuming team, because a
# schema change is a cross-team API change whether or not it feels like one.
/packages/contracts/                     @platform/platform @platform/orders @platform/checkout @platform/finance
/packages/kernel/                        @platform/platform

# Money, auth, and infra get a second pair of eyes by policy.
/services/payment-service/src/domain/    @platform/checkout @platform/staff-engineers
/infra/bicep/                            @platform/platform @platform/sre
/docs/adr/                               @platform/staff-engineers

# @platform/security, @platform/sre and @platform/staff-engineers are cross-cutting
# review groups, not service owners — they are added as a second reviewer on
# money, auth and infra paths by policy, and own nothing in the table above.
```

Two ownership rules that matter more than the table. **A team owns its service end to end** — schema, code, deploys, dashboards, alerts, and on-call. Splitting "writes the code" from "gets paged" reliably produces code that is not operable. And **`packages/kernel` is a product with a customer**, owned by Platform, with a versioned API, a changelog, and no breaking change without a deprecation cycle. Treating shared infrastructure as a side project is how it becomes the thing everyone works around.

---

## 5. CI/CD

### 5.1 The affected graph

A naive monorepo pipeline runs everything on every change and takes 40 minutes; nobody merges anything. Turborepo's dependency graph means a pull request touching only `invoice-service` builds and tests only `invoice-service`. A change to `packages/contracts` correctly rebuilds everything that depends on it — which is exactly the coordination benefit we wanted.

```yaml
# azure-pipelines.yml (abridged — full pipeline in DEPLOYMENT §5)
jobs:
  affected:
    steps:
      - run: pnpm turbo run lint typecheck test:unit --filter=...[origin/main] --cache-dir=.turbo
      # Remote cache: an unchanged package's results are reused across branches,
      # so the same work is never done twice in the organisation.

  integration:
    services: [mongo (rs0), rabbitmq, redis]      # real dependencies, not mocks
    steps:
      - run: pnpm turbo run test:integration --filter=...[origin/main]

  contract:
    steps:
      - run: pnpm turbo run test:contract --filter=...[origin/main]
      - run: pact-broker can-i-deploy --pacticipant=$SVC --to-environment=production
      # ⭐ A provider CANNOT merge a change that breaks a real consumer, even
      # when its own tests pass. This is the single most valuable gate we have.

  api-compat:
    steps:
      - run: oasdiff breaking --fail-on ERR base.yaml head.yaml
      - run: asyncapi diff --fail-on-breaking base.yaml head.yaml
      # Overridable only with an `api-breaking` label + a migration note in the PR.

  e2e:
    steps:
      - run: docker compose up -d --wait
      - run: pnpm test:e2e        # the full brief scenario, all services, real mocks

  quality-gates:
    steps:
      - run: pnpm vitest --coverage    # ≥80% overall; ≥95% on domain/ of payment,
                                       # invoice, checkout — the money paths
      - run: pnpm stryker run --mutate 'services/*/src/domain/**'   # ≥70% mutation score
      - run: pnpm audit --audit-level=high && trivy image --exit-code 1 --severity CRITICAL
      - run: lhci autorun            # frontend budgets
```

Mutation testing on `domain/` is included deliberately. Line coverage on money code proves the lines ran, not that the assertions would catch a bug; mutation testing proves the tests would fail if the logic were wrong. It runs only on `domain/` because that is where it is affordable and where correctness matters most.

### 5.2 Deployment

Trunk-based development with short-lived branches, squash merge, and no release branches. Every merge to `main` deploys automatically to staging; production is a manual promotion gated by two approvers and a business-hours window (a policy choice for a payments system, not a technical limit). Progressive delivery uses Container Apps revisions with weighted traffic: 10% canary for 10 minutes with automatic rollback if the canary revision's error rate or p95 latency is worse than the stable one, then 50%, then 100% ([DEPLOYMENT §5](DEPLOYMENT.md#5-the-azure-devops-pipeline)).

The mechanism that makes independent deploys real is that **schema changes are always expand–migrate–contract** and **events are additive within a version**. Any two adjacent versions of any two services are compatible, so deploy order never matters and no team ever waits on another's release. Risky changes ship dark behind OpenFeature flags and are enabled per tenant, which is how the Atlas Search cutover and the saga v2 rollout are both planned to reach production.

Every service publishes the same operational contract, so SRE tooling is uniform: `/health/live`, `/health/ready`, `/health/startup`, `/metrics`, structured JSON logs to stdout, OTLP traces, graceful shutdown on `SIGTERM` that stops accepting work, drains in-flight requests and messages, then exits within 30 s.

---

## 6. Developer experience

A new engineer should be productive on day one, and the measure of that is whether they can run the whole system and ship a change to staging in their first week. The Makefile is deliberately short — eight commands is a memorable API:

```makefile
make bootstrap   # install, generate keys, copy .env, seed
make up          # whole system: 10 services, 4 mocks, Mongo rs0, Rabbit, Redis, Azurite
make dev         # up + hot reload on every service
make test        # unit + integration
make e2e         # Playwright against the running stack
make seed        # 3 tenants, 12 users, 500 orders, price books
make logs s=order-service
make new-service name=foo   # scaffolds the full hexagonal structure + CI + chart
```

`make new-service` matters more than it looks: it means the tenth service has the same shape as the first because generating it correctly is easier than deviating.

Local URLs are all on localhost — portal 5173, gateway 3000, the aggregated Swagger UI at 3000/api/v1/docs (each service also serves its own at `<port+1000>/docs`), RabbitMQ management 15672, Azurite 10000, the OTel Collector's local trace UI 16686, the email mock's browsable outbox at 4002, the PSP mock's dashboard at 4001, and the production and accounting mocks at 4003 and 4004. Being able to *see* the email that was sent and the charge that was made, in a browser, is what makes a distributed system feel tractable to a newcomer.

Documentation lives next to code and is reviewed with it. Each service README states what it owns, who owns it, and how to run it. ADRs record decisions with their context and consequences and are append-only — superseded rather than edited — so the reasoning behind a two-year-old choice survives the departure of the person who made it. This documentation set is itself part of the repository, reviewed like code, because a design document that drifts from the system is worse than none.
