# ADR-0011 — Azure DevOps Pipelines with workload identity federation

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** Platform, SRE, Security
- **Related:** [ADR-0001](0001-monorepo-with-independent-deploys.md) (monorepo and affected-graph CI)

## Context

A monorepo containing ten services, a frontend, and shared contract packages needs CI/CD that can build only what a change affects, gate on cross-service compatibility, and deploy to four Azure environments with real approval controls. The earlier design assumed GitHub Actions plus Argo CD; deploying onto Azure makes it worth asking whether that is still the right pairing.

Two requirements dominate. The **affected graph must be respected** — a naive pipeline that rebuilds all ten images on every commit takes 40 minutes and nobody merges anything. And **production deploys need genuine gates**: two named approvers, a business-hours window, and an automated SLO check between canary increments, because a payments system should not be promoted on the basis of somebody watching a dashboard for ten minutes.

There is also a security requirement that is easy to under-weight. A CI system holding long-lived cloud credentials is one of the most attractive targets in an organisation, and a leaked service-principal secret with subscription-level RBAC is close to a worst case.

## Decision

**Azure DevOps Pipelines**, one multi-stage YAML file plus reusable templates in `.azuredevops/templates/`.

**Authentication to Azure is workload identity federation** — the service connection exchanges a short-lived OIDC token for an Azure access token. There is **no client secret**: nothing to rotate, nothing to expire at an inconvenient moment, and nothing to exfiltrate from a pipeline log. This is the single most important line in this ADR.

**One service connection per environment**, each bound to its own Entra app registration with RBAC scoped to that environment's resource group only. The staging connection has no permissions on the production subscription at all, which converts "the pipeline deployed to the wrong environment" from an incident into a permission error.

**Deployment is imperative from the pipeline** (`az deployment group create` for Bicep, `az containerapp` for revisions) rather than pull-based GitOps. Every infra apply is preceded by `az deployment group what-if`, whose output is attached to the run — the difference between updating a Container App and replacing a database is one Bicep property, and you want to see it before it happens.

**Environments** are Azure DevOps environment resources carrying the approval and check configuration, so gates live in the platform rather than in YAML a pull request could edit.

## Consequences

**Positive.** No cloud credential exists to leak, and cross-environment blast radius is bounded by RBAC rather than by convention. Approvals, business-hours windows, and audit history are first-class rather than bolted on. The affected graph keeps pull-request feedback proportional to the change. Variable groups link to Key Vault, so pipeline secrets are references and never literals. Azure DevOps also brings Boards and Repos if the organisation wants one tool, and its Azure integration — service connections, environment tracking, deployment history per environment — is tighter than a third-party CI's.

**Negative.** The YAML dialect is idiosyncratic: `stageDependencies` output variables, `dependsOn` semantics, and template expression evaluation order are all things engineers have to learn, and the error messages are unhelpful. The marketplace is smaller than GitHub Actions'. Self-hosted agents are needed for private-endpoint deploys, which is one more thing to patch. And there is real friction if the source of truth is GitHub: Azure Repos or a mirror, neither of which is free of annoyance.

**The genuine loss is drift detection.** Push-based deployment does not continuously reconcile, so a manual portal change in production is not automatically reverted the way Argo CD or Flux would revert it. Two mitigations, and they are partial rather than complete: `what-if` runs on a nightly schedule against production and alerts on any non-empty diff, and Azure Policy denies the write operations that would cause the most damaging drift. That is weaker than continuous reconciliation, and it is the cost of this decision.

**Neutral.** Because the pipeline's Validate and Build stages are platform-agnostic and only the deploy template is Azure-specific, the [ADR-0010](0010-container-apps-now-aks-as-the-exit.md) migration to AKS changes one template (`az containerapp` → `helm upgrade`) and nothing else.

## Alternatives considered

**GitHub Actions plus Argo CD (the original assumption).** Better ecosystem, better YAML, and genuine pull-based reconciliation with drift correction. Rejected primarily because Argo CD implies a Kubernetes cluster, which [ADR-0010](0010-container-apps-now-aks-as-the-exit.md) declines to adopt yet — GitOps for Container Apps means a bespoke controller or a third-party tool, which is worse than push. Worth revisiting *together with* the AKS migration: Actions plus Flux would be a coherent pairing at that point, and the deploy template is the only thing that would change.

**GitHub Actions with OIDC deploying directly to Azure.** A close second, and the federated-identity story is identical. Rejected on the deployment-gate surface: Actions' environment protection rules are less expressive than Azure DevOps environments for business-hours windows and multi-approver policy, and the deployment-history-per-environment view genuinely helps during an incident.

**Azure Deployment Environments / `azd`.** Excellent for the inner loop and for spinning up ephemeral per-branch environments, which is a real gap in this design worth closing later. Rejected as the primary CD mechanism because it is not built for gated production promotion with canary increments.

**Jenkins.** Rejected: a server to operate, plugin drift, and no advantage over either managed option.

**A single-stage pipeline that builds and deploys everything on every commit.** The status-quo-by-accident option. Rejected on the arithmetic — ten images plus full test suites on every pull request is roughly 40 minutes, and a pipeline slower than an engineer's patience is a pipeline that gets bypassed.
