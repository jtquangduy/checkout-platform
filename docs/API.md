# HTTP API Contracts

> Schemas referenced here are defined in [DATA-MODEL](DATA-MODEL.md). Event contracts are in [EVENTS](EVENTS.md). The checkout call flow is in [CHECKOUT-SAGA](CHECKOUT-SAGA.md).

---

## 1. API strategy — three protocols, each where it earns its place

Using one protocol everywhere is a common and expensive mistake, so this design picks deliberately per traffic type.

**REST/JSON over HTTP for north–south traffic** (portal → gateway → services). It is cacheable, debuggable with curl, understood by every engineer we will hire, and trivially inspectable in a browser devtools panel. Resource-shaped URLs, standard status codes, `Idempotency-Key` on every mutation.

**gRPC for the two hottest east–west calls** — orchestrator → order-service (validate/reserve) and orchestrator → payment-service (authorise/capture). These are internal, high-frequency, latency-sensitive, and strongly typed, which is exactly gRPC's sweet spot: protobuf gives us a generated, breaking-change-detectable contract, and HTTP/2 multiplexing plus binary framing shaves real milliseconds off the checkout critical path. Everything else internal stays REST, because the marginal gain does not justify the operational surface.

**GraphQL is deliberately *not* the primary API.** It is offered as a single read-only aggregation endpoint at the BFF for one specific problem: the order-detail screen, which needs data from four services and would otherwise be a client-side waterfall. Making GraphQL the whole API would hand us N+1 resolvers across service boundaries, unbounded query cost, and a caching story we would have to rebuild from scratch. Rationale in [ADR-0005](adr/0005-bff-gateway-with-scoped-graphql.md).

**SSE for realtime.** Checkout progress is server→client only, so Server-Sent Events over HTTP/2 avoids WebSocket upgrades at the load balancer and sticky-session requirements entirely.

### 1.1 Conventions applied to every endpoint

Versioning is in the path (`/api/v1`), because a URL is the one place a version is impossible to miss. Identifiers are prefixed ULIDs, so a support ticket containing `ord_01JBQ7…` is self-describing. Money in every request and response is `{ amount, currency }` with `amount` as integer minor units — never a decimal string, never a float. Timestamps are RFC 3339 UTC with milliseconds. Collections are keyset-paginated (`?limit=&cursor=`), never offset-paginated. Field selection uses `?fields=`, sorting uses `?sort=-createdAt`.

Every mutating endpoint requires an `Idempotency-Key` header and honours it for 24 hours. Every request carries or is assigned an `X-Correlation-Id` plus W3C `traceparent`, both echoed in the response and stamped on every document and event the request produces. Optimistic concurrency uses `If-Match` with the resource's `ETag` (the aggregate `version`); a stale `If-Match` is a `409`, never a silent overwrite.

```http
Authorization: Bearer <RS256 JWT>
Idempotency-Key: ik_01JBQ7X8K3ZP4Y6M2N9V5TWDFH     # required on POST/PATCH/DELETE
If-Match: "7"                                   # required on PATCH of a versioned resource
X-Correlation-Id: req_01JBQ7X8K3ZP4Y6M2N9V5TWDFH
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
Content-Type: application/json
```

### 1.2 Error model — RFC 9457 Problem Details

One error shape across all ten services, because a client should never need per-service error handling. `code` is a stable machine-readable enum; `title`/`detail` are for humans; `retryable` tells a client whether to offer "try again"; `errors[]` carries field-level validation failures.

```json
{
  "type": "https://errors.example.com/payment-declined",
  "title": "Payment was declined",
  "status": 402,
  "code": "PAYMENT_DECLINED",
  "detail": "Your card was declined by the issuing bank. Try a different card.",
  "instance": "/api/v1/checkout-sessions/cko_01JBQ7X8K3ZP4Y6M2N9V5TWDFH",
  "correlationId": "req_01JBQ7X8K3ZP4Y6M2N9V5TWDFH",
  "retryable": false,
  "errors": []
}
```

| Status | `code` values | Meaning and client action |
|---|---|---|
| 400 | `VALIDATION_FAILED`, `MALFORMED_JSON`, `IDEMPOTENCY_KEY_REQUIRED` | Fix the request; `errors[]` names the fields. The key is required, not optional — see [DATA-INTEGRITY §5](DATA-INTEGRITY.md#5-http-idempotency). |
| 401 | `TOKEN_MISSING`, `TOKEN_EXPIRED`, `TOKEN_INVALID` | Refresh the token, then retry once. |
| 402 | `PAYMENT_DECLINED`, `INSUFFICIENT_FUNDS`, `CARD_EXPIRED` | Surface the decline; offer another method. |
| 403 | `INSUFFICIENT_ROLE`, `TENANT_MISMATCH` | Never retry. `TENANT_MISMATCH` is logged as a security event. |
| 404 | `ORDER_NOT_FOUND`, `INVOICE_NOT_FOUND` | Returned for cross-tenant access too, so existence is not leaked. |
| 409 | `ORDER_VERSION_CONFLICT`, `ORDER_ALREADY_RESERVED`, `ORDER_ALREADY_PAID`, `INVALID_STATE_TRANSITION`, `REQUEST_IN_PROGRESS` | Refetch and re-present. `ALREADY_RESERVED` is the concurrent-checkout case; `REQUEST_IN_PROGRESS` means an identical idempotent request is still running — honour `Retry-After`. |
| 422 | `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY`, `QUOTE_EXPIRED`, `PRICE_MISMATCH` | A real bug or a stale client; do not retry blindly. |
| 429 | `RATE_LIMITED` | Honour `Retry-After`. |
| 500 | `INTERNAL_ERROR` | Retry with backoff; `correlationId` is the support handle. |
| 503 | `DEPENDENCY_UNAVAILABLE`, `CIRCUIT_OPEN` | Retry with backoff; `Retry-After` supplied. |
| 504 | `DEPENDENCY_TIMEOUT` | **Ambiguous outcome.** Retry with the *same* `Idempotency-Key`. |

Note what is *not* in this table: a status for "3-D Secure required". That is a normal outcome, not an error, and is returned as a `201` with `status: REQUIRES_ACTION` — see §2.3.

Consumer-side codes never reach an HTTP client but use the same enum in dead-letter records and logs: `SCHEMA_VALIDATION_FAILED`, `PRODUCTION_TRANSIENT`, `PRODUCTION_PERMANENT`, `SUPPRESSED_RECIPIENT`, `TEMPLATE_NOT_FOUND`.

The `504` row is the one that matters most. A gateway timeout on a capture does not mean the capture failed — it means we do not know. Reusing the same idempotency key is the only safe response, which is why the header is mandatory rather than advisory.

---

## 2. Public API — `api-gateway`, base `https://api.example.com/api/v1`

### 2.1 Order search — the primary requirement

> *Functional requirement: "Orders could be searched/filtered by name."*

```http
GET /api/v1/orders?q=nike%20ss26&status=READY_FOR_CHECKOUT&sort=-createdAt&limit=25
```

| Parameter | Type | Notes |
|---|---|---|
| `q` | string, ≤120 chars | Case- and diacritic-insensitive match on order name, with `reference` and `tags` as secondary fields. Multi-word input is AND-ed across tokens; the final token is treated as a prefix so typeahead works mid-word. |
| `status` | enum, repeatable | `?status=READY_FOR_CHECKOUT&status=DRAFT` → OR within the filter. |
| `createdFrom` / `createdTo` | RFC 3339 | Half-open range. |
| `slaBefore` | RFC 3339 | Deadline board — "what is due in the next 24 h". `slaDueAt` is `null` until checkout, because the client's deadline clock starts when they pay. |
| `minTotal` / `maxTotal` | integer minor units | Never a decimal. |
| `createdBy`, `tags` | string, repeatable | |
| `sort` | enum | `-createdAt` (default) and `createdAt` are keyset-paginated. `name`, `-slaDueAt` and `-total` are offered as *bounded* sorts: they cap at 500 results and return no cursor, because a keyset cursor is only correct on the field the index orders by. Documented rather than silently degraded. |
| `limit` | 1–100, default 25 | |
| `cursor` | opaque | From `page.nextCursor`. Mutually exclusive with `sort` changes. |

`tenantId` is **not** a parameter — it is taken from the JWT. Accepting it from the client would be the single most likely path to a cross-tenant data leak.

```json
{
  "data": [
    {
      "id": "ord_01JBQ7X8K3ZP4Y6M2N9V5TWDFH",
      "name": "Nike SS26 Apparel — Batch 04",
      "reference": "PO-4471",
      "status": "READY_FOR_CHECKOUT",
      "itemCount": 400,
      "total": { "amount": 163020, "currency": "GBP" },
      "thumbnailUrl": "https://cdn.example.com/…/thumb.webp?X-Amz-Expires=900",
      "createdBy": { "id": "usr_01JBQ…", "name": "Sofia Marin" },
      "createdAt": "2026-08-01T09:12:03.114Z",
      "slaDueAt": null,
      "canCheckout": true,
      "_links": {
        "self": { "href": "/api/v1/orders/ord_01JBQ7X8K3ZP4Y6M2N9V5TWDFH" },
        "checkout": { "href": "/api/v1/checkout-sessions", "method": "POST" }
      }
    }
  ],
  "page": { "limit": 25, "nextCursor": null, "hasMore": false },
  "meta": {
    // Facets are computed WITHOUT the status filter applied, so the chips show
    // what each alternative filter would return rather than all reading zero.
    "facets": { "status": { "READY_FOR_CHECKOUT": 18, "DRAFT": 4,
                            "IN_PRODUCTION": 31, "DELIVERED": 210 } },
    "took": 14,
    // Estimate for the CURRENT filter (status=READY_FOR_CHECKOUT).
    "totalEstimate": 18
  }
}
```

Two deliberate choices. `canCheckout` is computed server-side from status, item count, quote validity, and the caller's permissions — the client must never re-derive eligibility, or the button's enabled state and the server's rules will drift. And `totalEstimate` is explicitly an estimate: an exact count of a filtered set requires a full scan, which is precisely the query that gets slow at scale, so we return an estimate and let the UI say "53+".

Typeahead is a separate, cheaper endpoint returning only ids and names, so a keystroke-per-request path never pays for facets or SAS thumbnail URLs:

```http
GET /api/v1/orders/suggest?q=nike&limit=8
→ 200 { "data": [ { "id": "ord_01JBQ…", "name": "Nike SS26 Apparel — Batch 04",
                    "status": "READY_FOR_CHECKOUT",
                    "highlight": "<em>Nike</em> SS26 Apparel — Batch 04" } ] }
```

### 2.2 Order detail and lifecycle

```http
GET    /api/v1/orders/{orderId}          → 200 full aggregate + pricingSnapshot + refs; ETag: "7"
POST   /api/v1/orders                    → 201 create (DRAFT)
PATCH  /api/v1/orders/{orderId}          → 200 rename/retag/reprice; requires If-Match
POST   /api/v1/orders/{orderId}/items    → 201 add items (bulk; ≤500 total)
DELETE /api/v1/orders/{orderId}/items/{itemId}
POST   /api/v1/orders/{orderId}/quote    → 201 request quote → PRICING → READY_FOR_CHECKOUT
POST   /api/v1/orders/{orderId}/cancel   → 200 (only from DRAFT | PRICING | READY_FOR_CHECKOUT)
GET    /api/v1/orders/{orderId}/timeline → 200 statusHistory + payment/invoice/production events
POST   /api/v1/orders/{orderId}/upload-urls          → 201 SAS upload URLs (asset-service)
```

`GET /orders/{id}` returns `403 TENANT_MISMATCH` semantics as `404` on purpose: telling an attacker that `ord_…` exists but belongs to someone else is itself a leak.

### 2.3 Checkout — the core scenario

> *Functional requirements: push to Production on success; email the client on payment success.*

```http
POST /api/v1/checkout-sessions
Idempotency-Key: ik_01JBQ7X8K3ZP4Y6M2N9V5TWDFH
```

```json
{
  "orderId": "ord_01JBQ7X8K3ZP4Y6M2N9V5TWDFH",
  "paymentMethod": { "kind": "SAVED", "ref": "pm_01JBQ8M2N9V5TWDFHZP4Y6K3" },
  "expectedTotal": { "amount": 163020, "currency": "GBP" },
  "billingContactEmail": "sofia@nikestudio.example",
  "purchaseOrderRef": "PO-4471",
  "returnUrl": "https://portal.example.com/orders/ord_01JBQ…/checkout/return"
}
```

`paymentMethod.kind` is `SAVED` (a stored `pm_…`) or `TOKEN` (a single-use PSP token from the portal's tokenisation step). Raw card data is never accepted by this API — the schema has no field for it.

`expectedTotal` is the interesting field. It is **not** the amount charged; the amount charged is always re-derived server-side from `order.pricingSnapshot`. `expectedTotal` is a *guard*: if it disagrees with the server's figure, we return `422 PRICE_MISMATCH` rather than charging an amount the user did not see. This turns a silent overcharge into a loud, safe failure.

```json
// 201 Created — synchronous phase succeeded, obligations now in flight
{
  "id": "cko_01JBQ7X8K3ZP4Y6M2N9V5TWDFH",
  "orderId": "ord_01JBQ7X8K3ZP4Y6M2N9V5TWDFH",
  "status": "CAPTURED",
  "amount": { "amount": 163020, "currency": "GBP" },
  "payment": { "id": "pay_01JBQ…", "status": "CAPTURED", "brand": "visa", "last4": "4242",
               "capturedAt": "2026-08-07T10:31:01.204Z" },
  "obligations": {
    "invoice":    { "status": "PENDING" },
    "production": { "status": "PENDING" },
    "email":      { "status": "PENDING" }
  },
  "_links": {
    "self":   { "href": "/api/v1/checkout-sessions/cko_01JBQ…" },
    "events": { "href": "/api/v1/checkout-sessions/cko_01JBQ…/events" },
    "order":  { "href": "/api/v1/orders/ord_01JBQ…" }
  }
}
```

The response returns as soon as money is captured — typically under 900 ms — and reports the three post-capture obligations as `PENDING`. This is the API expressing the architecture honestly: the client is told exactly what has happened and what is guaranteed but not yet done, rather than being blocked for 10 seconds or lied to with a fake `COMPLETED`.

```json
// 402 Payment Required — declined. Order already released to READY_FOR_CHECKOUT.
{
  "type": "https://errors.example.com/payment-declined",
  "title": "Payment was declined",
  "status": 402, "code": "INSUFFICIENT_FUNDS",
  "detail": "Your card was declined due to insufficient funds. Try a different card.",
  "correlationId": "req_01JBQ…",
  "retryable": false,
  "extensions": { "checkoutSessionId": "cko_01JBQ…", "orderStatus": "READY_FOR_CHECKOUT",
                  "declineCode": "insufficient_funds", "canRetryWithNewMethod": true }
}
```

A 3-D Secure challenge is **not** an error — it is a normal outcome, especially in Europe, so it returns `201` like any other created session and reports `REQUIRES_ACTION`. Modelling it as a 4xx would push clients into treating a routine bank verification as a failure:

```json
// 201 Created — session exists, but the bank wants verification first
{
  "id": "cko_01JBQ…",
  "orderId": "ord_01JBQ…",
  "status": "REQUIRES_ACTION",
  "amount": { "amount": 163020, "currency": "GBP" },
  "sca": { "required": true, "method": "3ds2",
           "redirectUrl": "https://psp-mock/3ds/pi_mock_3Kd8…",
           "expiresAt": "2026-08-07T10:41:00.000Z" },
  "clientMessage": "Your bank needs to verify this payment.",
  "_links": { "confirm": { "href": "/api/v1/checkout-sessions/cko_01JBQ…/confirm-sca",
                           "method": "POST" } }
}
```

```http
GET  /api/v1/checkout-sessions/{id}                 → 200 status + obligations
POST /api/v1/checkout-sessions/{id}/confirm-sca     → 200 resume after 3DS
POST /api/v1/checkout-sessions/{id}/cancel          → 200 abandon; releases the order
GET  /api/v1/checkout-sessions/{id}/events?ticket=  → 200 text/event-stream (SSE)
```

The SSE endpoint takes a single-use `ticket` query parameter rather than a `Authorization` header, because the browser `EventSource` API cannot set headers. `POST /checkout-sessions/{id}/stream-ticket` mints a 60-second, single-use, session-scoped token; the stream is otherwise authenticated identically.

The stream is what makes the asynchronous design feel instant to the Art Director. Each obligation reports itself as it lands, in the order it actually lands — production is typically fastest, and the email waits for the invoice number so it can include it:

```
event: checkout.captured
data: {"sessionId":"cko_01JBQ…","paymentId":"pay_01JBQ…","at":"2026-08-07T10:31:01.204Z"}

event: obligation.production.fulfilled
data: {"jobId":"prd_88213","slaDueAt":"2026-08-08T10:31:01Z","at":"2026-08-07T10:31:09.551Z"}

event: obligation.invoice.fulfilled
data: {"invoiceId":"inv_01JBQ…","number":"INV-2026-004471","pdfUrl":"https://…","at":"2026-08-07T10:31:14.002Z"}

event: obligation.email.fulfilled
data: {"notificationId":"ntf_01JBQ…","to":"sofia@nikestudio.example","at":"2026-08-07T10:31:16.120Z"}

event: checkout.completed
data: {"sessionId":"cko_01JBQ…","orderStatus":"IN_PRODUCTION","at":"2026-08-07T10:31:16.480Z"}
```

`Last-Event-ID` is honoured on reconnect, so a dropped connection resumes rather than replaying from zero, and the UI is correct even if the user's wifi blips mid-checkout.

### 2.4 Invoices, payment methods, subscriptions

```http
GET  /api/v1/invoices?orderId=&status=&issuedFrom=&issuedTo=&limit=&cursor=
GET  /api/v1/invoices/{invoiceId}
GET  /api/v1/invoices/{invoiceId}/pdf        → 302 → SAS URL (15-min TTL)
POST /api/v1/invoices/{invoiceId}/credit-notes    [FINANCE only]

GET    /api/v1/payment-methods
POST   /api/v1/payment-methods               # { pspToken, setAsDefault, mandateAccepted }
DELETE /api/v1/payment-methods/{id}
POST   /api/v1/payment-methods/{id}/set-default

GET    /api/v1/subscriptions
POST   /api/v1/subscriptions
PATCH  /api/v1/subscriptions/{id}            # pause | resume | change plan
GET    /api/v1/subscriptions/{id}/usage
```

### 2.5 GraphQL — one scoped read query

The order-detail screen is the only place where a REST client would have to waterfall four calls, so it gets one aggregating query. Read-only, depth-limited, cost-limited, no mutations — mutations stay REST where idempotency headers and status codes already work.

```graphql
# POST /api/v1/graphql  — read-only, maxDepth 6, cost budget 1000
query OrderDetail($id: ID!) {
  order(id: $id) {
    id name reference status itemCount canCheckout
    total { amount currency }
    pricingSnapshot { lines { skuCode description quantity
                              unitPrice { amount currency }
                              lineTotal { amount currency } }
                      subtotal { amount currency } tax { amount currency }
                      total { amount currency } }
    items(first: 50) { edges { node { id filename thumbnailUrl skuCode
                                      lineTotal { amount currency } } }
                       pageInfo { hasNextPage endCursor } }
    invoice    { id number status pdfUrl issuedAt }        # invoice-service
    payment    { id status brand last4 capturedAt }        # payment-service
    production { productionJobId externalJobId status progressPercent slaDueAt }
    timeline   { at type actor summary }                   # order-service
  }
}
```

Each nested field resolves via a `DataLoader` batching per-service HTTP calls, so N orders never become N×4 requests. Resolvers that hit a slow dependency return `null` with a partial-error entry rather than failing the whole query — the invoice panel showing a spinner is much better than a blank page.

---

## 3. Internal APIs

Not exposed at the gateway. Authenticated with a short-lived service token plus a propagated user-context header so the callee can still make tenant-correct decisions.

### 3.1 order-service (gRPC on the checkout path)

```protobuf
service OrderInternal {
  // Read-only pre-flight: tenant, status, non-empty, not already paid, quote fresh.
  rpc ValidateForCheckout (ValidateForCheckoutRequest) returns (ValidateForCheckoutResponse);

  // THE concurrency control for the whole feature. Compare-and-swap on
  // {orderId, tenantId, expectedVersion}; READY_FOR_CHECKOUT → CHECKOUT_PENDING.
  // Two concurrent callers ⇒ exactly one OK, one ALREADY_RESERVED.
  rpc ReserveForCheckout (ReserveRequest) returns (ReserveResponse);

  // Compensation for ReserveForCheckout. Idempotent: releasing an already-released
  // order returns OK, because a compensation that can fail is not a compensation.
  rpc ReleaseReservation (ReleaseRequest) returns (ReleaseResponse);

  // Post-capture. CHECKOUT_PENDING → PAID_AWAITING_PRODUCTION, and writes the
  // order.paid outbox record in the SAME transaction.
  rpc ConfirmPaid (ConfirmPaidRequest) returns (ConfirmPaidResponse);
}

message ReserveRequest {
  string tenant_id = 1;
  string order_id = 2;
  uint32 expected_version = 3;   // CAS guard — omit and the call is rejected
  string checkout_session_id = 4;
  string idempotency_key = 5;
  google.protobuf.Duration hold_ttl = 6;   // default 15 min; reaper releases after
}

message ReserveResponse {
  enum Result { OK = 0; ALREADY_RESERVED = 1; VERSION_CONFLICT = 2;
                INVALID_STATE = 3; ALREADY_PAID = 4; NOT_FOUND = 5; }
  Result result = 1;
  uint32 new_version = 2;
  Money authoritative_total = 3;   // server's figure; orchestrator compares to expectedTotal
  string reserved_by_session = 4;  // populated on ALREADY_RESERVED for a useful error
}
```

`expected_version` being required rather than optional is a small API decision with a large effect: it makes the lost-update bug unrepresentable. A caller cannot accidentally write a blind update.

### 3.2 payment-service (gRPC on the checkout path)

```protobuf
service PaymentInternal {
  // Single call: authorise and capture. Split into two only for delayed-capture
  // flows, which this product does not have — one round trip instead of two on
  // the critical path.
  rpc AuthorizeAndCapture (CaptureRequest) returns (CaptureResponse);
  rpc RefundPayment       (RefundRequest)  returns (RefundResponse);   // compensation
  rpc GetPaymentIntent    (GetRequest)     returns (PaymentIntent);
}

message CaptureRequest {
  string tenant_id = 1;
  string checkout_session_id = 2;
  string order_id = 3;
  Money amount = 4;
  PaymentMethodRef payment_method = 5;
  // Derived deterministically as "<checkout_session_id>:CAPTURE_PAYMENT".
  // A retry of this call therefore reaches the PSP with the SAME key and
  // cannot produce a second charge.
  string idempotency_key = 6;
  string return_url = 7;                  // for 3DS
  map<string, string> metadata = 8;       // orderName, tenantName — shows on the statement
}

message CaptureResponse {
  enum Result { CAPTURED = 0; DECLINED = 1; REQUIRES_ACTION = 2;
                PROVIDER_ERROR = 3; ALREADY_CAPTURED = 4; }
  Result result = 1;
  string payment_id = 2;
  Money amount_captured = 3;
  ScaChallenge sca = 4;
  DeclineDetail decline = 5;   // code, network code, client-safe message, retryable
}
```

`ALREADY_CAPTURED` is a success, not an error. A retry after an ambiguous timeout must be able to discover "this already worked" and continue the saga rather than failing a checkout the customer has already paid for.

### 3.3 production-gateway-service and the Production mock

Our anti-corruption layer speaks our vocabulary inward and theirs outward. The mock deliberately reproduces the awkward parts of a real internal system — a differently-shaped payload, its own status vocabulary, and injectable failure:

```http
POST http://production-mock:4003/v1/jobs
X-Api-Key: <key>
Idempotency-Key: ord_01JBQ…            # our order id, so their dedupe matches ours
X-Mock-Behavior: fail-transient        # test hook: ok | fail-transient |
                                       # fail-permanent | slow | reject-invalid-asset
```

```json
{
  "externalRef": "ord_01JBQ7X8K3ZP4Y6M2N9V5TWDFH",
  "clientCode": "NIKE-EMEA",
  "priority": "RUSH",
  "slaHours": 24,
  "serviceProfile": "ghost-mannequin-v2",
  "assets": [ { "ref": "oit_01JBQ…", "uri": "s3://platform-assets/…", "sha256": "e3b0…",
                "instructions": "Remove mannequin, keep collar shape" } ],
  "callbackUrl": "https://api.example.com/internal/production/callbacks"
}
```

```json
// 201 accepted
{ "jobId": "prd_88213", "status": "queued", "estimatedCompletionAt": "2026-08-08T06:00:00Z" }

// 422 permanent rejection → do NOT retry; triggers the refund saga
{ "error": "unsupported_asset_format", "message": "asset oit_01JBQ… is CMYK TIFF, unsupported",
  "permanent": true, "rejectedAssets": ["oit_01JBQ…"] }

// 503 transient → retry with backoff; circuit breaker counts this
{ "error": "capacity_exceeded", "message": "render farm saturated", "retryAfterSeconds": 120 }
```

The ACL maps their vocabulary to ours and, crucially, classifies every error as `TRANSIENT` or `PERMANENT`. That one classification decides between "retry for ~75 minutes and then page a human" and "refund the customer now", so it is explicit code with unit tests, not a retry library's default behaviour:

```ts
// infrastructure/http/production-error-mapper.ts
const PERMANENT = new Set([
  'unsupported_asset_format', 'invalid_service_profile',
  'asset_not_found', 'client_not_provisioned', 'manifest_schema_invalid',
]);
export function classify(status: number, body: unknown): 'TRANSIENT' | 'PERMANENT' {
  if (status === 422 || status === 400) return 'PERMANENT';
  if (status === 409) return 'TRANSIENT';          // their dedupe race — safe to retry
  if (isErrorBody(body) && PERMANENT.has(body.error)) return 'PERMANENT';
  return 'TRANSIENT';                              // 5xx, timeouts, socket errors
}
// Default is TRANSIENT: retrying a permanent failure wastes a queue slot,
// but refunding a transient one loses a customer's deadline. Fail toward retry.
```

Their status callback is verified by HMAC and, like everything else, is idempotent:

```http
POST /internal/production/callbacks
X-Production-Signature: sha256=…
{ "jobId": "prd_88213", "status": "processing", "progress": 34,
  "assetsCompleted": 136, "occurredAt": "2026-08-07T11:04:00Z" }
```

An out-of-order callback (progress 0.20 arriving after 0.34) is discarded by comparing `occurredAt` against the stored value, because at-least-once delivery over an unordered transport guarantees this will happen.

### 3.4 Mock PSP and mock email

The PSP mock is Stripe-shaped so the real adapter is a drop-in swap, and it is **deterministic by card number** so tests never rely on randomness:

| Test PAN | Behaviour |
|---|---|
| `4242 4242 4242 4242` | Success |
| `4000 0000 0000 0002` | `card_declined` |
| `4000 0000 0000 9995` | `insufficient_funds` |
| `4000 0000 0000 3220` | `requires_action` → 3DS challenge |
| `4000 0000 0000 0119` | `processing_error` (transient; retry succeeds) |
| `4000 0000 0000 0259` | Succeeds, then fires a `charge.dispute.created` webhook |
| `4000 0000 0000 0077` | **Captures, then times out** — the ambiguous case idempotency exists for |

That last card is the most valuable one in the table: it is how we test that a client retry after a timeout does not double-charge.

The email mock exposes a browsable outbox at `GET http://localhost:4002/outbox` plus `/outbox/{id}/html` for rendered previews, and can inject bounces and delays, so email assertions in tests are real HTTP assertions rather than spies on a mock function.

---

## 4. Rate limits, health, and operations

Rate limits are per tenant and per user, sliding-window in Redis, with `X-RateLimit-*` and `Retry-After` headers. Checkout gets the tightest limit — 20 per minute per tenant — because it is the most expensive and most abuse-sensitive endpoint; search gets 300 per minute per user because typeahead is chatty by design; asset upload-URL minting gets 600 per minute per tenant.

Health follows the liveness/readiness distinction properly: `/health/live` is a process check that never touches a dependency (a liveness probe that fails when Mongo blips will restart every replica in the fleet during a database hiccup and turn a partial outage into a total one), while `/health/ready` checks Mongo, RabbitMQ, and Redis and removes only that replica from the ingress. `/health/startup` covers slow first-boot work such as index creation. `/metrics` exposes Prometheus format on a separate port that is never publicly routable — the same port that serves `/docs` and `/openapi.json` (see [§6.2](#62-serving-it)).

Ops endpoints, `PLATFORM_OPS`-gated and fully audited, exist because the failure modes this architecture accepts require human tooling rather than database surgery: replaying a dead-lettered message, retrying a stuck production push, resuming or force-compensating a saga, and rebuilding the search projection for a tenant.

```http
GET  /api/v1/ops/sagas?state=RUNNING&stuckLongerThan=PT5M
POST /api/v1/ops/sagas/{id}/resume
POST /api/v1/ops/sagas/{id}/force-compensate         # requires a reason; audited
GET  /api/v1/ops/dlq?queue=production.push
POST /api/v1/ops/dlq/replay                          # { queue, messageIds[] | all }
POST /api/v1/ops/production-jobs/{id}/retry
POST /api/v1/ops/projections/order-search/rebuild    # { tenantId } — resumable, batched
```

---

## 5. Contract-first workflow

The zod schemas in `packages/contracts` are the single source of truth. OpenAPI 3.1 documents and TypeScript types are *generated* from them, and the same schema instance validates requests at runtime — so a published spec cannot drift from the code that implements it, which is the failure mode of hand-written OpenAPI files.

```ts
// packages/contracts/src/checkout/create-session.ts
export const CreateCheckoutSessionRequest = z.object({
  orderId: OrderId,
  paymentMethod: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('SAVED'), ref: PaymentMethodRef }),
    z.object({ kind: z.literal('TOKEN'), pspToken: z.string().min(10) }),
  ]),
  expectedTotal: Money,                 // guard, not the charged amount
  billingContactEmail: z.string().email().optional(),
  purchaseOrderRef: z.string().max(64).optional(),
  returnUrl: z.string().url(),
}).strict();                            // .strict() ⇒ unknown fields are a 400,
                                        // so a typo'd field never silently no-ops
export type CreateCheckoutSessionRequest = z.infer<typeof CreateCheckoutSessionRequest>;
```

CI enforces three gates on every pull request: a **breaking-change check** (`oasdiff`) that fails the build on an incompatible API change unless the PR carries an explicit `api-breaking` label plus a migration note; **consumer-driven contract tests** (Pact) where the portal and the orchestrator publish expectations that each provider must verify, so a provider cannot merge a change that breaks a real consumer even though its own tests pass; and **spec–implementation conformance**, replaying the OpenAPI examples against the running service in the integration suite. Details in [TESTING](TESTING.md).

---

## 6. Swagger — generated specs and interactive documentation

### 6.1 The generation chain

The spec is **generated from the zod schemas at build time**, not written by hand and not assembled at runtime.

Hand-written OpenAPI is the common approach and it rots within a sprint: the schema changes, the YAML does not, and the published contract quietly starts describing an API that no longer exists. Generating it removes that failure mode by construction — the object that validates the request is the object that produced the documentation, so they cannot disagree.

Generating at **build time** rather than on boot matters too. The spec is emitted into the image during `docker build` and served as a static file, which means a running container cannot serve documentation that differs from its own code, the spec is available as a pipeline artefact before anything is deployed, and the `oasdiff` gate has a concrete file to compare.

```ts
// packages/contracts/src/openapi/registry.ts
import { OpenApiGeneratorV31, OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// Register shared components ONCE so every operation $refs them rather than
// inlining a copy. Without this, a 40-endpoint spec repeats the Problem schema
// forty times and generated clients end up with forty near-identical types.
registry.register('Money', Money.openapi({
  description: 'Integer minor units plus ISO-4217 currency. NEVER a decimal.',
  example: { amount: 163020, currency: 'GBP' },   // £1,630.20
}));
registry.register('Problem', ProblemDetails.openapi({ description: 'RFC 9457 error' }));

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
  description: 'Short-lived RS256 access token. `tenantId` is read from the `tid` claim — never from the request.',
});

registry.registerPath({
  method: 'post',
  path: '/checkout-sessions',
  tags: ['Checkout'],
  summary: 'Check out an order and capture payment',
  description: [
    'Returns as soon as funds are captured. The invoice, the Production push and the',
    'confirmation email are durable obligations reported as `PENDING` and completed',
    'asynchronously — subscribe to `/checkout-sessions/{id}/events` to watch them land.',
    '',
    'A 3-D Secure challenge is **not** an error: it returns `201` with',
    '`status: REQUIRES_ACTION`. See the deterministic test cards in §3.4.',
  ].join('\n'),
  security: [{ bearerAuth: [] }],
  request: {
    // ⭐ Headers must be registered explicitly. Generating only from the body
    // schema is the classic mistake: Idempotency-Key is REQUIRED on every
    // mutation, and a spec that omits it produces clients that get a 400 on
    // their first call and no clue why.
    headers: z.object({
      'Idempotency-Key': z.string().openapi({
        description: 'Required. One key per attempt, reused across retries. See DATA-INTEGRITY §5.',
        example: 'ik_01JBQ7X8K3ZP4Y6M2N9V5TWDFH',
      }),
    }),
    body: { content: { 'application/json': { schema: CreateCheckoutSessionRequest } } },
  },
  responses: {
    201: { description: 'Captured, or awaiting SCA',
           content: { 'application/json': { schema: CheckoutSessionResponse } } },
    402: { description: 'Declined',  content: { 'application/json': { schema: ProblemDetails } } },
    409: { description: 'Order already reserved or already paid',
           content: { 'application/json': { schema: ProblemDetails } } },
    422: { description: 'Price mismatch, expired quote, or idempotency key reused with a different body',
           content: { 'application/json': { schema: ProblemDetails } } },
    504: { description: 'Ambiguous — retry with the SAME Idempotency-Key',
           content: { 'application/json': { schema: ProblemDetails } } },
  },
});
```

### 6.2 Serving it

Each service exposes its own spec and a Swagger UI mounted on a **separate internal port** — the same port the Prometheus `/metrics` endpoint uses, which is never publicly routable. That keeps documentation off the public surface by default rather than by remembering to disable it.

```ts
// packages/kernel/src/http/swagger.ts — one implementation, all ten services
export function mountSwagger(app: Express, opts: { service: string; env: Env }) {
  // Emitted at build time by `pnpm openapi:bundle`, baked into the image.
  const spec = JSON.parse(readFileSync('./openapi.generated.json', 'utf8'));

  app.get('/openapi.json', (_req, res) => res.json(spec));

  // The interactive console is the part that needs judgement, not the spec.
  if (opts.env !== 'production') {
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, {
      swaggerOptions: {
        persistAuthorization: true,
        // In dev, pre-fill a real seeded token so "Try it out" works on the
        // first click. A docs page whose every request 401s gets abandoned.
        ...(opts.env === 'development' && { authAction: devBearerToken() }),
        tryItOutEnabled: true,
        displayRequestDuration: true,
        defaultModelsExpandDepth: 3,
      },
      customSiteTitle: `${opts.service} API`,
    }));
  }
}
```

The gateway additionally serves a **single aggregated spec** at `GET /api/v1/openapi.json`, with Swagger UI at `/api/v1/docs`. Client developers care about the public API, not about which of ten services happens to own an endpoint, so the ten per-service specs are merged at build time into one document tagged by domain — Orders, Checkout, Invoices, Payment Methods, Assets. The merge fails the build on a path collision or on two services defining the same component name differently, which is a cheap way to catch a contract drifting apart across teams.

### 6.3 Where it is exposed, and where it is not

| Environment | Per-service `/docs` | Gateway `/api/v1/docs` | Spec `openapi.json` | Try it out |
|---|---|---|---|---|
| Local | Open, on the metrics port | Open | Open | Yes, pre-authed with a seeded token |
| `dev` | Internal ingress only | Internal ingress only | Internal | Yes |
| `staging` | Internal ingress only | Behind SSO, `staging.` host | Internal | Yes — against staging data |
| `prod` | **Off** | **Off** | Served, but auth-gated | **No** |
| Partner-facing | — | Azure API Management developer portal | Public | Sandbox only |

The production row is a deliberate call worth defending. The **spec** being available is good — partners and internal consumers need it, and hiding an API's shape is not a security control. The **interactive console pointed at production** is a different thing: a "Try it out" button next to `POST /checkout-sessions` on a live payments API is a footgun that will eventually charge a real customer's card during a demo. So production serves the document and not the console, and anyone who wants to experiment does it against staging or the APIM sandbox.

The production spec is auth-gated rather than fully public for one narrow reason: it enumerates every endpoint, parameter and error code, which is a genuine reconnaissance aid, and gating it behind a token costs a partner nothing. This is defence in depth, not a claim that the spec is secret.

### 6.4 Azure API Management as the partner surface

Because the platform now runs on Azure ([DEPLOYMENT](DEPLOYMENT.md)), the public documentation surface is **Azure API Management's developer portal** rather than a self-hosted Swagger UI. The pipeline imports the aggregated spec on every production release:

```yaml
# .azuredevops/templates/publish-openapi.yml
- task: AzureCLI@2
  displayName: Publish OpenAPI to API Management
  inputs:
    azureSubscription: azure-prod-wif
    inlineScript: |
      az apim api import \
        --resource-group rg-platform-prod --service-name apim-platform \
        --api-id checkout-platform --path api/v1 \
        --specification-format OpenApiJson \
        --specification-path artifacts/openapi.aggregated.json \
        --api-revision $(Build.BuildNumber) --api-revision-description "$(Build.SourceVersion)"
      # A revision, not an in-place overwrite: the previous revision stays
      # published until the new one is promoted, so a bad spec import does not
      # break every partner's generated client at once.
```

APIM brings three things a self-hosted console does not: a subscription-key model so partner usage is attributable and revocable, per-product rate limits independent of our own gateway limits, and a versioned portal where a partner can see what changed between revisions. It sits in front of Front Door for the partner path only; the portal's own traffic never reaches our services.

### 6.5 What makes a generated spec actually usable

A spec that merely exists is not documentation. Five details do most of the work here, and each closes a specific way integrators get it wrong.

**Money carries an example.** `{ "amount": 163020, "currency": "GBP" }` with a description saying *integer minor units, never a decimal* appears on every monetary field. Without it, the first thing a new integrator sends is `19.99`, and the resulting bug is a 100× charge.

**`Idempotency-Key` is documented as required**, with an example and a link to why. It is a header rather than a body field, so it only appears in the spec because §6.1 registers it explicitly — and an integrator who does not know it is mandatory gets a `400` on their very first call.

**One `Problem` schema, referenced everywhere.** The RFC 9457 model in [§1.2](#12-error-model-rfc-9457-problem-details) is machine-readable rather than prose, so generated clients get a typed error and the full `code` enum instead of `any`.

**The deterministic PSP test cards are in the spec description**, not only in this document. A partner integrating against staging can self-serve the decline, the 3-DS challenge, and — most valuably — the capture-then-timeout card that proves their retry logic does not double-charge ([§3.4](#34-mock-psp-and-mock-email)).

**`servers` is populated per environment** from the same config the service boots with, so the console's base URL is correct by construction rather than by a copy-pasted YAML block that eventually points at the wrong host.

Two things deliberately stay out of Swagger. The **gRPC internal contracts** ([§3](#3-internal-apis)) are documented by their `.proto` files, which are the better artefact — protobuf is already a schema language and `buf` already does breaking-change detection. And the **events** are documented in AsyncAPI 3 ([EVENTS §8](EVENTS.md#8-asyncapi-as-the-published-contract)), because OpenAPI has no vocabulary for a topic exchange, a routing key, or a dead-letter queue. Forcing either into Swagger would produce something that looks like documentation and misleads. Both are published alongside the OpenAPI bundle so a consumer team has one place to look.
