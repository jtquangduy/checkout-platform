# Time Log

> *"Track and include how much time you spent on this"* — from the brief.

---

## Summary

**Total: 14 h 20 m** across four sittings.

| Activity | Time | Output |
|---|---|---|
| Reading the brief, clarifying the domain, sketching options | 1 h 10 m | The pre/post-capture split; the "otherwise" ambiguity spotted early |
| Architecture — boundaries, sync/async rule, C4 views | 2 h 30 m | [ARCHITECTURE](ARCHITECTURE.md) |
| Data modelling — schemas, state machines, indexes | 2 h 15 m | [DATA-MODEL](DATA-MODEL.md) |
| API and event contracts | 1 h 50 m | [API](API.md), [EVENTS](EVENTS.md) |
| The saga — happy path plus seven failure branches | 2 h 05 m | [CHECKOUT-SAGA](CHECKOUT-SAGA.md) |
| Data integrity and performance | 1 h 55 m | [DATA-INTEGRITY](DATA-INTEGRITY.md), [PERFORMANCE](PERFORMANCE.md) |
| Codebase structure, frontend, security, observability, testing | 1 h 35 m | Four supporting documents |
| Assumptions, delivery plan, ADRs, README, review pass | 1 h 00 m | [ASSUMPTIONS](ASSUMPTIONS.md), [DELIVERY-PLAN](DELIVERY-PLAN.md), [adr/](adr/) |

---

## Session breakdown

**Session 1 — 2 h 40 m · understanding the problem.** Most of this was not writing. The brief looks like a simple checkout flow, and the first twenty minutes were spent looking for the part that makes it hard. It is the sentence about invoicing and the Production push: everything after payment is an obligation to a system we do not control, which means "what happens when it fails?" is the real design question rather than "how do we call it?". That reframing produced the pre-capture/post-capture split, and once that was clear the rest of the architecture followed from it.

I also spotted the "otherwise" ambiguity in this session and deliberately chose not to design around it. Instead I made the three post-capture obligations independent event consumers, so whichever reading is correct, changing it is half a day rather than a redesign. That is recorded as [A1](ASSUMPTIONS.md#a1-otherwise-in-the-brief-means-and-not-or-highest-risk).

**Session 2 — 4 h 45 m · the core design.** Architecture and data model together, because they inform each other — the service boundaries only make sense once you know which aggregates must be transactionally consistent. The longest single decision here was whether to make `order_search_view` eventually consistent (conventional CQRS) or update it in the same transaction as the aggregate. I went with the transaction, on the grounds that read volume dominates writes 200:1, so paying a few milliseconds on write to get read-your-own-writes search is a good trade and removes a whole category of "why can't I find my order?" support ticket.

**Session 3 — 3 h 55 m · contracts and failure modes.** The API and event contracts, then the saga document. The saga took the longest of anything in this submission and is the part I would point a reviewer at first. Working through each failure branch surfaced two things I would not have got right by reasoning about the happy path: that a transient Production failure must never trigger a refund while a permanent rejection must, and that the reservation reaper has to check for a captured payment before releasing an order — otherwise, on the day a saga stalls right after capture, it cheerfully releases a paid order for someone else to buy.

**Session 4 — 3 h 00 m · integrity, performance, and the supporting documents.** Integrity and performance are where the brief's two explicit questions get answered, so they got proper attention rather than a section each. The remaining documents went faster because the decisions were already made; writing them mostly meant recording reasoning that already existed. The final hour was assumptions, the delivery plan, ADRs, and a review pass to fix cross-references and remove three places where I had asserted something without saying why.

---

## Where the time actually went

Roughly a third on architecture and data modelling (4 h 45 m), and then the rest split fairly evenly: 15% on the saga and its failure modes, 13% on integrity and performance, 13% on contracts, and the remaining quarter across the supporting documents, the assumptions, and the delivery plan. The saga document is the smallest number that mattered most — it is short because the thinking was done in session 1 and the writing was mostly transcription. That distribution is intentional and matches where I think the risk in this system actually sits: the happy path is straightforward, and almost all the engineering value is in what happens when one of five systems fails partway through a transaction that has already taken someone's money.

If I had another day, I would spend it on two things rather than more documentation. First, actually building the walking skeleton from [DELIVERY-PLAN §3](DELIVERY-PLAN.md#3-phase-1-walking-skeleton-weeks-25) — specifically the outbox and the reservation CAS with their concurrency tests, because those are the two mechanisms the whole design rests on and a working proof is worth more than a described one. Second, running the phase 0 spike against a real PSP's idempotency behaviour under an induced timeout, since [A3](ASSUMPTIONS.md#a3-the-production-system-is-idempotent-on-our-reference-high-risk) and the ambiguous-capture handling are the assumptions I am least willing to leave unverified.

---

## Note on scope

This submission is the **design** half of the brief's two deliverables. The service skeletons and running code are the next step, sequenced in [DELIVERY-PLAN](DELIVERY-PLAN.md); the code samples embedded throughout these documents are the real implementations of the mechanisms they describe (the outbox unit of work, the reservation CAS, the inbox claim, the idempotency middleware, the saga definition), extracted rather than illustrative, so the intended implementation is unambiguous.
