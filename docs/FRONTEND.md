# Frontend Design — the Customer Portal

> The "R" in MERN. Backend contracts consumed here are in [API](API.md); the latency budgets this UI is designed around are in [PERFORMANCE §8](PERFORMANCE.md#8-frontend-performance).

---

## 1. What the UI actually has to solve

The portal is a professional tool used under deadline pressure by Art Directors, Producers, and Finance staff at ecommerce studios. That framing changes the priorities from a consumer checkout: the user is doing this dozens of times a week, they are impatient, they know their own data, and they are spending real money on their employer's behalf. So the UI is optimised for speed of repetition and for confidence, not for onboarding delight.

Three problems dominate:

**Finding an order fast.** A studio with thousands of orders needs to reach one in a couple of seconds by typing part of a name. This is the highest-frequency interaction in the product and gets the most attention.

**Being trusted with money.** The user must see exactly what they will be charged, know it cannot change under them, and never be left wondering whether a payment went through. Ambiguity here generates support tickets and erodes trust faster than any bug.

**Making an asynchronous backend feel synchronous.** Checkout returns in under a second, but the invoice, Production push, and email land over the next few seconds. The UI has to represent "paid, and three things are finishing" honestly — without either lying that everything is done or presenting a frozen spinner that looks broken.

---

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | **React 19 + TypeScript, strict** | The "R"; concurrent features (`useTransition`, `useDeferredValue`) are genuinely useful for search-as-you-type |
| Build | **Vite 6** | Sub-second HMR; route-level code splitting out of the box |
| Server state | **TanStack Query v5** | Caching, deduplication, background refetch, and `keepPreviousData` are most of what a search UI needs, and hand-rolling them is a bug factory |
| Client state | **Zustand** | Only for genuinely client-side state (filter panel open, selection). Deliberately small |
| Forms | **React Hook Form + zod** | The *same* zod schemas from `packages/contracts` — client validation cannot drift from server validation |
| Routing | **TanStack Router** | Type-safe params and search params; URL is the source of truth for filters |
| Styling | **Tailwind + Radix primitives** | Radix gives keyboard nav, focus management, and ARIA correctly; accessibility is not retrofittable |
| Tables/lists | **TanStack Virtual** | Thousands of rows, fifteen DOM nodes |
| Realtime | **Native `EventSource`** | SSE for saga progress; no extra dependency |
| Testing | **Vitest + Testing Library + MSW + Playwright** | MSW mocks at the network layer, so tests exercise real fetch/serialisation |

Reusing the backend's zod schemas on the client is the highest-leverage choice in that table. Client and server validate with the same code, so "the form let me submit something the API rejected" stops being a possible bug.

---

## 3. Structure

Feature-first, not type-first. Grouping by feature means everything about checkout is in one folder and a feature can be deleted in one commit; grouping by type (`components/`, `hooks/`, `utils/`) means a single feature is smeared across six directories, which is where large frontends become unnavigable.

```
apps/portal-web/src/
├── app/                       # shell, router, providers, error boundaries
├── features/
│   ├── orders/
│   │   ├── api/               # typed clients + query/mutation hooks
│   │   ├── components/        # OrderSearchBar, OrderTable, OrderStatusBadge…
│   │   ├── hooks/             # useOrderSearch, useOrderFilters (URL-synced)
│   │   └── routes/            # OrderListPage, OrderDetailPage
│   ├── checkout/
│   │   ├── components/        # CheckoutDrawer, PaymentMethodPicker,
│   │   │                      # OrderSummary, ObligationTracker, ScaChallenge
│   │   ├── hooks/             # useCheckout, useCheckoutStream
│   │   └── routes/
│   ├── invoices/  payment-methods/  assets/
├── shared/
│   ├── api/                   # fetch wrapper: auth, correlation id, retry, problem+json
│   ├── components/            # from packages/ui
│   ├── formatters/            # ⭐ money, dates, file sizes — one implementation
│   └── hooks/                 # useDebounce, useSse, useIdempotencyKey
└── test/
```

`shared/formatters/money.ts` exists because money formatting must happen in exactly one place. The API returns `{ amount: 163020, currency: 'GBP' }`, and every display of it goes through one function — otherwise `£1630.2` appears somewhere, and a user who sees a malformed price stops trusting the total.

---

## 4. Order search — the primary requirement

> *"Orders could be searched/filtered by name" · "The Art Director could find the order by order name."*

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Orders                                            [+ New order]         │
├──────────────────────────────────────────────────────────────────────────┤
│  🔍 nike ss26                                             ⌘K   ✕         │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Nike SS26 Apparel — Batch 04    400 items   £1,630.20   Ready  ↵   │  │
│  │ Nike SS26 Footwear — Batch 01   180 items     £691.20   In prod    │  │
│  │ Nike SS26 Accessories          …                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Status: [Ready 18] [Draft 4] [In production 31] [Delivered 210]         │
│  Created: [Any ▾]   Due: [Any ▾]   Created by: [Anyone ▾]                │
├──────────────────────────────────────────────────────────────────────────┤
│  NAME                          ITEMS   TOTAL      STATUS      DUE        │
│  ─────────────────────────────────────────────────────────────────────   │
│  ▢ Nike SS26 Apparel — Batch 04  400  £1,630.20  ● Ready    8 Aug 10:31 │
│    PO-4471 · Sofia Marin · 1 Aug            [Check out →]                │
│  ▢ Nike SS26 Footwear — Batch 01 180    £691.20  ◐ In prod  8 Aug 06:00 │
│    PO-4468 · Marco Silva · 31 Jul            34% ▓▓▓░░░░░                │
└──────────────────────────────────────────────────────────────────────────┘
```

Design decisions worth defending:

**The URL is the source of truth for filters.** `?q=nike+ss26&status=READY_FOR_CHECKOUT&sort=-createdAt` means a search is shareable, bookmarkable, and survives a refresh. For a professional tool where colleagues send each other links, storing filter state only in React would be a real usability loss.

**Debounce at 250 ms with abort-on-supersede.** Fast typing produces one request, not eight, and stale responses can never overwrite fresh ones. This is also what keeps the search RPS in [PERFORMANCE §1](PERFORMANCE.md#1-load-model-sizing-for-reality-not-for-a-resume) achievable.

**`keepPreviousData` so the list never flashes empty.** Refining a query shows the previous results at reduced opacity while the next set loads. An empty state that appears for 200 ms between every keystroke reads as broken.

**Virtualised rows.** Five thousand matches render fifteen DOM nodes.

**`canCheckout` comes from the server.** The Check out button's enabled state is never re-derived on the client. If the client computed eligibility from `status`, the two would eventually disagree and a user would click a button that then fails — so the API returns the decision and the UI obeys it.

```tsx
// features/orders/hooks/useOrderSearch.ts
export function useOrderSearch() {
  const [filters, setFilters] = useOrderFilters();       // synced to the URL
  const debouncedQ = useDebounce(filters.q, 250);

  const query = useInfiniteQuery({
    queryKey: ['orders', { ...filters, q: debouncedQ }],
    queryFn: ({ pageParam, signal }) =>
      // signal is wired to TanStack Query's abort controller: superseding a
      // request cancels the previous one at the network layer.
      ordersApi.search({ ...filters, q: debouncedQ, cursor: pageParam }, { signal }),
    getNextPageParam: (last) => last.page.nextCursor,    // keyset, not offset
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  // Deferred value keeps the input responsive while a large list re-renders —
  // typing must never feel like it is fighting the UI.
  const results = useDeferredValue(query.data?.pages.flatMap((p) => p.data) ?? []);
  return { ...query, results, filters, setFilters };
}
```

A command palette (`⌘K`) hits `/orders/suggest` for keyboard-first navigation, because power users of a tool like this live on the keyboard. Empty states are specific rather than generic: "No orders match *nike ss26*" with a one-click filter reset, not "No results".

---

## 5. Order detail — establishing trust in the number

The detail page's job is to make the amount unambiguous before the user commits. It renders the server's `pricingSnapshot` verbatim — line by line, with the volume discount and tax shown separately — because the snapshot is the same immutable object the orchestrator will charge ([DATA-MODEL §3.1](DATA-MODEL.md#31-orders)). The UI never computes a total.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ← Orders    Nike SS26 Apparel — Batch 04              ● Ready           │
│  PO-4471 · created by Sofia Marin, 1 Aug · due 8 Aug 10:31               │
├───────────────────────────────────────┬──────────────────────────────────┤
│  Assets (400)              [Grid|List]│  Summary                         │
│  ▢▢▢▢▢▢  ▢▢▢▢▢▢  ▢▢▢▢▢▢               │  Ghost mannequin ×400  £1,280.00 │
│  ▢▢▢▢▢▢  ▢▢▢▢▢▢  ▢▢▢▢▢▢               │  Rush 24h ×1             £150.00 │
│  … virtualised grid …                 │  Volume discount −5%     −£71.50 │
│                                       │  ───────────────────────────────  │
│  Timeline                             │  Subtotal              £1,358.50 │
│  ● Created            1 Aug 09:12     │  VAT 20%                 £271.70 │
│  ● Ready for checkout 3 Aug 14:02     │  ═══════════════════════════════  │
│                                       │  Total                 £1,630.20 │
│                                       │                                  │
│                                       │  [    Check out  →    ]          │
│                                       │  Price fixed at quote, 3 Aug     │
└───────────────────────────────────────┴──────────────────────────────────┘
```

The line "Price fixed at quote, 3 Aug" is small but does real work: it tells the user the number cannot move, which is the property the immutable snapshot actually provides. Surfacing a guarantee the system genuinely makes is cheap and buys disproportionate confidence.

The page is fetched with the single GraphQL `OrderDetail` query ([API §2.5](API.md#25-graphql-one-scoped-read-query)) so four services' data arrives in one round trip. Panels whose resolver returned a partial error render a small "couldn't load" state with a retry rather than failing the page — an invoice panel that is temporarily unavailable should not block someone from checking out.

---

## 6. The checkout flow

Four states, and the interesting one is the third.

```
1. REVIEW              2. PROCESSING           3. FINALISING          4. DONE
┌───────────────┐     ┌───────────────┐     ┌────────────────────┐  ┌──────────────┐
│ 400 items     │     │      ◐        │     │ ✅ Payment taken   │  │      ✅      │
│ Total £1,630.20│     │  Processing   │     │    £1,630.20 ·••4242│  │  All set!    │
│               │     │  payment…     │     │                    │  │              │
│ Pay with      │     │               │     │ ✅ Sent to         │  │ In production│
│ ● Visa ••4242 │     │ Do not close  │     │    production      │  │ Due 8 Aug    │
│ ○ New card    │     │ this window   │     │ ◐ Creating         │  │      10:31   │
│               │     │               │     │   invoice…         │  │              │
│[Pay £1,630.20]│     │               │     │ ◌ Emailing you     │  │ [View order] │
└───────────────┘     └───────────────┘     └────────────────────┘  └──────────────┘
      ~0 ms                 780 ms              780 ms – ~15 s          ~16 s
```

**State 3 is where the architecture becomes visible to the user, and it is a feature.** The `201` has arrived, payment is confirmed, and three obligations resolve independently over the SSE stream — in practice production lands first (a few seconds), then the invoice, then the email, which waits for the invoice number so it can include it. Each gets its own line with its own state, so a slow obligation looks like *one item still working* while the others show green — not a frozen page. This is far more reassuring than a single indeterminate spinner, and it is honest about what has and has not happened.

**Payment is never ambiguous.** The moment capture succeeds, the UI says "Payment taken · £1,630.20 · ••4242" and never retracts it. If a later obligation is slow, the message becomes "Payment confirmed — we're finalising your order, this can take a moment"; if it exceeds the SLO, "Payment confirmed. There's a delay sending to production — our team has been notified and your deadline is protected." At no point does the user doubt whether they paid, and at no point are they told everything is fine when it is not.

```tsx
// features/checkout/hooks/useCheckout.ts
export function useCheckout(orderId: string) {
  // ⭐ ONE key per attempt, generated on mount and reused across retries.
  // This is what makes a double-click or a network retry safe — the server
  // returns the original response instead of charging twice.
  const idempotencyKey = useIdempotencyKey(orderId);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: CheckoutInput) =>
      checkoutApi.createSession({
        orderId,
        paymentMethod: input.paymentMethod,
        // Guard, not the charged amount: the server re-derives the total and
        // returns 422 PRICE_MISMATCH rather than charging a different number.
        expectedTotal: input.expectedTotal,
        returnUrl: `${location.origin}/orders/${orderId}/checkout/return`,
      }, { idempotencyKey }),

    retry: (attempt, err) =>
      // Only retry genuinely ambiguous outcomes, and only with the same key.
      // A decline is a final answer; retrying it would be user-hostile.
      attempt < 2 && isAmbiguous(err),      // 504, 503, network error

    onSuccess: (session) => {
      setSessionId(session.id);                 // opens the SSE stream
      qc.invalidateQueries({ queryKey: ['orders', orderId] });
    },
  });

  // Live obligation tracking. Falls back to polling if SSE is blocked by a
  // corporate proxy — a real constraint in enterprise studio networks.
  const stream = useCheckoutStream(sessionId);

  return { start: mutation.mutate, phase: derivePhase(mutation, stream),
           obligations: stream.obligations, error: mapProblem(mutation.error) };
}
```

```tsx
// features/checkout/hooks/useCheckoutStream.ts
export function useCheckoutStream(sessionId: string | null) {
  const [obligations, setObligations] = useState(INITIAL);
  const [phase, setPhase] = useState<StreamPhase>('IDLE');
  const failures = useRef(0);
  const { startPolling, stopPolling } = useObligationPolling(sessionId, setObligations);

  useEffect(() => {
    if (!sessionId) return;
    let es: EventSource | undefined;

    void (async () => {
      // ⚠ The browser EventSource API cannot set an Authorization header, and we
      // are Bearer-token authenticated with no cookie session — `withCredentials`
      // alone would send nothing. So the stream is authenticated with a
      // single-use, 60-second, session-scoped ticket minted over the normal
      // authenticated API (POST …/stream-ticket).
      const ticket = await checkoutApi.mintStreamTicket(sessionId);
      es = new EventSource(
        `${API}/checkout-sessions/${sessionId}/events?ticket=${ticket}`);

      const done = (key: 'invoice' | 'production' | 'email') => (e: MessageEvent) =>
        setObligations((o) => ({ ...o, [key]: { status: 'DONE', ...JSON.parse(e.data) } }));

      es.addEventListener('checkout.captured', () => setPhase('FINALISING'));
      es.addEventListener('checkout.completed', () => setPhase('DONE'));
      es.addEventListener('obligation.production.fulfilled', done('production'));
      es.addEventListener('obligation.invoice.fulfilled',    done('invoice'));
      es.addEventListener('obligation.email.fulfilled',      done('email'));
      es.addEventListener('checkout.degraded', (e) =>
        setObligations((o) => ({ ...o, degraded: true, ...JSON.parse(e.data) })));

      // EventSource reconnects on its own and the server honours Last-Event-ID,
      // so a wifi blip mid-checkout resumes rather than losing state. After 3
      // failures we fall back to polling — never leave the user staring at a
      // stale screen because a corporate proxy ate the stream.
      es.onerror = () => {
        if (++failures.current > 3) { es?.close(); startPolling(); }
      };
    })();

    return () => { es?.close(); stopPolling(); };
  }, [sessionId]);

  return { obligations, phase };
}
```

### 6.1 Errors, phrased for humans

Each `code` from the API maps to a specific message and a specific recovery action. Generic error toasts are the enemy here: a declined card and a network timeout require completely different responses from the user.

| `code` | What the user sees | Action offered |
|---|---|---|
| `INSUFFICIENT_FUNDS` | "Your card was declined — insufficient funds." | Choose another card (order is already released) |
| `CARD_EXPIRED` | "That card expired in 11/2025." | Update card |
| `ORDER_ALREADY_RESERVED` | "Marco is checking this order out right now." | Refresh; live status shown |
| `ORDER_ALREADY_PAID` | "This order was already paid for." | View invoice |
| `PRICE_MISMATCH` | "The price changed while you were reviewing." | Show old vs new; require re-confirmation |
| `DEPENDENCY_TIMEOUT` | "We're confirming your payment — don't retry yet." | Auto-poll; never a naked retry button |

That last row is the important one. Offering a "Try again" button on an ambiguous timeout invites the user to attempt a second charge. We poll instead, and only surface a retry once the outcome is known.

A 3-D Secure challenge is deliberately absent from that table, because it is not an error: the `201` comes back with `status: REQUIRES_ACTION` and an `sca.redirectUrl`, and the UI opens the challenge modal off the *success* response ([API §2.3](API.md#23-checkout-the-core-scenario)). Treating a routine bank verification as an error code is how checkout flows end up showing users a red banner for something that is working correctly.

Anything unexpected shows the `correlationId` with a copy button — the same id that appears in every log line, span, and document for that request ([OBSERVABILITY](OBSERVABILITY.md)), so a support conversation starts with an exact trace instead of "roughly what time was it?".

---

## 7. Accessibility and quality

Accessibility is treated as a requirement rather than an audit item, partly because studio staff use these tools all day and keyboard efficiency is a productivity feature. Radix primitives supply correct focus management, focus trapping in the checkout drawer, and ARIA roles. Search results are an `aria-live="polite"` region announcing "18 orders found". Obligation state changes are announced, so a screen-reader user learns the invoice was created without polling the DOM. Status is never conveyed by colour alone — every badge pairs colour with an icon and text. Full keyboard operation throughout, tested with axe-core in CI and manually with VoiceOver and NVDA each release. Contrast meets WCAG 2.2 AA, verified in both themes.

Testing runs at three levels. Unit and component tests use Testing Library with MSW, so a "search then check out" test exercises real fetch calls, real serialisation, and real error paths against mocked HTTP rather than stubbed functions. Playwright covers the brief's scenario end to end against the full Docker Compose stack — searching by name, checking out, asserting the PSP mock received exactly one charge, asserting the email mock's outbox contains exactly one message, and asserting the order reaches `IN_PRODUCTION`. Failure paths are covered explicitly using the deterministic test cards from [API §3.4](API.md#34-mock-psp-and-mock-email): decline, 3-DS challenge, and the capture-then-timeout card that proves no double charge. Visual regression via Playwright screenshots guards the states that are hard to describe in assertions — the obligation tracker mid-flight, the degraded banner, the empty search.
