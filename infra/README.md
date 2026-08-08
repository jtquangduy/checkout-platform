# infra/

Infrastructure-as-code and operational tooling (see [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)):

- `mongo/`, `rabbitmq/`, `keys/` — local dev infra config used by `docker-compose.yml`
- `bicep/` — Azure infrastructure modules + per-environment parameter files
- `k6/` — load test scenarios
- `grafana/` — dashboards and alert rules as code
