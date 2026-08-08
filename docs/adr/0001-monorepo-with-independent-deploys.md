# ADR-0001 — Monorepo with independently deployable services

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** Platform, Staff Engineers
- **Supersedes:** —

## Context

The codebase will be worked on by 10–20 engineers across roughly six teams, spanning ten backend services and a React portal. All of them share event and API contracts — `CheckoutCompletedV1` alone is produced by one service and consumed by four.

The two conventional answers pull in opposite directions. A repository per service maximises team autonomy but makes shared-contract changes a multi-repository, multi-PR, ordered-merge exercise with a window in which services disagree about the contract. A single repository with a single deployable removes that problem but couples every team's release to every other team's readiness.

We need contract changes to be atomic and deploys to be independent. Those are usually presented as a trade-off; they are not, because the coupling that actually hurts is *deployment* coupling, not *repository* coupling.

## Decision

One repository containing all services, the frontend, shared packages, mocks, tests, and infrastructure. Each service remains an independently built, independently deployed artefact with its own Dockerfile, Helm chart, and pipeline.

Coordination is managed by four mechanisms:

- **pnpm workspaces + Turborepo** with an affected-graph so CI builds and tests only what a change touches, keeping pipeline time proportional to the change rather than to the repository.
- **CODEOWNERS** routing review to the owning team automatically, so "everyone can edit everything" does not become "nobody reviews anything".
- **Lint-enforced boundaries** banning cross-service source imports, so proximity does not become coupling.
- **Expand–migrate–contract schema changes and additive-only event evolution**, so any two adjacent versions of any two services are compatible and deploy order never matters.

## Consequences

**Positive.** A breaking contract change is one atomically reviewable pull request in which CI type-checks every consumer before merge — the failure becomes visible at review time instead of at 3 a.m. A new engineer runs the entire system with `make bootstrap && make up`. Cross-service refactors are mechanical. Tooling, lint config, and TypeScript settings are uniform, so no team is stranded on an old toolchain.

**Negative, and mitigated.** CI could become slow — handled by the affected graph and remote caching. Accidental coupling is easier to write — handled by the lint rules, which fail the build. The repository grows large — handled by shallow clones and sparse checkout in CI. Git history is noisier across teams — accepted; path-scoped log and blame make it a non-issue in practice.

**Neutral.** This decision is reversible in one direction only: splitting a monorepo into polyrepos later is straightforward (each service already has its own build and chart), while merging polyrepos is not. Starting merged is the lower-risk order.

## Alternatives considered

**Repository per service.** Rejected primarily on the contracts problem. The secondary cost was worse: with 20 engineers and ten services, keeping tooling and shared library versions aligned across ten repositories becomes a standing tax that nobody owns.

**Monorepo with a single deployable (modular monolith).** Genuinely attractive at this scale and would be the right answer for a smaller team. Rejected because payment-service has a distinct compliance posture and blast-radius requirement, and because consumer workloads need to scale on queue depth independently of the HTTP tier. A modular monolith would force those to scale together.

**Polyrepo with a published contracts package.** This is the compromise many teams reach, and it does work, but it converts every contract change into a publish-then-upgrade cycle with a period of version skew. Given how central `packages/contracts` is here, that cycle would be paid weekly.
