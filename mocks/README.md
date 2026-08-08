# mocks/

Mocked third parties, as real HTTP servers rather than in-process stubs — so integration tests exercise real serialisation, timeouts, and retries, and each mock supports injectable failure so resilience paths (breakers, retry ladders, DLQs) can be exercised on demand.

Planned mocks (see [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §2–3):

- `psp-mock` — Stripe-shaped payment provider
- `email-mock` — SES/SendGrid-shaped email provider, with a browsable outbox
- `production-mock` — the internal Production system's external API
- `accounting-mock` — Xero/NetSuite-shaped accounting ledger
