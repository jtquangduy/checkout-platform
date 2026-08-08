# Observability & Operations

> In a distributed system, "is it working?" is not answerable by looking at one process. The question this document answers is narrower and more useful: **within 15 minutes, do we know about every paid order that has not reached Production?**

---

## 1. What we actually need to know

Observability is easy to over-build and easy to under-use. So rather than instrumenting everything and hoping, the design starts from the questions the business and on-call will actually ask, and works backwards to the signals needed to answer each one.

| Question | Signal | Where |
|---|---|---|
| Is any customer paid but not in Production? | `platform_orders_awaiting_production_seconds` (max) | [§4](#4-the-four-alert-families-that-matter) |
| Did we double-charge anyone? | `payment_transactions` invariant + reconciliation drift | [§4](#4-the-four-alert-families-that-matter) |
| Why did *this* checkout take 9 seconds? | One distributed trace, HTTP span through to the email | [§3](#3-tracing) |
| Are events flowing? | `platform_outbox_lag_seconds`, queue depth, DLQ depth | [§2](#2-metrics) |
| Is search still fast? | `http_request_duration_seconds{route="/orders"}` | [§2](#2-metrics) |
| Did this specific client get their email? | `notifications` delivery log + `correlationId` | [§5](#5-logging) |
| Are we burning the error budget? | SLO burn-rate alerts | [§4](#4-the-four-alert-families-that-matter) |

The single most important line in that table is the first. This architecture deliberately accepts that a Production push can fail after payment, and the entire justification for accepting it is that we detect it fast. Without that alert, the design would be irresponsible.

The three pillars are wired together by one identifier. `correlationId` appears in every log line, as a span attribute on every span, as a label on exemplar metrics, on every document, and on every event envelope. Given a customer complaint, the path is: find the order, read its `correlationId`, and every log, span, and document for that checkout — across ten services and four mocks — is one query away.

---

## 2. Metrics

OpenTelemetry metrics in Prometheus format on a non-routable port, scraped into Azure Monitor managed Prometheus and graphed in Azure Managed Grafana ([DEPLOYMENT §9](DEPLOYMENT.md#9-observability-wiring)). **RED** for request-driven services (rate, errors, duration) and **USE** for resources (utilisation, saturation, errors), plus domain metrics that describe the business rather than the infrastructure.

```ts
// packages/kernel/src/observability/metrics.ts

// --- RED: every HTTP and gRPC endpoint, automatically -----------------------
// Buckets chosen around the SLOs in PERFORMANCE §2, not left at library
// defaults — a histogram whose buckets straddle your target tells you nothing.
httpRequestDuration = histogram('http_request_duration_seconds',
  ['service', 'method', 'route', 'status', 'tenant_tier'],
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10]);

// --- Domain metrics: the ones an executive would recognise -----------------
checkoutAttempts   = counter('platform_checkout_attempts_total', ['outcome', 'failure_code']);
checkoutValue      = counter('platform_checkout_value_minor_total', ['currency', 'outcome']);
paymentDuration    = histogram('platform_payment_duration_seconds', ['provider', 'outcome']);

// ⭐ THE metric. Time from capture to a Production job being accepted.
// This is the commercial promise ("beat deadlines") expressed as a number.
timeToProduction   = histogram('platform_capture_to_production_seconds', ['priority'],
  [1, 2, 5, 10, 30, 60, 300, 900, 3600]);

// ⭐ THE gauge. How long has the oldest unfulfilled paid order been waiting?
// Recomputed every 30 s from an indexed partial query. Powers alert #1.
ordersAwaitingProduction = gauge('platform_orders_awaiting_production_seconds');

invoiceLag         = histogram('platform_capture_to_invoice_seconds');
emailLag           = histogram('platform_capture_to_email_seconds');

// --- Integrity metrics: expected value ZERO -------------------------------
reconciliationDrift = gauge('platform_reconciliation_drift_total', ['drift_type', 'severity']);
doubleChargeDetected = counter('platform_double_charge_detected_total');   // must stay 0
invoiceNumberGaps   = gauge('platform_invoice_number_gaps_total', ['tenant', 'year']);

// --- Messaging health -----------------------------------------------------
outboxLag          = gauge('platform_outbox_lag_seconds', ['service']);
outboxPending      = gauge('platform_outbox_pending_total', ['service', 'event_type']);
consumerLag        = gauge('platform_consumer_lag_messages', ['queue']);
dlqDepth           = gauge('platform_dlq_depth', ['queue']);
eventProcessing    = histogram('platform_event_processing_seconds', ['queue', 'outcome']);
duplicatesDetected = counter('platform_duplicate_messages_total', ['consumer_group']);

// --- Saga health ----------------------------------------------------------
sagaDuration       = histogram('platform_saga_duration_seconds', ['saga', 'outcome']);
sagaStepDuration   = histogram('platform_saga_step_duration_seconds', ['saga', 'step', 'outcome']);
sagasStuck         = gauge('platform_sagas_stuck_total', ['saga', 'step']);
compensations      = counter('platform_saga_compensations_total', ['saga', 'step', 'outcome']);

// --- Dependency health ---------------------------------------------------
dependencyDuration = histogram('platform_dependency_duration_seconds', ['dependency', 'operation', 'outcome']);
circuitBreakerState = gauge('platform_circuit_breaker_state', ['dependency']);  // 0=closed 1=half 2=open
```

Two deliberate choices in this list. `platform_checkout_value_minor_total` tracks money, not just request counts — during an incident, "we've failed 12 checkouts" is much less useful than "we've failed £41,000 of checkouts", and the second is what determines severity. And `duplicatesDetected` is instrumented as a normal, expected metric rather than an error, because at-least-once delivery means duplicates are the system working correctly; a *sudden spike* in duplicates is the interesting signal (usually a consumer nacking in a loop), which is only visible if the baseline is measured.

**Cardinality is controlled deliberately.** `tenant_tier` is a label; `tenant_id` is not — 800 tenants × 40 routes × 5 statuses would be 160,000 series per metric. Per-tenant analysis comes from traces and logs, where high cardinality is affordable. This is the mistake that quietly makes a Prometheus instance unusable, so it is a review checklist item rather than a hope.

---

## 3. Tracing

OpenTelemetry with W3C trace context propagated over HTTP headers **and AMQP message headers**, which is the part usually missed. Without AMQP propagation, a trace ends at the outbox and the asynchronous half of the checkout — invoicing, the Production push, the email — is invisible precisely where debugging is hardest.

```ts
// packages/kernel/src/rabbit/publisher.ts — inject
const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);
await channel.publish(exchange, routingKey, body, {
  headers: { ...headers, ...carrier },     // traceparent, tracestate
});

// packages/kernel/src/rabbit/consumer.ts — extract and CONTINUE the trace
const parent = propagation.extract(context.active(), msg.properties.headers);
await tracer.startActiveSpan(`consume ${queue}`, {
  kind: SpanKind.CONSUMER,
  // Span LINK, not a child span. The consumer is causally related to the
  // publisher but is not nested inside it — it may run minutes later, after a
  // retry. Modelling it as a child would produce a span with a 40-minute
  // duration and a misleading waterfall.
  links: [{ context: trace.getSpanContext(parent)! }],
}, async (span) => { /* handle */ });
```

A complete checkout trace, every service on the path in one waterfall:

```
POST /api/v1/checkout-sessions                                    780 ms  ████████████
├─ gateway: verify JWT (cached JWKS)                                2 ms  ▏
├─ gateway: idempotency claim (redis)                               3 ms  ▏
├─ orchestrator: create session + saga                             14 ms  ▎
├─ grpc order.ValidateForCheckout                                  21 ms  ▍
│  └─ mongo find orders (ix_tenant_status_recency)                  8 ms
├─ http catalog.verifyQuote                                        34 ms  ▌
├─ grpc order.ReserveForCheckout                                   18 ms  ▍
│  └─ mongo txn: CAS + searchView + outbox                         14 ms
├─ grpc payment.AuthorizeAndCapture                               642 ms  ██████████
│  ├─ psp POST /payment_intents                            ⚠ 598 ms  █████████  ← 77%
│  └─ mongo txn: intent + transaction + outbox                     18 ms
├─ grpc order.ConfirmPaid                                          27 ms  ▍
└─ orchestrator: txn session + outbox                              19 ms  ▎

⋯ async tail (LINKED spans, same traceId) ⋯
   offsets are from capture at 10:31:01.204; queue wait is the gap
outbox relay publish checkout.completed              +0.21 s        ▏
├─ consume q.production.checkout-completed           +7.38 s → +8.35 s   ███
│  ├─ fetch 400 asset refs                                        142 ms
│  └─ POST production-mock /v1/jobs                               812 ms
│     └─ order → IN_PRODUCTION                                     22 ms
├─ consume q.invoice.checkout-completed              +11.15 s → +12.80 s ████
│  ├─ allocate number + insert invoice (txn)                        31 ms
│  └─ render PDF → Blob                                            1.62 s   ← candidate
└─ consume q.notification.checkout-completed         +14.67 s → +14.92 s █
   └─ POST email-mock /v1/send                                    240 ms
      (queued behind invoice.issued so the email can carry the invoice number)
```

The waterfall answers the optimisation question immediately: 77% of the synchronous latency is the PSP, which we do not control, so our own overhead is ~180 ms and further micro-optimisation of our code is not where the time is. Meanwhile the 1.62 s PDF render is a real candidate — and safely off the critical path, so it can be deferred behind the invoice record rather than optimised, which would pull the email forward by the same amount.

Note that most of the async tail is *queue wait*, not work: the three consumers do 976 ms, 1.65 s and 240 ms of actual work respectively, and everything else is waiting for a slot. That is the signal KEDA scales on ([PERFORMANCE §7](PERFORMANCE.md#7-asynchronous-throughput)), and it is why "the system is slow" and "the system is saturated" look completely different in a trace.

Every span carries `tenant.id`, `order.id`, `checkout.session_id`, `correlationId`, and — on failures — `error.code` and `error.retryable`, so a trace search can find "all failed checkouts for this tenant today" directly. Sampling is **tail-based** in the collector — the decision is made once the trace is complete, which is the only way to sample on outcome: 10% of successful requests, **100% of anything that errors, and 100% of the entire checkout path**. Head-based sampling cannot do this, because at span-creation time nobody knows yet whether the request will fail, and a 10%-sampled payment failure is the one trace you needed and do not have. Exemplars link Prometheus histogram buckets to real traces, so clicking the p99 bar on a latency graph opens an actual slow request.

---

## 4. The four alert families that matter

Every service emits dozens of metrics; only a handful should wake someone. There are four things worth being woken for — a paid order that is not moving, a financial discrepancy, events not flowing, and the error budget burning — and the rules below are those four, some with more than one expression. Alert fatigue is the failure mode that makes an otherwise good observability setup useless, so the page-worthy list is short, and each entry is tied to a specific customer harm rather than to a resource threshold.

```yaml
# infra/grafana/alerts/critical.yaml

# ⭐ #1 — THE alert. A customer has paid and their work has not started.
# This is the risk the architecture consciously accepts, so detecting it fast
# is the condition on which that choice is defensible.
- alert: PaidOrderNotInProduction
  expr: platform_orders_awaiting_production_seconds > 900
  for: 1m
  labels: { severity: P1, page: true }
  annotations:
    summary: "Paid order(s) not in production for >15 min"
    impact: "Customer has been charged; retouching has not started; deadline at risk."
    runbook: "docs/CHECKOUT-SAGA.md#71-order-stuck-in-paid_awaiting_production-p1"
    dashboard: "https://grafana/d/checkout-health"

# ⭐ #2 — Financial correctness. Expected value is exactly zero, so ANY
# non-zero value pages. No threshold, because "a few unexplained discrepancies"
# is not an acceptable steady state for money.
- alert: ReconciliationDrift
  expr: sum(platform_reconciliation_drift_total{severity="P1"}) > 0
  for: 0m
  labels: { severity: P1, page: true }
  annotations:
    summary: "Financial reconciliation drift detected"
    runbook: "docs/CHECKOUT-SAGA.md#75-reconciliation-drift-p2"

- alert: DoubleChargeDetected
  expr: increase(platform_double_charge_detected_total[5m]) > 0
  for: 0m
  labels: { severity: P1, page: true }
  annotations:
    summary: "A double charge was detected — three independent guards failed"
    runbook: "docs/CHECKOUT-SAGA.md#74-suspected-double-charge-p1-always"

# ⭐ #3 — Events have stopped flowing. Every obligation in the system depends
# on this, so it is the earliest possible warning of a systemic stall.
- alert: OutboxLagHigh
  expr: max(platform_outbox_lag_seconds) > 60
  for: 2m
  labels: { severity: P1, page: true }
  annotations:
    summary: "Outbox relay lagging — invoices, production pushes and emails are stalled"

- alert: DlqNotEmpty
  expr: platform_dlq_depth{queue=~"q.dlq.production.*"} > 0
  for: 15m
  labels: { severity: P1, page: true }
- alert: DlqNotEmptyLowerPriority
  expr: platform_dlq_depth{queue!~"q.dlq.production.*"} > 0
  for: 30m
  labels: { severity: P2, page: false }

# ⭐ #4 — SLO burn rate. Multi-window so a fast burn pages immediately while a
# slow burn opens a ticket — rather than a single static threshold that either
# misses real degradation or fires on every blip.
- alert: CheckoutErrorBudgetBurnFast
  expr: |
    (
      sum(rate(platform_checkout_attempts_total{outcome="system_error"}[5m]))
      / sum(rate(platform_checkout_attempts_total[5m]))
    ) > (14.4 * 0.0005)
  for: 2m
  labels: { severity: P1, page: true }
  annotations:
    summary: "Burning the checkout error budget 14× too fast — 2% of monthly budget in 1h"
```

Note what is deliberately **not** paged: CPU, memory, pod restarts, individual 5xx responses, or a single failed Production push. Those are dashboard signals and ticket-generators. A pod restarting is not a customer problem; a pod restarting *while orders pile up unpushed* is, and that is what alert #1 catches — by measuring the customer outcome rather than the infrastructure symptom.

Payment declines are explicitly excluded from the error budget. A declined card is the system working correctly, and counting it as an error would either desensitise the alert or drive us to hide legitimate declines.

Three dashboards, each with one audience. **Checkout Health** is the on-call default: the awaiting-production gauge, funnel conversion by stage, capture-to-production distribution, DLQ depths, saga states. **Business** is for the leadership view: checkout volume and value, decline reasons, SLA attainment, revenue at risk. **Service** is one templated dashboard per service, RED plus USE plus dependency health, so a new service gets observability by adding a label rather than by building a dashboard.

---

## 5. Logging

Structured JSON to stdout, collected automatically by Container Apps into a Log Analytics workspace and queried with KQL. Log levels are used with intent: `error` means human action may be needed and is expected to be rare; `warn` means a retryable failure or degradation; `info` covers business events (order created, checkout completed); `debug` is local and staging only.

```jsonc
{
  "level": "error",
  "time": "2026-08-07T10:31:12.004Z",
  "service": "production-gateway-service",
  "version": "2.4.1",
  "pod": "production-gateway-7f9c-x2k",
  "msg": "Production push rejected permanently",
  "correlationId": "req_01JBQ…",       // ⭐ joins logs ↔ traces ↔ documents ↔ audit
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "tenantId": "ten_01JBQ…",
  "orderId": "ord_01JBQ…",
  "productionJobId": "prj_01JBQ…",
  "attempt": 1,
  "classification": "PERMANENT",
  "err": { "type": "ProductionRejectedError", "code": "UNSUPPORTED_ASSET_FORMAT",
           "httpStatus": 422, "rejectedAssets": ["oit_01JBQ…"],
           "stack": "…" },
  "action": "emitting production.job.rejected → refund saga"
}
```

The `action` field is a small habit with a large payoff: the log line states what the system did next, so an engineer reading it at 3 a.m. does not have to infer the consequence from code.

**Redaction happens at serialisation**, not at call sites, because a redactor that depends on every developer remembering will leak. Paths for `password`, `token`, `authorization`, `cardNumber`, `cvv`, `pspToken`, and `*.secret` are stripped centrally, and anything matching a PAN pattern is masked wherever it appears. Emails are partially masked in application logs (`s***@nikestudio.example`) and unmasked only in the audit log, where the legal basis is explicit.

Retention matches usefulness rather than a single blanket policy: application logs 30 days, audit logs 7 years and immutable, traces 7 days, metrics 15 months at declining resolution.

---

## 6. Operating the system

Health endpoints follow the liveness/readiness distinction properly — Container Apps probes map onto it directly ([DEPLOYMENT §6](DEPLOYMENT.md#6-configuration-and-secrets)) — and it is worth stating because getting it wrong is a classic self-inflicted outage. `/health/live` is a process check that **never touches a dependency** — a liveness probe that fails when Mongo blips restarts every pod in the fleet during a database hiccup, converting a partial degradation into a total outage. `/health/ready` checks Mongo, RabbitMQ, and Redis and removes only that pod from the load balancer. `/health/startup` covers slow first-boot work such as index creation.

Graceful shutdown is implemented rather than assumed: on `SIGTERM` the pod fails readiness immediately, waits for the load balancer to drain, stops RabbitMQ prefetch and finishes in-flight messages, finishes in-flight HTTP requests, then closes connections in reverse dependency order, with a 30 s hard deadline. Without this, every rolling deploy orphans in-flight sagas — which the saga's persisted state would recover, but recovering from a self-inflicted problem thirty times a week is not operating a system, it is tolerating one.

Ops tooling exists because the design accepts states that need human resolution ([API §4](API.md#4-rate-limits-health-and-operations)). Replaying a DLQ message, resuming a stuck saga, retrying a production push, reconciling against the Production system, and rebuilding a projection are all first-class, audited endpoints with runbook links from the alert that fires. Every ops action is safe to repeat, because every consumer is idempotent — which is what makes the runbooks short enough to follow under pressure.

Chaos experiments run in staging on a schedule so the resilience claims in these documents are tested rather than asserted: PSP latency injection and 500s, Production system 503s and permanent rejections, RabbitMQ partitions and broker node loss, MongoDB primary step-down, Redis eviction, and pod kills at each saga step. Each experiment has a written expected outcome, and a divergence is a bug — including a divergence from what this documentation claims, because a design document that no longer describes the system is worse than none.

**Post-incident practice.** Blameless reviews within 48 hours, with a specific requirement: every incident must produce either a new alert, a new test, or a documented decision to accept the risk. "Be more careful" is not an action item. Any incident involving money or cross-tenant data gets a written report regardless of customer impact, because near-misses in those two areas are the cheapest lessons this system will ever get.
