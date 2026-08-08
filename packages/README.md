# packages/

Shared libraries, versioned via changesets and consumed by services through pnpm workspace links (no publish step needed locally).

Planned packages (see [`../docs/CODEBASE-STRUCTURE.md`](../docs/CODEBASE-STRUCTURE.md)):

- `contracts` — zod schemas → TS types → OpenAPI + AsyncAPI. Value objects (`Money`, `TenantId`, `OrderId`), event payloads, HTTP request/response shapes.
- `kernel` — cross-cutting runtime with no business logic: outbox, inbox, tenant-scoped Mongo repositories, RabbitMQ publisher/consumer helpers, resilience (timeout/retry/breaker), observability bootstrap, config loader.
- `testing` — Testcontainers fixtures, builders, fake clock.
- `ui` — design system primitives (Radix + Tailwind) for the frontend.
- `config-eslint`, `config-ts`, `config-vitest` — shared tooling config every service/package extends.
