# Assumptions & How I'd Validate Them

> *"Any assumptions you've made, and how you might validate them."* — from the brief.

Each assumption below states what I assumed, why, what breaks if I am wrong, how much rework that costs, and the cheapest way to find out. They are ordered by **risk**, which is impact × likelihood-of-being-wrong × cost-to-reverse — not by how confident I feel.

The three at the top are the ones I would want answered in the first conversation, before writing code.

---

## A1 · "Otherwise" in the brief means *and*, not *or* — 🔴 highest risk

**The sentence.** *"We also have to create an invoice to our invoice system, otherwise, we need to call our internal Production system (Production service) to push this order to be processed."*

Read literally, "otherwise" makes the Production push the *fallback* for invoicing: invoice, or else push to Production. That would mean a successfully invoiced order never reaches the retouching pipeline — the customer pays, gets a document, and no work happens. For a business whose promise is beating deadlines, that cannot be right.

**What I assumed.** Both happen, unconditionally, on every successful checkout. They are independent obligations, not alternatives. The functional requirements list immediately below the scenario supports this: it names the Production push and the email as required outcomes of a successful checkout, with no conditional between them. "Otherwise" reads as a slip for "also" or "and then".

**Why it is the top risk.** It is the only ambiguity in the brief that changes the *shape* of the system rather than a detail of it, and both plausible readings are internally coherent.

**If I am wrong.** The fan-out becomes a conditional branch: the orchestrator waits for the invoice outcome and only pushes to Production if invoicing failed. That is a materially worse design — it puts the accounting system on the critical path to fulfilment, and it means an invoicing outage is the only way work gets done.

**Cost to change.** Small, and deliberately so. The three obligations are independent consumers of one event, so changing this is: remove the production-gateway binding to `checkout.completed.v1`, bind it instead to a new `invoice.failed.v1`, and adjust one consumer's routing key. Roughly half a day, no schema change, no data migration. **This is the main reason the post-capture phase is choreographed rather than orchestrated** — it makes the most uncertain requirement in the brief the cheapest one to get wrong.

**How I'd validate it.** One question to the product owner: *"On a successful checkout, should the order always be pushed to Production, or only when invoicing fails?"* Sixty seconds to ask, and it resolves the largest open question in the design. Failing that, I would look at whether the existing Production system has any orders that were never invoiced — if it does, they are independent in practice.

---

## A2 · A "successful checkout" means captured funds, not just authorised — 🔴 high risk

**What I assumed.** Payment is authorised *and* captured in one step, and capture is the commit point. "Payment is successful" means the money has actually moved.

**Why.** The brief says *"if the payment is successful, then the order should be pushed"* and *"client has to receive the email if the payment is successful"* — both read as a completed payment. Retouching begins immediately, so there is no fulfilment gap to justify delayed capture, and capturing at checkout removes an entire class of "authorisation expired before we captured" failures.

**If I am wrong** — if the business authorises at checkout and captures on delivery, which some agencies do — then the saga gains a step, `PaymentIntent` gains an `AUTHORIZED` state that already exists in the model, and a scheduled capture job is needed with authorisation-expiry handling (typically 7 days). The email would fire on authorisation while revenue recognition waits for capture.

**Cost to change.** Moderate: one new saga step, a capture job, and an expiry reaper. Two to three days. The `PaymentIntent` model already distinguishes `AUTHORIZED` from `CAPTURED`, so no schema change.

**How I'd validate it.** Ask finance how revenue is currently recognised, and check the existing PSP account settings for whether `capture_method` is `automatic` or `manual` — the answer is already in the Stripe dashboard.

---

## A3 · The Production system is idempotent on our reference — 🔴 high risk

**What I assumed.** `POST /v1/jobs` with an `Idempotency-Key` of our `orderId` will not create a second job if we retry after an ambiguous timeout.

**Why.** Without it, the at-least-once retry ladder could double-book a job, and the render farm would do the work twice at real cost. I have modelled the mock to honour it.

**If I am wrong**, the anti-corruption layer needs a check-then-push sequence — `GET /v1/jobs?externalRef=<orderId>` before every retry — plus tolerance for the race between two concurrent pushes. Not hard, but it doubles the calls on the retry path and introduces a window that needs its own handling.

**Cost to change.** Small: contained entirely within production-gateway-service, one day. This containment is the entire point of the anti-corruption layer — a wrong assumption about an external system's semantics changes one adapter, not the architecture.

**How I'd validate it.** Read their API documentation, then test it directly: send the same manifest twice against their staging environment and count the jobs. That is a ten-minute experiment and it removes the guess entirely. I would do this before writing the retry logic, not after.

---

## A4 · "Invoice system" means a service we own plus an external ledger — 🟠 medium

**What I assumed.** Invoicing splits in two: an `invoice-service` we own (the invoice aggregate, gapless numbering, PDF, the customer-facing record) and an external accounting system of record (Xero/NetSuite-shaped) that we sync to asynchronously.

**Why.** The business needs immediate, customer-visible invoices with our own numbering and branding, and finance needs the data in whatever ledger they already run. Coupling those means an accounting-API outage blocks customer invoices, which is the wrong dependency direction. Splitting them lets the invoice be valid and visible while the sync retries.

**If I am wrong** and there is only an external system with no local record, invoice-service becomes a thinner adapter, we lose control of numbering (their sequence), and customer-facing invoice display depends on their API availability — which I would push back on.

**Cost to change.** Moderate: invoice-service's responsibilities shrink, but the event contracts stay. Two to three days.

**How I'd validate it.** Ask which accounting system finance uses today and whether invoice numbers must match their sequence. Look at how existing invoices are numbered — if they already follow a `INV-YYYY-NNNNNN` pattern, local numbering is established practice.

---

## A5 · Prices are fixed at quote time and immutable through checkout — 🟠 medium

**What I assumed.** `order.pricingSnapshot` is taken when the order becomes `READY_FOR_CHECKOUT` and is the authoritative amount for the charge, the invoice, and the customer's screen. A rate-card change never affects an order already quoted.

**Why.** Charging an amount different from the one displayed is the fastest way to lose a client's trust, and per-tenant contract rates mean prices genuinely do change. The immutable snapshot makes price drift between review and charge structurally impossible rather than merely unlikely.

**If I am wrong** — if pricing must be live at checkout, perhaps because of surge pricing on rush capacity — the flow needs a re-quote-and-reconfirm step, and the UI needs a "price changed, please confirm" interstitial. The `422 PRICE_MISMATCH` path already exists for exactly this.

**Cost to change.** Small: the guard is already there; it becomes a re-quote rather than a hard failure. One day.

**How I'd validate it.** Ask commercial whether quotes have a validity period (I assumed 7 days) and whether rush surcharges vary with capacity. Check whether existing client contracts state fixed rates.

---

## A6 · A transient Production failure must never trigger a refund — 🟠 medium

**What I assumed.** If the Production system is down, we keep the money, retry for up to ~75 minutes, then escalate to a human. Only a *permanent* rejection (structurally unprocessable job) triggers an automatic refund.

**Why.** The customer bought retouching, not a promise attempt. Refunding because the render farm was briefly busy would be commercially wrong, would surprise the customer, and would cancel work they urgently need. Conversely, a permanently unprocessable job will never succeed, so holding the money would be indefensible.

**If I am wrong** — if the business prefers to auto-refund after a shorter window — that is a configuration change to the retry budget plus a policy change to what triggers `REFUNDING`.

**Cost to change.** Small: the transient/permanent classification is already explicit and unit-tested in one file. Half a day.

**How I'd validate it.** This is a commercial decision, not a technical one, so I would ask the product owner directly and get the answer written down. I would also ask what the current manual practice is when a job fails today, since that reveals the real policy.

---

## A7 · Order names are unique per tenant — 🟠 medium

**What I assumed.** Unique per tenant (case- and diacritic-insensitive), enforced by a unique index.

**Why.** The brief says *"The Art Director could find the order by order name"* — singular. Searching by name is only genuinely useful if a name identifies one order, and duplicate names in a studio with thousands of batches would make the primary workflow ambiguous.

**If I am wrong**, the unique index is dropped, search returns multiple matches, and the UI needs a disambiguator (reference, creation date, creator) in the result row — which the design already displays.

**Cost to change.** Very small: drop an index, adjust one empty-state message. Two hours. The risk is the reverse direction: **adding** uniqueness later requires cleaning up existing duplicates, which is why I assumed the stricter constraint. It is much cheaper to relax a constraint than to introduce one.

**How I'd validate it.** Query the existing production database for duplicate names per tenant. If duplicates exist today, the assumption is already false and I would find out in one query.

---

## A8 · Scale is ~200 tenants and ~50k orders/month, growing 5× in a year — 🟡 lower

**What I assumed.** The load model in [PERFORMANCE §1](PERFORMANCE.md#1-load-model-sizing-for-reality-not-for-a-resume): 50k orders/month today, 250k in twelve months, peak 20 → 90 checkouts/minute, 60 → 300 search RPS.

**Why.** It is consistent with a studio-focused B2B product where each tenant places tens to hundreds of orders monthly, and it is deliberately modest — designing for a hundred times this would mean sharding, Kafka, and CQRS with eventual consistency everywhere, all of which cost real complexity that 20 engineers would pay for daily.

**If I am wrong on the low side** (10× more), the escalation path is already decided: read from secondaries, shard on `tenantId`, and swap RabbitMQ for Kafka if a replayable log becomes necessary. Because `tenantId` already leads every index and every query, sharding is an operational change rather than a code change.

**Cost to change.** Moderate but pre-planned. Sharding is roughly a week of operational work with no application changes; a Kafka migration is two to three weeks.

**How I'd validate it.** Pull actual order and search volumes from the existing system, and ask sales for the tenant pipeline. Then load-test at 3× the projection rather than at the projection, since the interesting question is where it breaks, not whether it holds.

---

## A9 · Per-tenant single currency; no cross-currency conversion — 🟡 lower

**What I assumed.** A tenant's price book, orders, payments, and invoices all share one currency. The business may support several currencies across its tenant base, but never converts within a transaction.

**Why.** It keeps money handling simple and correct: no FX rates to capture, no rounding across conversion, no reconciliation of gains and losses. Multi-currency *per tenant* is a genuinely hard problem and the brief gives no reason to think it is needed.

**If I am wrong**, the `Money` type already carries a currency, so the model is ready; what is missing is a captured FX rate on the invoice, conversion at a defined point, and a policy for FX gain/loss.

**Cost to change.** Moderate: three to four days, mostly in pricing and invoicing.

**How I'd validate it.** Ask whether any existing client is billed in a currency other than their contract currency. Check whether the PSP account is configured for multi-currency settlement.

---

## A10 · The Production system pushes status callbacks; we do not poll — 🟡 lower

**What I assumed.** After accepting a job, the Production system calls us back with progress and completion, HMAC-signed.

**Why.** Polling thousands of jobs is wasteful, slow to reflect reality, and scales badly. Callbacks are the right shape.

**If I am wrong** and it is poll-only, production-gateway gains a scheduled reconciliation job — which it needs anyway as a safety net for lost callbacks, so the work is not wasted, just promoted from backup to primary.

**Cost to change.** Small: one job in one service, one day, contained by the anti-corruption layer.

**How I'd validate it.** Read their API docs; ask their team whether callbacks exist and whether they retry failed deliveries.

---

## A11 · Roles are Art Director, Producer, Finance, Tenant Admin — 🟡 lower

**What I assumed.** Four tenant-side roles plus two internal (`PLATFORM_OPS`, `PLATFORM_ADMIN`), with permission-based checks rather than role-based ones, and an optional second-approver rule above a configurable threshold.

**Why.** The brief names the Art Director as the checkout actor. Studios of this size typically separate creative, production, and finance responsibilities, and a spend threshold requiring a second approver is a common B2B expectation.

**If I am wrong**, roles are data, not code — permissions are checked, not roles, so adding or renaming a role is a configuration change.

**Cost to change.** Very small. Hours.

**How I'd validate it.** Interview two or three existing clients about who places orders and who approves spend. Check whether any client has asked for approval workflows.

---

## A12 · Image bytes never flow through the application tier — 🟡 lower

**What I assumed.** Uploads go browser → Blob Storage via SAS PUT; the Production system fetches assets from Blob Storage directly; our services handle only metadata.

**Why.** A 400-image order is tens of gigabytes. Proxying that through Node would make image volume an application-scaling problem, which is the wrong place to solve it.

**If I am wrong** — if Production cannot read our Blob Storage, or compliance requires bytes to pass through a controlled gateway — a streaming transfer service is needed, sized on bandwidth rather than requests.

**Cost to change.** Larger: a new service and a genuine bandwidth cost model. One to two weeks.

**How I'd validate it.** Ask whether the Production system can be granted cross-tenant Blob read access via a SAS or a managed identity, or whether it already ingests from object storage today.

---

## A13 · Assumptions with low enough risk that I would simply proceed

Recorded for completeness rather than because they need answers first: orders are batches of 50–500 images with a hard cap at 500 (larger batches are split, which keeps documents bounded); SLA turnaround is a per-order property with 24 h and 48 h tiers; the portal is desktop-first because studio work happens on calibrated monitors (responsive, but not mobile-optimised); English UI initially with i18n scaffolding in place and locale already on the user record; the PSP is Stripe-shaped, which the mock's API mirrors so the real adapter is a drop-in swap; and one Production system rather than several regional pipelines, though the anti-corruption layer would absorb multiple endpoints behind one interface if needed.

---

## What this list is really for

Two things.

First, **the design is arranged so that the assumptions most likely to be wrong are the cheapest to change.** A1 is the biggest open question in the brief, and it costs half a day because the post-capture obligations are independent event consumers rather than orchestrated steps. A3 and A10 are guesses about a system I cannot see, and both are contained inside one anti-corruption layer. A7 is a constraint I deliberately made *stricter* than necessary, because relaxing a unique index is trivial while introducing one later means data cleanup. That distribution is not luck — it is what the boundaries in [ARCHITECTURE §3.1](ARCHITECTURE.md#31-why-these-service-boundaries) were chosen to buy.

Second, **most of these are answered by a fifteen-minute conversation or a single query, not by more design.** A1, A2, A6, and A11 are questions for a product owner. A3 and A10 are ten-minute experiments against a staging API. A7 and A8 are queries against the existing database. I would rather spend that hour than build on six guesses, and [DELIVERY-PLAN §2](DELIVERY-PLAN.md#2-phase-0-validate-before-building-week-1) puts exactly that hour in week one.
