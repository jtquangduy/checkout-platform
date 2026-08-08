# Performance & Scalability

> *"How will you manage performance?"* — the brief's other explicit question.
> Indexes referenced here are defined in [DATA-MODEL §3.4](DATA-MODEL.md#34-indexes). The flow being optimised is in [CHECKOUT-SAGA](CHECKOUT-SAGA.md).

---

## 1. Load model — sizing for reality, not for a resume

Performance work without a load model is guesswork, so here is the model the design is sized against. It is derived from the shape of the business: ecommerce studios work in bursts around campaign deadlines, which makes the load spiky rather than uniform.

| Dimension | Today | 12-month target | Notes |
|---|---|---|---|
| Tenants | 200 | 800 | Mid-size studios and brand in-house teams |
| Active users / tenant | 5–40 | 5–60 | Art Directors, Producers, Finance |
| Orders created | 50k / month | 250k / month | ~2k/day average |
| Assets per order | 50–500 (p50 ≈ 180) | same | Hard cap 500; larger batches must be split |
| Checkouts | 1.7k / day | 8k / day | The expensive write path |
| **Peak checkouts** | **20 / min** | **90 / min** | Month-end deadline crunch — 15× the daily mean |
| Search queries | 10M / month | 48M / month | Typeahead makes this the dominant request type |
| **Peak search RPS** | **60** | **300** | Every keystroke is a request (debounced) |
| Order doc size | 40–420 KB | same | Dominated by embedded items |
| Search view doc size | ~1 KB | same | Deliberately tiny — this is the point |

Two observations drive everything below. **Reads dominate writes by roughly 200:1**, so the read path deserves a purpose-built structure while the write path can afford to do extra work. And **peak is 15× the mean**, so autoscaling and queue buffering matter far more than raw single-node throughput; the system must absorb a burst gracefully rather than be permanently sized for it.

---

## 2. Service level objectives

Budgets, not aspirations. Each is an alert, and each is attributable to a specific design decision below.

| Path | p50 | p95 | p99 | Why this number |
|---|---|---|---|---|
| `GET /orders?q=` (search) | 12 ms | **200 ms** | 400 ms | Typeahead must feel instantaneous; >200 ms reads as laggy |
| `GET /orders/suggest` | 6 ms | 80 ms | 150 ms | Fires per keystroke |
| `GET /orders/{id}` | 20 ms | 250 ms | 500 ms | Includes SAS thumbnail URL minting |
| `POST /checkout-sessions` | 780 ms | **1.5 s** | 3 s | Dominated by the PSP round trip (~600 ms p50), which we do not control. Excludes the ambiguous-timeout path (8 s PSP cut-off + reconciliation lookup), which is tracked as its own counter rather than hidden in this histogram |
| Capture → `checkout.completed` published | 150 ms | 500 ms | 2 s | Outbox relay poll interval is 250 ms, so mean added latency is ~125 ms |
| Capture → Production job accepted | 8 s | **30 s** | 60 s | The requirement that actually matters commercially. Anything still unpushed at 15 min pages |
| Capture → invoice issued | 13 s | 30 s | 60 s | Dominated by PDF rendering (~1.6 s) plus queue wait |
| Capture → confirmation email accepted | 15 s | 45 s | 90 s | Deliberately last: it waits for the invoice number so the client gets one email, not two |
| Availability (checkout) | — | **99.95%** | — | ≈ 22 min/month error budget |
| Availability (search) | — | 99.9% | — | Degradable; never blocks checkout |

The checkout SLO is deliberately not aggressive. Roughly 600 ms of a 780 ms p50 is the PSP, and pretending we can optimise that away would produce a target we miss every month. What we *can* control is our own overhead — validate, quote-verify, reserve, and confirm together fit in ~120 ms — and the honest engineering statement is that our contribution to checkout latency is under 200 ms of a 780 ms total.

The Production-push SLO is the one with commercial teeth: 30 s at p95 from capture to accepted job, alerting at 15 minutes. That alert is what converts "we hope it worked" into "we know within 15 minutes".

The worked example threaded through the other documents lands close to these p50s — production at +8.3 s, invoice at +12.8 s, email at +14.9 s from capture — so the timeline in [OBSERVABILITY §3](OBSERVABILITY.md#3-tracing) is a typical checkout rather than a flattering one.

---

## 3. Order search — the hot read path

The stated requirement is one line ("orders could be searched/filtered by name"), and it is also the single highest-volume operation in the product. It gets the most design attention for that reason.

### 3.1 What would go wrong with the obvious implementation

```js
// ❌ The version that works in a demo and dies at 10k orders per tenant.
db.orders.find({
  tenantId,
  name: { $regex: userInput, $options: 'i' },   // leading-wildcard regex
}).sort({ createdAt: -1 }).skip(page * 25).limit(25);
```

Four independent problems, and they compound. A case-insensitive regex without a leading anchor **cannot use an index** — MongoDB collection-scans every order in the tenant and runs a regex against each. The documents being scanned are 40–420 KB each because they embed up to 500 items, so a scan of 10k orders reads gigabytes to return 25 rows of 1 KB. `skip(page * 25)` walks and discards every preceding document, so page 40 costs 40× page 1 — and it silently returns duplicates or omissions when new orders arrive mid-pagination. And the `$regex` is untokenised, so "ss26 nike" finds nothing even though "Nike SS26" exists.

### 3.2 What we do instead

Four changes, each addressing one of the above:

**A dedicated read model.** `order_search_view` holds exactly the ~1 KB the results list renders. Scanning it is 40–400× cheaper per document than scanning `orders`, and because it is small, the whole working set for a tenant fits comfortably in RAM — the difference between a memory-resident query and a disk-bound one.

**Normalised, pre-tokenised names.** Written by the domain layer on every change, so matching behaviour can never drift from storage: `nameNormalized` (lowercased, diacritics stripped, punctuation collapsed) and `nameTokens` (the split array). Multikey indexing `nameTokens` turns a substring hunt into an indexed equality-or-prefix lookup per token.

**Anchored prefix matching per token.** Complete tokens match by equality; only the final token — the one the user is still typing — uses an anchored `^prefix` regex, which *is* index-eligible because it has no leading wildcard.

**Keyset pagination.** `(createdAt, _id)` as an opaque cursor, so page 40 costs the same as page 1 and concurrent inserts cannot cause duplicates or skips.

```ts
// services/order-service/src/infrastructure/mongo/order-search.repository.ts
async search(q: SearchQuery): Promise<Page<OrderSummary>> {
  const filter: Filter<SearchViewDoc> = { tenantId: this.ctx.tenantId };

  if (q.q) {
    const tokens = normalize(q.q).split(' ').filter(Boolean);
    const complete = tokens.slice(0, -1);
    const partial  = tokens.at(-1)!;

    filter.$and = [
      // Complete tokens: indexed equality on the multikey array. AND semantics,
      // so "nike batch" narrows rather than widens.
      ...complete.map((t) => ({ nameTokens: t })),
      // Final token: anchored prefix. Index-eligible precisely BECAUSE it is
      // anchored — `^nik` uses the index, `nik` would not.
      // reference and tags are secondary matches, as advertised in API §2.1.
      // reference and tags are secondary matches, as advertised in API §2.1.
      // referenceNormalized is written by the domain layer exactly like
      // nameNormalized, so this stays a case-SENSITIVE anchored regex and
      // therefore index-eligible. $options:'i' would silently disable the index.
      { $or: [
        { nameTokens:          { $regex: `^${escapeRegex(partial)}` } },
        { referenceNormalized: { $regex: `^${escapeRegex(partial)}` } },
        { tags: partial },
      ] },
    ];
  }

  if (q.status?.length)  filter.status = { $in: q.status };
  if (q.createdFrom || q.createdTo)
    filter.createdAt = { ...(q.createdFrom && { $gte: q.createdFrom }),
                         ...(q.createdTo   && { $lt:  q.createdTo }) };
  if (q.slaBefore)       filter.slaDueAt = { $lt: q.slaBefore };
  if (q.minTotal)        filter['total.amount'] = { ...(filter['total.amount'] as object),
                                                      $gte: q.minTotal };
  if (q.maxTotal)        filter['total.amount'] = { ...(filter['total.amount'] as object),
                                                      $lte: q.maxTotal };
  if (q.tags?.length)    filter.tags = { $all: q.tags };
  if (q.createdBy)       filter['createdBy.userId'] = q.createdBy;

  // Keyset pagination: "everything strictly after this (createdAt, _id)".
  // _id breaks ties so the ordering is total and stable.
  if (q.cursor) {
    const { createdAt, id } = decodeCursor(q.cursor);
    filter.$or = [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: { $lt: id } },
    ];
  }

  const rows = await this.col
    .find(filter, {
      // Explicit projection. Never `find(filter)` and shape it in JS — that
      // pulls bytes over the wire and defeats covered-index reads.
      projection: { name: 1, reference: 1, status: 1, itemCount: 1, total: 1,
                    thumbnailKey: 1, createdBy: 1, createdAt: 1, slaDueAt: 1 },
    })
    .sort({ createdAt: -1, _id: -1 })
    .limit(q.limit + 1)                       // +1 sentinel reveals hasMore
                                              // without a second count query
    // No .hint(): when `q` is present the planner picks ix_search_tokens and
    // adds a bounded SORT stage (the multikey range predicate on nameTokens
    // means the index cannot also supply the ordering — an honest cost, and the
    // reason the matched set is kept small by tenant + status filters). With no
    // `q`, ix_keyset serves filter AND sort with no SORT stage at all. Pinning a
    // hint would break the second case to protect the first.
    .maxTimeMS(1_500)                         // a slow query is a failed query;
                                              // it must not hold a connection
    .toArray();

  const hasMore = rows.length > q.limit;
  return { data: rows.slice(0, q.limit).map(toSummary),
           page: { hasMore, nextCursor: hasMore ? encodeCursor(rows[q.limit - 1]) : null } };
}
```

Benchmarked on a seeded tenant with 50k orders (phase 0 spike, [DELIVERY-PLAN §2](DELIVERY-PLAN.md#2-phase-0-validate-before-building-week-1)): p50 12 ms, p95 47 ms. Filter-only queries are index-covered and examine ~1.02 documents per document returned; token queries add a SORT stage over the matched set, which is a few hundred 1 KB documents for a typical tenant rather than 50k 400 KB ones. The naive version on the same data is 1.4 s and examines all 50,000.

### 3.3 The Atlas Search upgrade path

The token approach handles prefix and multi-word matching well but not fuzziness — "nkie" finds nothing. Rather than build a bespoke trigram index, the path is Atlas Search behind `FEATURE_ATLAS_SEARCH`, which adds typo tolerance, proper relevance scoring, and highlighting:

```js
{ $search: {
    index: 'orders_search',
    compound: {
      filter: [{ equals: { path: 'tenantId', value: tenantId } }],   // tenant isolation FIRST
      should: [
        { autocomplete: { query: q, path: 'name', tokenOrder: 'sequential',
                          fuzzy: { maxEdits: 1, prefixLength: 2 }, score: { boost: { value: 10 } } } },
        { text: { query: q, path: 'reference', score: { boost: { value: 5 } } } },
        { text: { query: q, path: 'tags' } },
      ],
      minimumShouldMatch: 1,
    },
    highlight: { path: 'name' },
} }
```

Both implementations sit behind the same repository interface, so the switch is a config flag and a canary on a few tenants, not a rewrite. The flag also means an Atlas Search outage degrades to the Mongo path rather than breaking search.

### 3.4 Keeping the projection correct

The projection is updated **in the same transaction as the aggregate**, which is unusual for CQRS and deliberate: search becomes read-your-own-writes consistent, so a user who renames an order finds it immediately. Given a 200:1 read:write ratio, spending ~3 ms extra on the write path to remove an entire category of "why can't I find my order?" support ticket is an easy trade.

The projection is also rebuildable, because any projection that cannot be rebuilt is a liability. `POST /ops/projections/order-search/rebuild` runs a resumable, batched, tenant-scoped job that writes into a new collection and atomically renames, so a shape change or a bug fix does not require downtime. `projectionVersion` on each row makes stale rows detectable, and the nightly reconciliation compares row counts and checksums against `orders`.

---

## 4. The checkout write path

Checkout is 200× rarer than search but 100× more expensive, and it is where a customer is actively waiting.

**Round trips are the budget.** The pre-capture phase is four sequential calls, and each one is on the critical path. Two are gRPC rather than REST (order-service and payment-service) — protobuf plus HTTP/2 multiplexing saves ~8 ms per call against JSON over HTTP/1.1 with a fresh connection, which is 3% of our controllable latency for a contract we wanted typed anyway. Connections are long-lived and pooled; TLS handshakes never appear on the hot path.

**Verify the quote from the snapshot, not from a recompute.** The pricing check re-hashes the snapshot's three stored lines rather than re-running pricing over 400 units against the price book, its tiers, and its tax profile — O(lines), not O(units), and three lines rather than four hundred. The full recompute runs when the quote is *created*, off the critical path.

**One capture call, not authorise-then-capture.** This product has no delayed-capture flow, so splitting the PSP interaction into two round trips would cost ~600 ms for no benefit.

**The response returns at the commit point.** Everything after capture is asynchronous, which is what keeps checkout at 780 ms instead of 8–15 s. This is the architecture paying for itself in latency as well as in reliability.

**Nothing large is loaded that is not needed.** The orchestrator never loads the order's 500 embedded items — validation and reservation use projections. production-gateway loads them exactly once, off the critical path, when it builds its manifest.

---

## 5. Database performance

**Index discipline.** Every index in [DATA-MODEL §3.4](DATA-MODEL.md#34-indexes) exists to serve a named query; the leading field is always `tenantId` so every scan is bounded to one tenant. Partial indexes are used wherever a query targets a small subset of a large collection — `ix_stale_reservations` indexes only `CHECKOUT_PENDING` orders, so the reaper's index is a few hundred entries rather than millions, which also keeps it in cache. CI fails a pull request that adds a query whose `explain()` shows a `COLLSCAN` on a collection over 10k documents, so index regressions are caught before merge rather than in production.

**Document size is a design constraint, not an afterthought.** Embedding up to 500 items keeps an order between 40 and 420 KB — comfortably under the 16 MB limit, but large enough that we never scan `orders` for a list view. The 500-item cap is enforced at validation with a clear message directing the user to split the batch; unbounded array growth is the classic MongoDB anti-pattern and the cap is the fix. `statusHistory` is capped with `$slice: -200` so it cannot grow without limit either.

**Read preference by intent.** Writes and everything on the checkout path use `primary`. Search, reporting, and the reconciliation job use `secondaryPreferred` with `maxStalenessSeconds: 90`, which moves the dominant read volume off the primary entirely — the single biggest lever available for read scaling before sharding.

**Connection pools are bulkheads.** Each service has its own pool sized to its concurrency (`maxPoolSize: 50`, `minPoolSize: 5`, `waitQueueTimeoutMS: 2000`). The 2 s wait-queue timeout is deliberate: failing fast when the pool is exhausted turns a creeping degradation into a clean, visible error that sheds load, rather than a queue that grows until every request times out.

**The sharding path is decided in advance, not improvised during an incident.** Shard key `{ tenantId: 'hashed' }` for even distribution, with `{ tenantId: 1, createdAt: -1 }` ranged on the search view so range queries stay targeted. Because `tenantId` already leads every index and every query, sharding is an operational change rather than a code change — which is the entire reason for that convention. The trigger is a single tenant's working set exceeding available RAM, not a document count.

---

## 6. Caching

Caching is applied narrowly, because a cache is a second source of truth and every one added is a consistency bug waiting to happen. The test applied to each: is this read-heavy, is it slow or expensive to compute, and is staleness genuinely acceptable?

| What | Where | TTL | Invalidation | Why it is safe |
|---|---|---|---|---|
| JWKS public keys | In-process | 10 min | On `kid` miss | Public keys; rotation tolerates staleness |
| Tenant settings | Redis | 5 min | Event-driven on `tenant.updated` | Rarely changes; a stale limit for 5 min is harmless |
| Price book | Redis | 15 min | Event-driven on `price_book.published` | **Never used for a charge** — charges use the immutable snapshot |
| Search results | Redis | 30 s | Tenant-scoped tag flush on any order write | Display-only, and flushed on write. Never read to decide eligibility — `canCheckout` and every checkout precondition are re-derived from the aggregate |
| Facet counts | Redis | 60 s | TTL only | Already labelled an estimate in the API |
| SAS thumbnail URLs | Redis | 12 min | TTL only (URL TTL 15 min) | Cache expires before the URL does |
| Rendered invoice PDFs | Blob + Front Door | Immutable | Never — content-addressed | Invoices are immutable by definition |

**Never cached:** order status, payment state, saga state, invoice status, or anything the checkout path reads. On the money path, a stale read is a correctness bug, and the latency saved is not worth it.

The search cache is the one worth explaining. Typeahead repeatedly requests the same prefixes (`n`, `ni`, `nik`, `nike`), so a 30 s cache keyed on `tenant:normalizedQuery:filters:cursor` absorbs most of the keystroke traffic. Any write to an order flushes that tenant's tag namespace, so the cache is invalidated rather than merely expiring — meaning a rename appears in search immediately, consistent with the read-your-own-writes guarantee from §3.4. Cache stampedes on a popular prefix are prevented with a single-flight lock.

---

## 7. Asynchronous throughput

**Prefetch is tuned per consumer, not copy-pasted.** Notification gets 64 because its work is a fast network call; invoice gets 16 because PDF generation is CPU-bound and a high prefetch just builds a local queue that hides latency; production gets 8 because the manifests are large and a low prefetch protects the *upstream* system from us. A single global prefetch value would be wrong for all three.

**Consumers scale on queue depth, not CPU.** A native Container Apps KEDA scale rule targets 30 messages per replica on each queue, 0–20 replicas ([DEPLOYMENT §8](DEPLOYMENT.md#8-scaling-rules)). CPU-based scaling is the wrong signal here: an I/O-bound consumer waiting on a slow Production system shows low CPU while its queue grows without bound, so a CPU-triggered autoscaler does nothing precisely when scaling is most needed.

**Batching where it is free.** The outbox relay claims 100 rows per poll and publishes them on one channel with pipelined confirms. `production.job.progressed` events are coalesced — progress callbacks arrive every few seconds per job and only the latest matters, so we debounce to one write per job per 10 s and drop stale ones by `occurredAt`, cutting write volume by roughly 80% during a busy render window.

**Bursts are absorbed by the broker, not by scaling.** At the month-end peak of 90 checkouts/minute, each fanning out to three consumers, the queues take the shock; consumers drain at their own pace and the customer never sees it, because they already have their `201`. Quorum queues on SSD-backed volumes (managed RabbitMQ — see [DEPLOYMENT §2.1](DEPLOYMENT.md#21-the-broker-is-the-honest-wrinkle)), bounded with `x-max-in-memory-length` so a deep backlog spills to disk rather than to RAM, handle hundreds of thousands of messages without memory pressure. (Lazy mode is a classic-queue setting and does not apply to quorum queues — the in-memory limit is the quorum equivalent.) This is the main reason the post-capture phase is asynchronous rather than merely parallel: elasticity comes free with a queue.

---

## 8. Frontend performance

The perceived performance of this product is dominated by two screens: the order list and the checkout flow.

Search input is debounced at 250 ms and every in-flight request is aborted when superseded, so fast typing produces one request rather than eight. TanStack Query provides request deduplication, a 30 s stale window, and `keepPreviousData`, so paging and refining a query never flash an empty list. The results list is virtualised with TanStack Virtual — a studio with 5,000 matching orders renders 15 DOM rows, which is the difference between a smooth scroll and a janky one.

Thumbnails are served from Azure Front Door as pre-generated WebP at exactly the rendered size, lazy-loaded with `IntersectionObserver`, with `width`/`height` set to prevent layout shift. A 400-image order list would otherwise be tens of megabytes of full-resolution TIFF-derived JPEGs.

The bundle is route-split, with the checkout flow and its PSP SDK loaded only on demand — the search screen does not pay for payment code it will not run. Budgets are enforced in CI: 180 KB gzipped for the initial route, LCP under 2.0 s and INP under 200 ms on a simulated mid-tier laptop, and Lighthouse CI fails the build on regression.

During checkout the UI is honest about the architecture: the `201` arrives in under a second and the three obligations appear as individually-resolving checkmarks over the SSE stream, so a slow Production push looks like *one item still working* rather than a frozen page. Details in [FRONTEND](FRONTEND.md).

---

## 9. Load testing

Performance claims that are not measured are decoration. k6 scenarios run nightly against staging and in CI on any change to a hot path, with thresholds that fail the build:

```js
// infra/k6/checkout-peak.js
export const options = {
  scenarios: {
    // The realistic mix: search is 200× checkout volume.
    search:   { executor: 'ramping-arrival-rate', startRate: 20, timeUnit: '1s',
                stages: [{ target: 60, duration: '2m' }, { target: 300, duration: '5m' },
                         { target: 300, duration: '10m' }] },
    // Month-end crunch: 90/min sustained.
    checkout: { executor: 'constant-arrival-rate', rate: 90, timeUnit: '1m', duration: '15m',
                preAllocatedVUs: 50 },
  },
  thresholds: {
    'http_req_duration{name:search}':   ['p(95)<200', 'p(99)<400'],
    'http_req_duration{name:checkout}': ['p(95)<1500', 'p(99)<3000'],
    'http_req_failed': ['rate<0.001'],
    // The SLO that matters commercially, measured end-to-end via the SSE stream.
    'checkout_to_production_seconds': ['p(95)<30'],
    'checks{check:no_double_charge}': ['rate==1.00'],
  },
};
```

Alongside load testing, soak tests run 12 hours at 40% peak to catch leaks and unbounded growth; spike tests jump from 10% to 150% peak in 30 s to verify autoscaling and graceful degradation rather than collapse; and chaos experiments (Toxiproxy) inject PSP latency, Production-system 503s, RabbitMQ partitions, and MongoDB primary step-downs to confirm the resilience mechanisms behave as documented under real failure rather than in a diagram.

---

## 10. Degradation ladder

When something breaks, the system should lose the least valuable capability first. This ordering is a product decision as much as a technical one, and it is written down so it is not improvised during an incident.

| Failure | Degradation | Checkout still works? |
|---|---|---|
| Redis unavailable | Cache bypassed to Mongo; rate limits fail **open** with an alert; idempotency falls back to Mongo | **Yes** — slower |
| Atlas Search unavailable | Falls back to the Mongo token index (no fuzziness) | **Yes** |
| catalog-pricing unavailable | Uses the order's immutable snapshot; new quotes blocked | **Yes** |
| invoice-service unavailable | Messages queue; invoices issue late | **Yes** |
| notification-service unavailable | Emails queue; in-app confirmation shown | **Yes** |
| Production system unavailable | Orders sit in `PAID_AWAITING_PRODUCTION`; retry ladder + alert | **Yes** |
| Accounting ledger unavailable | `accountingSync: FAILED`, background retry; invoice still valid and visible | **Yes** |
| RabbitMQ unavailable | Outbox accumulates durably; nothing lost; obligations discharge on recovery | **Yes** |
| payment-service or PSP unavailable | Checkout returns `503` with `Retry-After`; order released; nothing charged | **No** — correctly |
| MongoDB primary lost | ~10 s election, driver retries transparently | Brief pause, then yes |

Nine of the ten leave checkout working. Only a payment-path failure stops it, and in that case it stops *cleanly* — no charge, no reservation left behind, and an honest error. Rate limits failing open when Redis dies is a deliberate choice: dropping legitimate paying customers to enforce a limit is a worse outcome than briefly tolerating abuse, and the alert means we know.
