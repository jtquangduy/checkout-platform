# Plan for Delivery

> *"Plan for delivery"* — from the brief.

---

## 1. Approach

Three principles shape this plan, and they are worth stating because they explain why the sequencing looks the way it does.

**Validate before building.** Six of the assumptions in [ASSUMPTIONS](ASSUMPTIONS.md) are answered by a conversation or a ten-minute experiment. Spending week one on that is far cheaper than discovering in week seven that the Production system is not idempotent.

**Ship a thin vertical slice first, then widen it.** The riskiest thing about this project is not any individual service — it is whether ten services, a saga, and four external integrations actually work together. So the first milestone is one order, one card, one push, one email, end to end. Everything after that is widening a proven path rather than hoping the pieces meet.

**Build the safety net before the traffic.** Idempotency, the outbox, and the observability that detects a paid-but-unpushed order are not phase-four hardening. They are the reason the architecture is defensible, so they land in phase one alongside the first checkout.

The plan assumes a team of **six engineers** ramping to **ten**, which is a realistic starting shape for the 10–20 engineer codebase the brief describes. Timings are working weeks with a 20% allowance for the things that always happen.

---

## 2. Phase 0 — Validate before building (week 1)

The whole team, one week, no production code beyond spikes.

The main output is answers to the open questions. A single 90-minute session with the product owner and finance resolves A1 (does a successful checkout always push to Production?), A2 (authorise-and-capture or delayed capture?), A6 (what is the refund policy on a Production outage?), and A4 (which accounting system, and whose invoice numbering?). Two engineers spend a day against the Production system's staging API to answer A3 and A10 empirically — send the same manifest twice and count the jobs, then check whether callbacks exist and whether they retry. One engineer queries the existing database for duplicate order names (A7) and actual order and search volumes (A8).

Alongside that, three technical spikes de-risk the parts I would not want to discover late: a MongoDB replica set with a transactional outbox proving the atomicity claim; the PSP's idempotency behaviour under a deliberately induced timeout; and a search benchmark on 50k seeded orders comparing the token-index approach against Atlas Search, so the choice in [PERFORMANCE §3](PERFORMANCE.md#3-order-search-the-hot-read-path) is measured rather than asserted.

**Exit criteria.** Every 🔴 assumption in [ASSUMPTIONS](ASSUMPTIONS.md) is resolved or explicitly accepted as a risk with an owner. The three spikes have written conclusions. Any design change is reflected in these documents before phase 1 starts.

**Why this is worth a week.** A1 alone changes the shape of the post-capture flow. Finding out now costs an hour; finding out after four teams have built against the wrong assumption costs a sprint.

---

## 3. Phase 1 — Walking skeleton (weeks 2–5)

**Goal: one order, searched by name, checked out with one card, pushed to Production, invoiced, and emailed — end to end, in staging, with tests.**

This is the milestone that matters most. It is deliberately narrow (one payment method, one currency, one SKU, no 3-DS, no subscriptions) and deliberately complete (every service in the path, real events, real outbox, real observability). Narrow-and-complete beats wide-and-partial, because integration risk is what kills projects and this retires it in week five.

Week 2 is platform foundations: the monorepo with Turborepo and CI, `packages/contracts` and `packages/kernel` including the outbox, inbox, tenant-scoped repository, and OTel bootstrap, Docker Compose with Mongo replica set, RabbitMQ, Redis, and Azurite, and the four mocks as real HTTP servers. Platform builds this while other engineers write the domain models for their services against it.

Weeks 3–4 build the path: identity with JWT and JWKS, order-service with the aggregate, state machine, search view and `ReserveForCheckout` CAS, catalog-pricing with quotes and the immutable snapshot, payment-service with the PSP adapter and derived idempotency keys, the checkout-orchestrator saga with persisted state, and the api-gateway with auth, idempotency middleware, SSE, and the aggregated Swagger UI generated from the zod contracts. In parallel, invoice-service issues invoices with gapless numbering, production-gateway pushes with its transient/permanent classification, and notification-service sends the confirmation email — all three as event consumers, so they are independent from day one.

Week 5 is the frontend slice and hardening: login, order search with debounced typeahead, order detail with the pricing snapshot, and the checkout drawer with the obligation tracker. Then the first e2e test asserting the brief's scenario against the mocks, the four critical alerts from [OBSERVABILITY §4](OBSERVABILITY.md#4-the-four-alert-families-that-matter), and the concurrency and idempotency integration tests.

**Exit criteria.** The e2e scenario passes in CI. Fifty concurrent checkouts on one order produce exactly one charge. A pod killed at any saga step converges to a correct terminal state. The paid-but-unpushed alert fires in a deliberately induced Production outage. Deployed to staging behind a feature flag.

**Risk.** Ten services in four weeks is aggressive. The mitigation is that they are thin — one use case each — and that `packages/kernel` removes the repeated infrastructure work. If it slips, the thing to cut is the frontend polish, never the integrity tests.

---

## 4. Phase 2 — Production-ready (weeks 6–10)

**Goal: real payments, real deadlines, first pilot tenants.**

The checkout path gains what the real world requires: 3-D Secure with the `AWAITING_SCA` saga branch, saved payment methods with stored mandates, multiple currencies, the refund saga triggered by permanent Production rejection, and the full retry ladder with dead-letter queues and the ops replay endpoint.

Orders and search gain their real shape: bulk asset upload via user-delegation SAS URLs with checksums and thumbnails, the full filter set, facets, keyset pagination, virtualised lists, and the Atlas Search cutover behind a flag if phase 0's benchmark justified it.

The published contracts become real: the OpenAPI bundle imported into API Management as a revision, the developer portal, and subscription keys for the first partner integration. Invoicing gains PDF generation, the accounting-system sync with its own retry loop, credit notes, and the invoice-number gap audit. Notification gains the template system, the delivery log, bounce webhooks, and the suppression list.

Operations become real: Bicep-provisioned Azure Container Apps deployed by the Azure DevOps pipeline with canary revisions and an SLO gate ([DEPLOYMENT](DEPLOYMENT.md)), KEDA queue-depth scale rules, the three Managed Grafana dashboards, the nightly reconciliation job, the ops console for stuck sagas and DLQ replay, and the runbooks in [CHECKOUT-SAGA §7](CHECKOUT-SAGA.md#7-operational-runbooks) actually walked through by someone who did not write them.

Weeks 9–10 are hardening rather than features: k6 load testing at 3× the projected peak, chaos experiments against every dependency, a security review with SAST, dependency scanning, and the cross-tenant isolation suite, plus an accessibility pass. Then a pilot with two or three friendly tenants at low volume, with daily reconciliation reviewed by hand.

**Exit criteria.** All SLOs in [PERFORMANCE §2](PERFORMANCE.md#2-service-level-objectives) met under load. Chaos experiments behave as documented. Zero P1 reconciliation drift across the pilot. Runbooks validated by an engineer who did not write them — because a runbook only its author can follow is not a runbook.

---

## 5. Phase 3 — Scale and general availability (weeks 11–16)

Recurring billing arrives properly: subscription plans, usage metering against included units, overage billing, the dunning ladder for failed renewals, and self-service plan changes. This was modelled from the start ([DATA-MODEL §5.3](DATA-MODEL.md#53-payment_methods-and-subscriptions)) so it is a feature build rather than a redesign.

The product gains what pilot tenants ask for: bulk checkout across multiple orders, the second-approver flow above a spend threshold, the deadline board driven by `slaDueAt`, order templates for repeat campaigns, and a Slack integration for production status.

The platform gains the things that only matter once real load arrives: read-from-secondary for search and reporting, per-tenant queue sharding so one studio's 5,000-image batch cannot starve another's, cache warming for hot tenants, and the sharding readiness work — which is operational rather than structural, because `tenantId` already leads every index.

Then a staged rollout: 10% of tenants, 50%, 100%, each gated on error budget and reconciliation drift, with the legacy path kept warm until the final gate.

---

## 6. Phase 4 — Continuous (ongoing)

After GA the work shifts from building to improving. Reliability effort is directed by the error budget rather than by intuition: if we are burning it, the next sprint is reliability work; if we are not, it is features. That policy is what stops "we'll harden it later" from meaning "never".

Planned improvements, in rough priority order: reducing the invoice PDF's 1.6 s render (visible in the trace in [OBSERVABILITY §3](OBSERVABILITY.md#3-tracing)) by generating it after the invoice record rather than within the same handler; adding the analytics event stream that the `order.#` binding already makes free; and revisiting the event-sourcing decision in [ADR-0004](adr/0004-saga-over-two-phase-commit.md) once the team is larger and the domain has stopped moving.

---

## 7. Team shape and ownership

Ownership follows the service boundaries in [CODEBASE-STRUCTURE §4](CODEBASE-STRUCTURE.md#4-ownership), and it starts smaller than it ends — teams form as the codebase grows rather than being declared on day one.

| Phase | Size | Shape |
|---|---|---|
| 0 | 6 | One group; everyone on validation and spikes |
| 1 | 6 | Platform (2), Orders (2), Checkout (2); fulfilment and finance services built by whoever is free |
| 2 | 8 | Platform (2), Orders (2), Checkout (2), Fulfilment+Finance (1), Web (1) |
| 3 | 10 | The six teams in CODEBASE-STRUCTURE §4, one to two engineers each |

Two practices matter more than the table. **Each team owns its services end to end** — schema, code, deploys, dashboards, alerts, and on-call — because separating "writes the code" from "gets paged" reliably produces code that is not operable. And **`packages/kernel` is treated as a product with customers**, owned by Platform, with a changelog and a deprecation cycle; shared infrastructure treated as a side project becomes the thing everyone works around.

Working practices are unremarkable and deliberately so: trunk-based development with short-lived branches, review within four hours by the CODEOWNERS-routed team, two reviewers on payment and money code, weekly demos against the brief's scenario rather than against tickets, and a fortnightly architecture forum where ADRs are proposed and challenged. New engineers are productive on day one because `make bootstrap && make up` runs the whole system, and they ship something to staging in their first week — usually a small change to a service they will own, paired with the person who will review it.

---

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Production system's real API differs from assumptions | **High** | Medium | Phase 0 spike against their staging; the anti-corruption layer contains the blast radius to one adapter |
| The "otherwise" ambiguity (A1) resolves the other way | Medium | Medium | Answered in phase 0; costs half a day because obligations are independent consumers |
| Ten services in four weeks slips | Medium | High | Services are thin; `packages/kernel` removes repeated work; cut frontend polish, never integrity tests |
| PSP integration surprises (SCA, regional rules) | Medium | Medium | Adapter pattern; mock reproduces 3-DS and the ambiguous-timeout case from day one |
| Search performance worse than modelled at real data shapes | Low | Medium | Benchmarked in phase 0 on 50k seeded orders; Atlas Search fallback behind a flag |
| Team ramp slower than planned | Medium | Medium | Uniform service structure and `make new-service`; documentation reviewed like code |
| Scope creep from pilot tenants | **High** | Medium | Phase 3 is explicitly the feature phase; pilot feedback is triaged, not absorbed |
| Distributed-systems debugging cost underestimated | Medium | Medium | Tracing with AMQP propagation and `correlationId` everywhere from week 2, not retrofitted |

The two I would watch most closely are the first and the third. The Production system is the only integration I genuinely cannot see, and phase 0 exists mostly to remove that unknown. And "ten services in four weeks" is the kind of estimate that is either fine or badly wrong depending on how much `packages/kernel` actually absorbs — which is why Platform builds it in week 2 while everyone else writes pure domain code against it, rather than everyone waiting.

---

## 9. Definition of done

A feature is done when the code is merged with tests at the coverage and mutation thresholds in [TESTING §7](TESTING.md#7-non-functional-testing-and-ci-gates); the API or event contract is published and contract tests pass; metrics, dashboards, and any needed alerts exist; the runbook is written if a new failure mode was introduced; the relevant document in `docs/` is updated in the same pull request; and it is deployed to staging behind a flag and demonstrated against the scenario.

For the release as a whole, done means all SLOs met under load, chaos experiments matching their documented expectations, zero P1 reconciliation drift over a full pilot, a security review closed, and runbooks validated by someone other than their author. The last one is the test that catches optimistic documentation.
