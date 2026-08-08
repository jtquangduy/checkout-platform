# ADR-0007 — Dedicated search read model, updated transactionally

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** Orders, Web

## Context

"Orders could be searched/filtered by name" is one line in the brief and the highest-volume operation in the product — roughly 200 reads for every write, and every keystroke in a typeahead is a request.

Querying the `orders` collection directly does not work at scale. Order documents embed up to 500 items and run 40–420 KB, so any scan reads gigabytes to return 25 rows of display data. A case-insensitive `$regex` without a leading anchor cannot use an index at all. And `skip(page * n)` makes page 40 cost 40× page 1 while returning duplicates when new orders arrive mid-pagination.

So a separate read model is needed. The interesting question is not *whether* to project, but **when the projection is updated** — the conventional CQRS answer is asynchronously, from events.

## Decision

**A dedicated `order_search_view` collection** holding only the ~1 KB the results list renders: name, normalised name, pre-split name tokens, reference, tags, status, item count, total, thumbnail key, creator, dates.

**Updated in the same MongoDB transaction as the `orders` aggregate**, not asynchronously from an event.

Plus three query-shape decisions: names are normalised (lowercase, diacritics stripped, punctuation collapsed) and pre-tokenised by the domain layer so matching cannot drift from storage; complete tokens match by indexed equality on the multikey array while only the final token uses an *anchored* `^prefix` regex, which is index-eligible; and pagination is keyset on `(createdAt, _id)` rather than offset.

The projection is rebuildable via a resumable, batched, tenant-scoped job, and carries a `projectionVersion` so stale rows are detectable.

## Consequences

**Positive.** Measured p50 12 ms / p95 47 ms on a 50k-order tenant, examining ~1.02 documents per document returned — against 1.4 s and 50,000 examined for the naive query. Because the view is small, a tenant's entire working set stays memory-resident. And the transactional update makes search **read-your-own-writes consistent**: an Art Director who renames an order finds it immediately, which removes an entire category of "why can't I find my order?" support ticket.

**Negative.** Writes cost ~3 ms more. With a 200:1 read:write ratio that is an easy trade, and it is the trade this ADR exists to make explicit. There is duplicated data to keep correct, addressed by the rebuild job and by the nightly reconciliation comparing row counts and checksums.

**Neutral.** Search lives inside order-service rather than in a separate "search-service". At this scale a separate deployment buys nothing but an extra hop and another thing to keep in sync; the read model is a collection, not a service.

## Alternatives considered

**Query the aggregate directly with a text index.** Rejected on document size — scanning 400 KB documents to return 1 KB of display data is the core problem, and no index choice fixes it.

**Asynchronous projection from events (textbook CQRS).** This was the default expectation, and it is the right answer when the read model lives in a different datastore or a different service. Rejected here because the projection lives in the *same database*, so a transaction is available at negligible cost — and eventual consistency on search would mean explaining a two-second delay to users forever. Taking strong consistency when it is nearly free is the better trade.

**Elasticsearch or OpenSearch.** Best relevance and fuzziness, and the right destination if search becomes a product feature in its own right. Rejected for now on operational cost: another stateful cluster to run, secure, and keep in sync, plus an unavoidable eventual-consistency gap, for a search surface that is currently "find my order by name".

**MongoDB Atlas Search.** Adds fuzzy matching, autocomplete analysers, and relevance scoring without a separate cluster. **Adopted as the upgrade path**, behind `FEATURE_ATLAS_SEARCH`, with both implementations behind the same repository interface — so the switch is a config flag plus a canary, and an Atlas Search outage degrades to the token index rather than breaking search. Not the default only because the token approach already meets the SLO and adds no dependency.

**Offset pagination.** Rejected for the cost curve and, more importantly, for correctness: concurrent inserts cause duplicated and skipped rows, which users notice and report as data loss.
