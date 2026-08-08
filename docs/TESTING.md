# Testing Strategy

> The design in these documents makes strong claims — no double charges, no lost production jobs, gapless invoice numbers. This document is how each claim is turned into a test that fails when the claim stops being true.

---

## 1. What is worth testing here

A test suite should be shaped by where the risk actually is, not by a coverage target applied uniformly. In this system the risk is concentrated in three places, and they are not the places with the most code.

**Concurrency and duplication.** Two people checking out one order, a client retrying an ambiguous timeout, a broker redelivering a message, an operator replaying a DLQ. These bugs are invisible in a single-threaded test and catastrophic in production. They need tests that deliberately create races against real infrastructure.

**Money arithmetic.** Rounding, tax per line, discounts as negative lines, currency mismatch. These fail silently and are discovered by a finance team weeks later. They need property-based and mutation testing, not example-based tests that happen to use round numbers.

**Partial failure across boundaries.** Payment succeeds and the Production push fails; the invoice succeeds and the email bounces; the orchestrator dies between two saga steps. These are the paths that the architecture exists to handle, so they deserve more test attention than the happy path.

Conversely, CRUD endpoints, DTO mapping, and React rendering get proportionally light coverage. The 80% floor in CI is a floor, not a target — chasing it uniformly would spend most of the effort in the wrong place, which is why the money paths carry a 95% line gate and a mutation gate on top.

---

## 2. The pyramid, and what each layer is for

```
        ╱╲          E2E — Playwright · ~25 specs · ~6 min   (all figures are targets)
       ╱  ╲         Full Docker Compose stack. The brief's scenario + failures.
      ╱────╲
     ╱      ╲       Contract — Pact · ~40 pairs · ~1 min
    ╱        ╲      Consumer expectations verified against every provider.
   ╱──────────╲
  ╱            ╲    Integration — Testcontainers · ~450 tests · ~4 min
 ╱              ╲   Real Mongo rs0, real RabbitMQ, real Redis, real mock servers.
╱────────────────╲
──────────────────   Unit — Vitest · ~2,100 tests · ~9 s
                     Pure domain + application with mocked ports. No I/O at all.
```

Unit tests are fast because `domain/` imports nothing ([CODEBASE-STRUCTURE §3.1](CODEBASE-STRUCTURE.md#31-the-dependency-rule)). Nine seconds for 2,100 tests is what makes engineers run them on save, and a suite that is not run on save is not really part of the loop.

Integration tests use **real** dependencies via Testcontainers rather than in-memory fakes. `mongodb-memory-server` does not support transactions the way a replica set does, and the transactional outbox is the single most important mechanism in the design — testing it against a fake that behaves differently would be testing nothing. Likewise the third-party mocks are real HTTP servers, so serialisation, timeouts, retries, and connection handling are all exercised.

---

## 3. Unit tests — pure domain logic

```ts
// services/order-service/test/unit/order.state-machine.spec.ts
describe('Order state machine', () => {
  // Table-driven over the full transition matrix, so adding a status forces a
  // decision about every existing one rather than silently permitting it.
  const cases: Array<[OrderStatus, OrderStatus, boolean]> = [
    ['READY_FOR_CHECKOUT', 'CHECKOUT_PENDING', true],
    ['READY_FOR_CHECKOUT', 'PAID_AWAITING_PRODUCTION', false],  // must go via reservation
    ['CHECKOUT_PENDING', 'READY_FOR_CHECKOUT', true],           // release
    ['CHECKOUT_PENDING', 'PAID_AWAITING_PRODUCTION', true],
    ['DELIVERED', 'CHECKOUT_PENDING', false],                   // no resurrection
    ['REFUNDED', 'IN_PRODUCTION', false],
  ];
  it.each(cases)('%s → %s allowed=%s', (from, to, allowed) => {
    const order = anOrder({ status: from });
    allowed
      ? expect(() => order.transitionTo(to)).not.toThrow()
      : expect(() => order.transitionTo(to)).toThrow(IllegalTransitionError);
  });

  it('appends to statusHistory with actor and correlation id', () => {
    const order = anOrder({ status: 'READY_FOR_CHECKOUT' });
    order.transitionTo('CHECKOUT_PENDING', { by: 'usr_1', reason: 'checkout', correlationId: 'req_1' });
    expect(order.statusHistory.at(-1)).toMatchObject({
      from: 'READY_FOR_CHECKOUT', to: 'CHECKOUT_PENDING', by: 'usr_1', correlationId: 'req_1',
    });
  });
});
```

### 3.1 Property-based tests for money

Example-based tests on money code pass because the examples were chosen with round numbers. Property tests generate thousands of awkward inputs — 37 items at £3.33 with a 7% discount and 19% VAT — and assert the invariants that must hold for *all* of them.

```ts
// packages/contracts/test/unit/money.property.spec.ts
import fc from 'fast-check';

describe('pricing invariants', () => {
  it('total always equals subtotal + tax, for any line set', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        quantity:  fc.integer({ min: 1, max: 500 }),
        unitMinor: fc.integer({ min: 1, max: 100_000 }),
        discountBps: fc.integer({ min: 0, max: 5_000 }),
      }), { minLength: 1, maxLength: 500 }),
      fc.constantFrom(0, 0.05, 0.07, 0.19, 0.20, 0.21),
      (lines, taxRate) => {
        const quote = computeQuote(lines.map(toLine), { taxRate, currency: 'GBP' });
        // The invariant a finance team would check by hand.
        expect(quote.total.amount).toBe(quote.subtotal.amount + quote.tax.amount);
        // Tax computed PER LINE, so the sum must reconcile exactly — this is the
        // assertion that catches "tax on the rounded total" bugs.
        expect(quote.tax.amount).toBe(sum(quote.lines.map(l => l.taxAmount.amount)));
        // Integers only. A float here means a `0.30000000000000004` in an invoice.
        expect(Number.isInteger(quote.total.amount)).toBe(true);
      },
    ), { numRuns: 5_000 });
  });

  it('banker\'s rounding does not drift over many lines', () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 9_999 }), { minLength: 100, maxLength: 500 }),
      (amounts) => {
        const rate = 0.175;   // a rate that produces halves often
        const drift = amounts.reduce((d, a) =>
          d + (applyRate({ amount: a, currency: 'GBP' }, rate).amount - a * rate), 0);
        // Half-up would drift systematically positive; half-to-even should not.
        // This is the test that justifies the rounding choice in DATA-INTEGRITY §8.
        expect(Math.abs(drift)).toBeLessThan(amounts.length * 0.5);
      },
    ));
  });

  it('rejects currency mismatch rather than silently converting', () => {
    expect(() => addMoney({ amount: 100, currency: 'GBP' }, { amount: 100, currency: 'EUR' }))
      .toThrow(CurrencyMismatchError);
  });
});
```

### 3.2 Mutation testing on the modules that matter

Line coverage proves the code ran; it does not prove a test would fail if the code were wrong. On money and saga logic that distinction is the whole point, so Stryker runs against `domain/` in payment, invoice, checkout, and the money helpers, with a 70% mutation-score gate. It is scoped to `domain/` because that is where it is affordable (fast, pure code) and where an undetected logic inversion is most expensive.

---

## 4. Integration tests — real infrastructure

```ts
// packages/testing/src/harness.ts — one shared harness, reused by every service
export async function createTestHarness(): Promise<Harness> {
  const network = await new Network().start();

  // A real REPLICA SET, not mongodb-memory-server. Multi-document transactions
  // are the foundation of the outbox pattern; testing them against something
  // that fakes transactions would validate nothing.
  const mongo = await new MongoDBContainer('mongo:7')
    .withNetwork(network).withCommand(['--replSet', 'rs0']).start();
  await initReplicaSet(mongo);

  const rabbit = await new RabbitMQContainer('rabbitmq:3.13-management').withNetwork(network).start();
  const redis  = await new RedisContainer('redis:7').withNetwork(network).start();

  // The third-party mocks as real HTTP servers, so timeouts, retries and
  // serialisation are genuinely exercised.
  const psp        = await startPspMock();
  const email      = await startEmailMock();
  const production = await startProductionMock();
  const accounting = await startAccountingMock();

  return { mongo, rabbit, redis, psp, email, production, accounting,
           /* reset(), stop() */ };
}
```

### 4.1 The concurrency test

This is the test that proves the reservation lock. It asserts a claim that cannot be verified any other way.

```ts
// services/order-service/test/integration/concurrent-reservation.spec.ts
it('exactly one of 50 concurrent reservations succeeds', async () => {
  const order = await seedOrder({ status: 'READY_FOR_CHECKOUT', version: 1 });

  // All 50 read version 1 and race. This is the studio-with-three-Art-Directors
  // scenario, amplified.
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      useCases.reserve.execute({
        orderId: order.id, tenantId: order.tenantId,
        expectedVersion: 1, checkoutSessionId: `cko_${i}`,
      })),
  );

  expect(results.filter(r => r.result === 'OK')).toHaveLength(1);
  expect(results.filter(r => r.result === 'ALREADY_RESERVED' || r.result === 'VERSION_CONFLICT'))
    .toHaveLength(49);

  const after = await orders.findById(order.id);
  expect(after.status).toBe('CHECKOUT_PENDING');
  expect(after.version).toBe(2);                    // exactly ONE increment
  // One reservation ⇒ exactly one outbox event. 50 events here would mean the
  // CAS "succeeded" 50 times somewhere.
  expect(await countOutbox({ eventType: 'order.reserved' })).toBe(1);
});
```

### 4.2 The outbox atomicity test

```ts
// services/payment-service/test/integration/outbox-atomicity.spec.ts
it('never publishes an event whose transaction rolled back', async () => {
  // Force a failure AFTER the payment write but BEFORE commit.
  vi.spyOn(transactions, 'append').mockRejectedValueOnce(new Error('boom'));

  await expect(useCases.capture.execute(aCaptureCommand())).rejects.toThrow('boom');

  // Both must be absent. If the event exists without the payment, an invoice
  // would be issued for a charge that never happened.
  expect(await payments.findByOrderId(orderId)).toBeNull();
  expect(await countOutbox({ eventType: 'payment.captured' })).toBe(0);
});

it('publishes on restart when the relay died after commit', async () => {
  await stopOutboxRelay();                          // simulate a crashed relay
  await useCases.capture.execute(aCaptureCommand());

  expect(await countOutbox({ status: 'PENDING' })).toBe(1);   // durable, waiting
  expect(await rabbit.messageCount('q.checkout.payment-events')).toBe(0);

  await startOutboxRelay();                         // pod comes back
  await waitFor(async () => expect(await rabbit.messageCount('q.checkout.payment-events')).toBe(1));
  // At-least-once, never at-most-once. This is the guarantee the whole design rests on.
});
```

### 4.3 Idempotency tests

```ts
it('20 identical POSTs charge once and return 20 identical responses', async () => {
  const key = ulid();
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => api.post('/checkout-sessions', body, { 'Idempotency-Key': key })),
  );
  const created = responses.filter(r => r.status === 201);
  const inFlight = responses.filter(r => r.status === 409);   // REQUEST_IN_PROGRESS

  expect(created.length + inFlight.length).toBe(20);
  // All successful bodies byte-identical: the client cannot tell a replay from
  // the original, which is exactly the contract.
  expect(new Set(created.map(r => JSON.stringify(r.body))).size).toBe(1);
  expect(await psp.chargeCount()).toBe(1);                    // ⭐ the assertion that matters
});

it('rejects a reused key with a different body instead of silently applying it', async () => {
  const key = ulid();
  await api.post('/checkout-sessions', { orderId: 'ord_A', ... }, { 'Idempotency-Key': key });
  const res = await api.post('/checkout-sessions', { orderId: 'ord_B', ... }, { 'Idempotency-Key': key });
  expect(res.status).toBe(422);
  expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY');
});
```

### 4.4 Consumer idempotency

```ts
it('redelivered checkout.completed produces one invoice and one email', async () => {
  const evt = aCheckoutCompletedEvent();

  await publish(evt);
  await publish(evt);                     // broker redelivery
  await publish({ ...evt });              // DLQ replay, same messageId
  await waitForQuiet();

  expect(await invoices.countByOrderId(evt.payload.order.id)).toBe(1);
  // 2 = the event's two recipients (to + cc), NOT 2 deliveries of one email.
  expect(await email.outbox()).toHaveLength(evt.payload.recipients.length);
  expect(await production.jobCount()).toBe(1);
  // Duplicates are the system working correctly — assert they were counted, so
  // a regression that stops deduping shows up as a business-invariant failure
  // AND as a missing metric.
  expect(metrics.duplicatesDetected.value()).toBe(2);
});
```

### 4.5 Chaos tests on the saga

```ts
// services/checkout-orchestrator/test/integration/saga-chaos.spec.ts
const STEPS = ['VALIDATE_ORDER','VERIFY_QUOTE','RESERVE_ORDER',
               'CAPTURE_PAYMENT','CONFIRM_ORDER_PAID','EMIT_COMPLETION'] as const;

it.each(STEPS)('converges to a correct terminal state when killed after %s', async (step) => {
  const order = await seedOrder({ status: 'READY_FOR_CHECKOUT' });
  await killOrchestratorAfterStep(step);

  await api.post('/checkout-sessions', { orderId: order.id, ... }).catch(() => {});
  await restartOrchestrator();
  await waitForSagaTerminal(order.id, { timeout: 60_000 });

  const [after, payment] = await Promise.all([orders.findById(order.id), payments.findByOrderId(order.id)]);

  // The split is at RESERVE_ORDER, matching CHECKOUT-SAGA §4.7: a crash before
  // a reservation exists has nothing to recover, so it aborts; a crash at or
  // after RESERVE_ORDER recovers FORWARD, because the user is still waiting on
  // the order they reserved.
  if (['VALIDATE_ORDER','VERIFY_QUOTE'].includes(step)) {
    // Pre-reservation: clean abort. Order usable again, nothing charged.
    expect(after.status).toBe('READY_FOR_CHECKOUT');
    expect(payment).toBeNull();
    expect(await email.outbox()).toHaveLength(0);       // no email without payment
  } else {
    // At or after reservation: forward recovery. Money taken once, obligations
    // discharged, order ends in a paid state.
    expect(payment!.status).toBe('CAPTURED');
    expect(await psp.chargeCount()).toBe(1);            // ⭐ never twice, at any kill point
    expect(['PAID_AWAITING_PRODUCTION','IN_PRODUCTION']).toContain(after.status);
    await waitFor(async () => expect(await invoices.countByOrderId(order.id)).toBe(1));
    await waitFor(async () => expect(await email.outbox()).toHaveLength(1));
  }
});
```

This parameterised test is the highest-value test in the suite. It asserts the central architectural claim — that the system converges correctly from a crash at *any* point in a checkout — six times, and it would catch a regression in the saga's persistence, the reaper, the idempotency keys, or the outbox.

---

## 5. Contract tests

Consumer-driven contracts (Pact) solve the specific problem that a provider's own tests all pass while it breaks a real consumer. The consumer declares what it needs; the provider must satisfy it in CI; `can-i-deploy` blocks a deploy that would break anything currently in production.

```ts
// apps/portal-web/test/contract/orders.consumer.spec.ts
await provider.addInteraction({
  states: [{ description: 'tenant has an order named "Nike SS26 Apparel — Batch 04"' }],
  uponReceiving: 'a search for "nike ss26"',
  withRequest: { method: 'GET', path: '/api/v1/orders', query: { q: 'nike ss26' } },
  willRespondWith: {
    status: 200,
    body: like({
      data: eachLike({
        id: term({ generate: 'ord_01JBQ…', matcher: '^ord_[0-9A-HJKMNP-TV-Z]{26}$' }),
        name: like('Nike SS26 Apparel — Batch 04'),
        status: term({ generate: 'READY_FOR_CHECKOUT',
                       matcher: '^(DRAFT|PRICING|READY_FOR_CHECKOUT|CHECKOUT_PENDING|…)$' }),
        // Money shape is asserted structurally: an integer + a currency, never
        // a decimal. This contract is what stops a provider "helpfully"
        // returning 1630.20 one day.
        total: like({ amount: integer(163020), currency: like('GBP') }),
        canCheckout: boolean(true),
      }),
      page: like({ limit: integer(25), nextCursor: like('eyJ…'), hasMore: boolean(true) }),
    }),
  },
});
```

Event contracts get the same treatment, plus one property that is easy to forget and expensive to discover in production:

```ts
it('tolerates unknown fields, so additive event changes are non-breaking', async () => {
  // EVENTS.md promises additive changes are safe within a version. This asserts it.
  const evt = { ...aCheckoutCompletedEvent(),
                payload: { ...payload, someFutureField: 'added in v1.5' } };
  await expect(consumer.handle(evt)).resolves.not.toThrow();
});
```

---

## 6. End-to-end tests

Playwright against the full Compose stack. The first spec is literally the brief's scenario, asserted at every boundary.

```ts
// tests/e2e/checkout.spec.ts
test('Art Director searches by name, checks out, order reaches production', async ({ page }) => {
  await loginAs(page, 'sofia@nikestudio.example');

  // Requirement: orders searched/filtered by name
  await page.goto('/orders');
  await page.getByPlaceholder('Search orders').fill('nike ss26');
  await expect(page.getByRole('row', { name: /Nike SS26 Apparel — Batch 04/ })).toBeVisible();

  await page.getByRole('link', { name: /Nike SS26 Apparel — Batch 04/ }).click();
  await expect(page.getByTestId('order-total')).toHaveText('£1,630.20');

  await page.getByRole('button', { name: 'Check out' }).click();
  await page.getByRole('radio', { name: /Visa ••4242/ }).check();
  await page.getByRole('button', { name: /Pay £1,630.20/ }).click();

  // Payment confirmed fast; obligations resolve independently (FRONTEND §6)
  await expect(page.getByTestId('obligation-payment')).toHaveAttribute('data-state', 'done',
    { timeout: 5_000 });
  await expect(page.getByTestId('obligation-invoice')).toHaveAttribute('data-state', 'done',
    { timeout: 20_000 });
  await expect(page.getByTestId('obligation-production')).toHaveAttribute('data-state', 'done',
    { timeout: 40_000 });
  await expect(page.getByTestId('order-status')).toHaveText('In production');

  // Assert against the MOCKS, not just the UI — the UI could be lying.
  expect(await pspMock.charges()).toHaveLength(1);                       // exactly once
  expect(await productionMock.jobs()).toHaveLength(1);                   // requirement
  const emails = await emailMock.outbox();
  expect(emails).toHaveLength(2);            // requirement: one per recipient (to + cc)
  expect(emails.map(e => e.to).sort()).toEqual(['ap@nikestudio.example',
                                                'sofia@nikestudio.example']);
  expect(emails[0].subject).toContain('Order confirmed');
  expect(emails[0].html).toContain('INV-2026-');                          // invoice number
});
```

Failure paths get equal weight, using the deterministic test cards from [API §3.4](API.md#34-mock-psp-and-mock-email):

```ts
test('declined card releases the order and sends no email', async ({ page }) => {
  await checkoutWith(page, CARD.INSUFFICIENT_FUNDS);
  await expect(page.getByRole('alert')).toContainText('insufficient funds');
  await expect(page.getByTestId('order-status')).toHaveText('Ready');   // immediately reusable
  expect(await emailMock.outbox()).toHaveLength(0);                     // ⭐ no email without payment
  expect(await productionMock.jobs()).toHaveLength(0);
});

test('capture-then-timeout does not double charge on retry', async ({ page }) => {
  await checkoutWith(page, CARD.CAPTURE_THEN_TIMEOUT);
  // The UI must NOT offer a naked retry on an ambiguous outcome (FRONTEND §6.1).
  await expect(page.getByText(/confirming your payment/i)).toBeVisible();
  await expect(page.getByTestId('obligation-payment')).toHaveAttribute('data-state', 'done',
    { timeout: 30_000 });
  expect(await pspMock.charges()).toHaveLength(1);                      // ⭐ exactly one
});

test('production outage keeps the money and recovers', async ({ page }) => {
  await productionMock.setBehavior('fail-transient', { failures: 3 });
  await checkoutWith(page, CARD.SUCCESS);
  await expect(page.getByText(/finalising your order/i)).toBeVisible();
  await expect(page.getByTestId('order-status')).toHaveText('Paid — awaiting production');
  await productionMock.setBehavior('ok');
  // Attempt 4 lands at 5 + 30 + 120 = 155 s on the real ladder. The test uses
  // the compressed ladder from the test profile (RETRY_LADDER=fast: 1/2/4/8 s)
  // rather than a generous timeout — waiting out production backoff in CI is
  // how suites become flaky and then get skipped.
  await expect(page.getByTestId('order-status')).toHaveText('In production', { timeout: 30_000 });
  expect(await pspMock.refunds()).toHaveLength(0);   // ⭐ a transient failure NEVER refunds
});

test('permanent rejection refunds and explains why', async ({ page }) => {
  await productionMock.setBehavior('fail-permanent', { error: 'unsupported_asset_format' });
  await checkoutWith(page, CARD.SUCCESS);
  await expect(page.getByTestId('order-status')).toHaveText('Refunded', { timeout: 60_000 });
  expect(await pspMock.refunds()).toHaveLength(1);
  expect((await emailMock.outbox()).at(-1)!.html).toContain('fully refunded');
});

test('two users cannot check out the same order', async ({ browser }) => {
  const [sofia, marco] = await Promise.all([asUser(browser, 'sofia'), asUser(browser, 'marco')]);
  await Promise.all([sofia.clickCheckout(), marco.clickCheckout()]);
  const outcomes = await Promise.all([sofia.outcome(), marco.outcome()]);
  expect(outcomes.filter(o => o === 'success')).toHaveLength(1);
  expect(outcomes.filter(o => o === 'already-reserved')).toHaveLength(1);
  expect(await pspMock.charges()).toHaveLength(1);                      // ⭐
});
```

Cross-tenant isolation is asserted systematically rather than spot-checked, because it is the highest-impact security property in [SECURITY §3](SECURITY.md#3-multi-tenant-isolation):

```ts
test.describe('tenant isolation', () => {
  // Generated over the full route table, so a new endpoint is covered
  // automatically and cannot be forgotten.
  for (const route of ALL_TENANT_SCOPED_ROUTES) {
    test(`${route.method} ${route.path} returns 404 for another tenant's resource`, async () => {
      const res = await asTenant('B').request(route.method, route.pathFor(tenantAResourceId));
      expect(res.status()).toBe(404);   // 404, not 403 — existence is not disclosed
    });
  }
});
```

---

## 7. Non-functional testing and CI gates

Load and soak testing is covered in [PERFORMANCE §9](PERFORMANCE.md#9-load-testing) with k6 thresholds that fail the build. Accessibility runs axe-core on every page in CI plus manual screen-reader passes each release ([FRONTEND §7](FRONTEND.md#7-accessibility-and-quality)). Security testing is in [SECURITY §9](SECURITY.md#9-verification). Visual regression uses Playwright screenshots for the states that are awkward to assert in code — the obligation tracker mid-flight, the degraded banner, the empty search result.

CI gates on every pull request: OpenAPI and AsyncAPI generation from the zod schemas, so a schema change that cannot produce a valid spec fails before anything is built; lint and typecheck on affected packages; unit tests with ≥80% coverage overall and ≥95% on `domain/` in payment, invoice, and checkout; a ≥70% mutation score on those same modules; integration tests against real containers; contract verification plus `can-i-deploy`; OpenAPI and AsyncAPI breaking-change detection; dependency, container, and secret scanning; and Lighthouse budgets on the frontend. Nightly, the longer suites run: full e2e across all browsers, k6 load and soak, chaos experiments, and the reconciliation job against a seeded dataset.

Test data comes from builders with sensible defaults rather than fixture files, so a test states only what it cares about — `anOrder({ status: 'CHECKOUT_PENDING' })` — and adding a required field does not break 400 fixtures. Every test resets the database, purges queues, and flushes Redis between cases, and time is controlled through an injected `Clock` port so testing a 15-minute reservation timeout takes microseconds rather than fifteen minutes.

---

## 8. Requirement-to-test traceability

Every claim in these documents maps to a named test, so a reviewer can verify that the design is asserted rather than merely described.

| Claim | Test |
|---|---|
| Orders searchable by name | `e2e/checkout.spec.ts` · `order-search.integration.spec.ts` |
| Successful checkout pushes to Production | `e2e/checkout.spec.ts` (asserts `productionMock.jobs()`) |
| Production system updates order state | `e2e/checkout.spec.ts` (asserts `In production`) |
| Client receives email on payment success | `e2e/checkout.spec.ts` (asserts `emailMock.outbox()`) |
| No email when payment fails | `e2e/checkout-declined.spec.ts` |
| No double charge, ever | `idempotency.integration.spec.ts` · `concurrent-reservation.spec.ts` · `saga-chaos.spec.ts` · 3 e2e specs |
| Money never taken without a durable obligation | `outbox-atomicity.spec.ts` |
| Transient Production failure never refunds | `e2e/production-outage.spec.ts` |
| Permanent rejection refunds and explains | `e2e/production-rejected.spec.ts` |
| Gapless invoice numbers under concurrency | `invoice-numbering.integration.spec.ts` (100 parallel issues) |
| Duplicate events produce one effect | `consumer-idempotency.integration.spec.ts` |
| Saga recovers from a crash at any step | `saga-chaos.spec.ts` (parameterised over all 6 steps) |
| No cross-tenant access | `e2e/tenant-isolation.spec.ts` (generated over all routes) |
| Search p95 < 200 ms | `k6/checkout-peak.js` threshold |
| Capture → production p95 < 30 s | `k6/checkout-peak.js` threshold |
| Additive event changes are non-breaking | `contract/*.consumer.spec.ts` unknown-field test |
