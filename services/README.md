# services/

One folder = one deployable = one owning team. Each service is a Node 22 / TypeScript / Express app with the same internal hexagonal layout (`domain/`, `application/`, `infrastructure/`, `interface/`).

Planned services (see [`../docs/CODEBASE-STRUCTURE.md`](../docs/CODEBASE-STRUCTURE.md) and [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)):

- `api-gateway`
- `identity-service`
- `catalog-pricing-service`
- `order-service`
- `checkout-orchestrator`
- `payment-service`
- `invoice-service`
- `notification-service`
- `production-gateway-service`
- `asset-service`
