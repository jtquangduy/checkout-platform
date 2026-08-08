# ADR-0009 — Money as integer minor units, rounded once, frozen in a snapshot

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** Finance, Checkout, Staff Engineers

## Context

This system charges cards, issues legally significant invoices, applies per-tenant contract rates with volume tiers, and computes tax. Three failure modes are common and all are expensive to discover late.

**Float arithmetic.** `0.1 + 0.2 === 0.30000000000000004` in JavaScript. Across hundreds of priced units and their per-line tax, accumulated drift produces an invoice total that does not equal the sum of its lines — which a client's accounts-payable team will notice and query.

**Repeated rounding.** If the total is computed on the order screen, again at capture, and again on the invoice, three code paths must round identically forever. They will not.

**Price drift between review and charge.** If pricing is looked up live at capture, a rate-card change published between a client reviewing an order and clicking *Pay* charges them an amount they never saw.

## Decision

**Every monetary value is `{ amount: <integer minor units>, currency: <ISO 4217> }`.** `1999` and `"GBP"`, never `19.99`. There is no `number` money field anywhere in the system, in any schema, event, or API payload.

**`Money` is an object, not a number, and is branded.** Because it is an object, `a + b` does not type-check, so arithmetic has to go through `addMoney`, `subtractMoney`, and `applyRate` — and those reject a currency mismatch with `CurrencyMismatchError` rather than silently producing nonsense. Branding additionally stops a bare `{amount, currency}` from a different domain being passed in by accident.

**Rounding happens exactly once**, at quote time, using banker's rounding (half-to-even), and the result is frozen.

**`order.pricingSnapshot` is immutable and authoritative.** It is created when the order becomes checkout-ready, and it is simultaneously what the customer sees, what the PSP is asked to charge, and what the invoice copies. Not three derivations of one number — the same stored object.

**A SHA-256 `integrityHash`** over the snapshot's lines and totals is recomputed and verified immediately before every capture. A mismatch throws.

**Discounts are lines with negative amounts**, and **tax is computed per line, not on the total** — so invoice arithmetic is a single sum over lines with no special cases.

**Database-level enforcement:** the JSON Schema validator declares `amount` as `bsonType: 'int'`, so a float money value is rejected even by a mongosh session or a migration script.

## Consequences

**Positive.** Rounding drift is impossible because there is one rounding point. Price drift between review and charge is impossible because there is one stored amount. Currency mismatch is a thrown error rather than a silent bug. Banker's rounding is unbiased across many lines, whereas half-up drifts systematically upward and eventually surfaces as pennies of unexplained revenue. And `$0.01` differences — the ones that consume days of finance investigation — cannot occur.

**Negative.** Formatting for display requires a conversion, centralised in one `formatMoney` helper so `£1630.2` cannot appear. Some currencies have zero or three decimal places (JPY, KWD), handled by a per-currency exponent table rather than assuming two. And integer overflow is theoretically possible above ~£90 trillion, which is not a real constraint.

**Neutral.** Multi-currency is currently per-tenant single-currency ([A9](../ASSUMPTIONS.md#a9-per-tenant-single-currency-no-cross-currency-conversion-lower)). The `Money` type already carries a currency, so adding conversion later needs a captured FX rate and a defined conversion point — not a model change.

## Alternatives considered

**Floating-point numbers.** Rejected — this is the canonical money bug and it fails silently.

**`Decimal128` for transactional amounts.** MongoDB supports it and it is exact, so this was a serious candidate. Rejected because arithmetic still requires a decimal library in application code, comparisons and equality are subtler, and integers give exactness with the *simplest possible* semantics. `Decimal128` is retained where a value genuinely is not a currency amount, such as a tax rate. The general rule stands: for money, count the smallest unit.

**Decimal strings (`"19.99"`) in APIs.** Avoids float coercion on the wire and is what some payment APIs do. Rejected because it invites parsing at every boundary, and every parse is a chance to reintroduce a float. Integers are unambiguous in JSON.

**Recompute the total at capture from the live price book.** Rejected — that is exactly the price-drift bug. Re-hashing the snapshot's stored lines instead is both safer and far cheaper: O(lines), and there are three of them, versus re-running tiering and tax over 400 units.

**Store only the total, not the lines.** Rejected: invoices legally require line detail, and a total with no lines cannot be reconciled or disputed.
