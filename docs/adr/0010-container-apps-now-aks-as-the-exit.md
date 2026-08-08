# ADR-0010 — Azure Container Apps now, AKS as the documented exit

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** Platform, SRE, Staff Engineers
- **Related:** [ADR-0003](0003-transactional-outbox-with-rabbitmq.md) (broker), [ADR-0012](0012-mongodb-atlas-on-azure.md) (data)

## Context

Ten stateless Node containers need somewhere to run on Azure. The earlier design assumed Kubernetes with Helm and GitOps, which was a reasonable default but was never argued for — it was assumed because microservices and Kubernetes travel together by habit.

Examining it properly, the workload's requirements are narrow. Consumers must scale on **broker queue depth**, because an I/O-bound consumer waiting on a slow upstream shows near-zero CPU while its queue grows — CPU-based autoscaling does nothing at exactly the moment scaling is needed. Peak is **15× the mean** during month-end crunch, so elasticity matters more than steady-state throughput. Deploys must support weighted canary traffic and graceful draining, because a saga interrupted mid-flight is a correctness concern. And the platform team is currently two engineers.

Equally important is what the workload does *not* need: custom CNI, service-mesh traffic policy, DaemonSets, operators, GPU scheduling, or StatefulSets. Every stateful component is a managed service.

## Decision

**Azure Container Apps** as the compute platform, using Consumption workload profiles plus one Dedicated D4 profile for the OTel Collector and long-running jobs. **AKS is recorded as an exit with explicit triggers**, not as an aspiration.

The properties that decided it:

- **KEDA is the scaling model, not an add-on.** The RabbitMQ queue-depth scaler the architecture requires is a native scale rule. On AKS this is the KEDA add-on plus a `ScaledObject` per consumer — the same behaviour, more moving parts.
- **Scale-to-zero.** The invoice and notification consumers cost nothing overnight. The first message of the morning pays a ~2 s cold start that no customer is waiting on, because they already have their `201`.
- **Revisions with weighted traffic** give canary deployment without a service mesh, and rollback is a weight change against a still-warm previous revision.
- **No control plane to operate.** No node pools, no cluster upgrades, no CNI, no cluster monitoring — the dominant recurring cost of Kubernetes at this team size.

Portability is preserved deliberately so the exit stays cheap: the images are plain distroless Node containers, config comes from the environment, logs go to stdout, `/health/live` · `/health/ready` · `/health/startup` and `/metrics` are exposed, and `SIGTERM` triggers a proper drain. Those are the twelve-factor properties that make a container run identically anywhere.

## Consequences

**Positive.** The scaling signal the architecture actually needs is native. Compute is roughly 15% of a ~$2.9k/month bill ([DEPLOYMENT §10](../DEPLOYMENT.md#10-cost)) and scales down between peaks. A two-person platform team ships features instead of patching nodes. Canary plus SLO-gated promotion works with no mesh. And onboarding is materially simpler — a new engineer reads one Bicep module rather than learning a cluster.

**Negative, and accepted.** Less control: no custom admission control, no CNI policy, and no ability to run privileged sidecars. Transport is encrypted inside the environment but there is no policy-enforcing mTLS, so the mesh-grade guarantee in [SECURITY §2](../SECURITY.md#2-authentication) is aspirational until AKS. Container Apps' abstractions occasionally leak in ways a cluster's do not, and debugging a platform-level oddity means a support ticket rather than `kubectl`.

**The real cost, stated plainly.** Container Apps is a **poor host for RabbitMQ**: quorum queues need durable, node-pinned, low-latency disk and stable peer identity, and Container Apps offers ephemeral storage with interchangeable replicas. Self-hosting the broker there would risk message loss on a replica move, which is unacceptable in a system whose central promise is that a paid customer's job is never lost. The consequence is that the broker becomes **managed RabbitMQ (CloudAMQP)** in the same region over Private Link — unchanged AMQP semantics, unchanged application code, but a vendor and a line item we would not have on AKS.

**Neutral.** The exit is genuinely cheap because it was designed to be: images unchanged, application code unchanged, Validate and Build pipeline stages unchanged, all non-compute Bicep reused. What must be built is Helm charts (the scale rules and probes map near one-to-one onto a `Deployment` plus a `ScaledObject`), the KEDA add-on, Key Vault CSI or Entra Workload ID in place of native secret references, an ingress controller, and node-pool operations. Two to three weeks of platform work, available on demand.

**Migration triggers**, any one of which opens the conversation: self-hosting RabbitMQ or another stateful component; needing policy-enforced mTLS; per-tenant network isolation beyond an environment boundary; compute spend passing ~$2k/month, where reserved node pools beat Consumption; a Kubernetes-only capability (operator, custom scheduler, GPU); or the platform team passing ~3 engineers, at which point cluster overhead stops being the dominant cost.

## Alternatives considered

**AKS from day one.** The strongest alternative, and the right answer at a larger team size or with a stateful component to host. Rejected because the capability gap is two to three weeks of work *available on demand*, while the operational cost of a cluster is paid every week starting on day one. Adopting a cluster to host one component — the broker — would be the tail wagging the dog when a managed broker exists.

**Azure App Service for Containers.** Simplest option and adequate for the HTTP tier. Rejected on the consumers: no queue-depth scaling and no scale-to-zero for background workers, so the architecture's primary scaling signal would have to be reimplemented with a custom autoscaler — reinventing KEDA badly.

**Azure Functions.** A natural fit for the event consumers specifically, with excellent broker triggers and true consumption billing. Rejected on uniformity: it would split the codebase into two runtime models with different local development, different observability wiring, and different deployment mechanics, for ten services of which only three are consumers. The hexagonal structure in [CODEBASE-STRUCTURE §3](../CODEBASE-STRUCTURE.md#3-inside-a-service-identical-everywhere) is worth more than the marginal billing gain.

**Azure Container Instances.** No autoscaling, no revisions, no ingress. Suitable for one-off jobs, not for services.

**Azure Service Fabric.** Mature and capable, but a shrinking ecosystem, a steeper learning curve than Kubernetes, and no advantage for stateless containers. Rejected without much deliberation.
