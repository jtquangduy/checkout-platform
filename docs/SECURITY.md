# Security

> Multi-tenant SaaS that moves money on behalf of brands. Two properties matter above all others: **one tenant must never see another's data**, and **money must never move without authorisation**.

---

## 1. Threat model

Threats are listed in the order I would actually prioritise them, which is by expected cost rather than by how interesting they are.

| # | Threat | Realistic impact | Primary control |
|---|---|---|---|
| 1 | **Cross-tenant data access** | Contract-ending. Studios' unreleased campaign imagery is embargoed material | `tenantId` from token only, injected by `TenantScopedRepository`; lint rule bans raw model access ([§3](#3-multi-tenant-isolation)) |
| 2 | **Payment manipulation** | Direct financial loss | Amount never accepted from the client; re-derived from the immutable snapshot; integrity hash verified before capture ([§4](#4-protecting-the-money-path)) |
| 3 | **Unreleased asset leakage** | Legal exposure for the client, reputational for us | Short-lived short-lived SAS URLs, tenant-prefixed keys, no public buckets |
| 4 | **Credential compromise** | Account takeover → fraudulent orders | Argon2id, MFA for privileged roles, short-lived tokens, anomaly detection |
| 5 | **Broken authorisation (IDOR)** | Cross-tenant read/write | Authorisation enforced *inside each service*, not only at the gateway |
| 6 | **Webhook forgery** | Fake "payment succeeded" → free work | HMAC signature + timestamp + replay cache; never trust a webhook body alone |
| 7 | **Supply-chain compromise** | Arbitrary code in a payment service | Lockfile integrity, provenance attestation, Trivy/Snyk gates, pinned base images |
| 8 | **Insider / operator error** | Data exposure or corruption | Least privilege, audited ops endpoints, no production DB shell access by default |
| 9 | **DoS / noisy neighbour** | One tenant degrades others | Per-tenant rate limits, quotas, per-dependency bulkheads |
| 10 | **PII/GDPR mishandling** | Regulatory | Data minimisation, retention policies, right-to-erasure job |

The first two get disproportionate attention because they are the ones where a single missing line of code is catastrophic rather than merely bad.

---

## 2. Authentication

**Tokens.** RS256 JWTs, 15-minute access tokens, 30-day rotating refresh tokens. Signing keys are HSM-backed in Azure Key Vault, non-exportable, and rotate every 90 days; services verify against a cached JWKS endpoint keyed by `kid`, so key rotation needs no coordinated deploy and — more importantly — **the hot path never calls identity-service**. A synchronous auth check on every request would make identity-service a single point of failure for the entire platform.

```jsonc
// Access token claims. Everything authorisation needs is here, so verification
// is local and cheap.
{
  "iss": "https://auth.example.com", "aud": "customer-portal",
  "sub": "usr_01JBQ8SOFIAMARIN00000000",
  "tid": "ten_01JBQ0000000000000000000",   // ⭐ tenant — the ONLY source of truth
  "roles": ["ART_DIRECTOR"],
  "scp": ["orders:read", "orders:write", "checkout:create", "invoices:read"],
  "amr": ["pwd", "otp"],                    // how they authenticated — MFA visible
  "sid": "ses_01JBQ…",                      // session id, for targeted revocation
  "iat": 1786000000, "exp": 1786000900, "jti": "jwt_01JBQ…"
}
```

**Refresh token rotation with reuse detection.** Each refresh issues a new token and invalidates the old one. Presenting an already-used refresh token means it was stolen, so the entire token family is revoked immediately and the user is notified — this converts a silent, long-lived compromise into a detected, terminated one.

**Passwords and MFA.** Argon2id (64 MB, 3 iterations, parallelism 4), never bcrypt at a low cost factor. Passwords are checked against the Have I Been Pwned k-anonymity API on set, which stops credential reuse far more effectively than composition rules. TOTP MFA is mandatory for `FINANCE`, `TENANT_ADMIN`, `PLATFORM_OPS`, and `PLATFORM_ADMIN` — every role that can move money or see everything — and optional but encouraged for `ART_DIRECTOR`. Failed logins use exponential lockout keyed on both account and IP, so neither dimension alone can be used to lock legitimate users out.

**Service-to-service.** East-west calls carry a short-lived (5-minute) service token issued by identity-service to a workload identity, plus a propagated `X-User-Context` header carrying the original caller's tenant and roles. The user context alone is never trusted for authentication — it is signed and only accepted from within the mesh — but it is what allows an internal service to make a tenant-correct authorisation decision rather than assuming any internal call is legitimate. Production adds mTLS via the service mesh, so a compromised pod cannot impersonate another service.

**Revocation.** Short token lifetimes mean revocation is mostly a matter of waiting 15 minutes, which is the right default. For urgent cases (compromise, termination) a Redis deny-list keyed on `jti` and `sid`, checked at the gateway, gives immediate revocation without reintroducing a per-request database lookup.

---

## 3. Multi-tenant isolation

This is the control I would defend most strongly, because the usual approach — "remember to filter by tenant" — fails eventually with certainty. Twenty engineers writing thousands of queries over several years will produce a missing predicate; the design has to make that impossible rather than unlikely.

**Tenant comes only from the verified token.** It is never read from a request body, query parameter, or header. If a client supplies a `tenantId` that differs from the token's, the request is rejected and a security event is logged — that pattern is either a bug or an attack, and both need investigating.

**The context is ambient and non-optional.** `AsyncLocalStorage` carries tenant, user, roles, and correlation id for the request's whole lifetime, including across awaits and into event publishing, so nothing has to be threaded manually through fifteen function signatures (which is how it gets dropped).

**The repository injects the filter.** Every data access goes through `TenantScopedRepository`, which merges `tenantId` into every filter from the ambient context. A developer using the repository cannot write an unscoped query, and a developer bypassing the repository fails the lint rule and the build.

```ts
// packages/kernel/src/mongo/tenant-scoped.repository.ts
export abstract class TenantScopedRepository<T extends TenantScoped> {
  protected constructor(protected readonly col: Collection<T>) {}

  /** The ONLY way to build a filter. tenantId is not a parameter, so it cannot
   *  be forgotten, and it is taken from the verified token, so it cannot be
   *  spoofed. */
  private scoped(filter: Filter<T> = {}): Filter<T> {
    const tenantId = RequestContext.tenantId();
    // Fail closed. A missing tenant means a bug in context propagation, and the
    // correct response to "I don't know whose data this is" is to refuse.
    if (!tenantId) throw new MissingTenantContextError();
    // Spread OUR value last so a caller-supplied tenantId can never win.
    return { ...filter, tenantId } as Filter<T>;
  }

  findOne(filter: Filter<T> = {}) { return this.col.findOne(this.scoped(filter)); }
  find(filter: Filter<T> = {})    { return this.col.find(this.scoped(filter)); }
  updateOne(filter: Filter<T>, u: UpdateFilter<T>) {
    return this.col.updateOne(this.scoped(filter), u);
  }

  /** Cross-tenant access exists for exactly two callers — the reconciliation job
   *  and the ops console — and it is explicit, audited, and greppable. */
  protected unsafeCrossTenant(reason: CrossTenantReason) {
    audit.log('CROSS_TENANT_ACCESS', { reason, actor: RequestContext.userId() });
    return this.col;
  }
}
```

**Defence in depth beyond the repository.** `tenantId` leads every compound index, so an unscoped query is not merely wrong but slow enough to notice. Asset blob paths are prefixed `ten_<id>/`, and every user-delegation SAS is scoped to that prefix and expires in 15 minutes, so an object cannot be requested outside its tenant or replayed a day later. Cache keys are tenant-prefixed, preventing cross-tenant cache poisoning. A cross-tenant `404` is returned rather than `403`, so existence is not disclosed. And integration tests seed two tenants and assert that every endpoint returns `404` for the other's resources — a test suite that runs on every pull request.

---

## 4. Protecting the money path

Four properties, each with a mechanism rather than a policy.

**The client cannot set the amount.** `CreateCheckoutSessionRequest` has no chargeable amount field; it has `expectedTotal`, which is a *guard*. The charged amount is always re-derived server-side from `order.pricingSnapshot`, and a mismatch yields `422 PRICE_MISMATCH` instead of a charge. `.strict()` on the zod schema means an attacker adding an `amount` field gets a `400`, not a silently ignored field.

**Pricing integrity is verified before every capture.** The snapshot carries a SHA-256 hash over its lines and totals; it is recomputed and compared immediately before capture. A tampered or corrupted snapshot fails loudly ([DATA-INTEGRITY §8](DATA-INTEGRITY.md#8-monetary-correctness)).

**Authorisation is checked inside the service, not only at the gateway.** The gateway does a coarse role check for fast rejection, but the real decision — does this user, in this tenant, have `checkout:create`, and does this order belong to them — happens in checkout-orchestrator. A gateway-only model means one misconfigured route or one internal call from a compromised service becomes a financial incident.

**High-value orders require a second approver.** Tenant-configurable (`settings.requireApprovalOverMinor`, default £5,000); the checkout is blocked until a second user with `PRODUCER` or `TENANT_ADMIN` approves. This is a control against both fraud and expensive mistakes, and studios ask for it.

Alongside those: refunds require `FINANCE` plus a written reason and are fully audited; payment method changes trigger an email to the tenant admin, so an attacker cannot quietly swap the card; and velocity rules flag anomalies (a tenant's first order above 10× their historical average, or more than five declines in ten minutes) for review rather than blocking automatically.

---

## 5. PCI DSS scope

Scope reduction is the whole strategy. **Card data never touches our servers.** The portal tokenises directly with the PSP's JS SDK — the PAN goes from the browser to the PSP and we receive only an opaque token. We store the token reference, brand, last4, expiry, and country, which are permitted, and nothing else.

This keeps us at **SAQ-A**, the lightest self-assessment level, instead of SAQ-D, which would mean quarterly ASV scans, annual penetration testing of the cardholder environment, network segmentation, and a substantially larger audit. The engineering cost of the tokenisation approach is a few hours; the compliance cost avoided is measured in months.

Structural enforcement rather than policy: the API schemas have no field capable of accepting a PAN; a lint rule bans regex patterns matching card numbers in service code; the logging redactor strips anything resembling a PAN, CVV, or token before serialisation; and `providerRawResponse` is stored redacted with a 90-day retention for dispute evidence. PSP webhooks are HMAC-verified with a timestamp window and a replay cache, and — the important part — **a webhook never grants a state change on its own authority**. It triggers a verification call to the PSP's API, so a forged "payment succeeded" webhook achieves nothing.

---

## 6. Application security

**Input validation** with zod at every boundary: HTTP requests, event payloads, webhook bodies, and environment configuration. `.strict()` everywhere, so unknown fields are a `400` rather than a silent ignore — mass-assignment vulnerabilities are impossible when the schema is the allow-list.

**Injection.** Mongoose parameterises queries, and `sanitizeFilter` is enabled so a `{$ne: null}` in a query parameter cannot become an operator. Any user string used in a regex goes through `escapeRegex` — relevant because search does use anchored prefix regexes, so this is a real path rather than a theoretical one. No `eval`, no dynamic `require`, and a Node permission model restricting filesystem access.

**Output.** React escapes by default and `dangerouslySetInnerHTML` is banned by lint, except for the one place it is needed — search highlighting — where the value is sanitised with DOMPurify. A strict CSP with nonces, no `unsafe-inline`, HSTS with preload, `X-Content-Type-Options`, and a restrictive `Referrer-Policy` and `Permissions-Policy`, all set by Helmet with explicit configuration rather than defaults.

**API documentation** is treated as attack surface rather than as marketing. Swagger UI's interactive console is disabled in production — a "Try it out" button next to `POST /checkout-sessions` on a live payments API will eventually charge a real card — and the spec itself, while not secret, is auth-gated in production because it enumerates every endpoint, parameter and error code. Per-service docs are mounted on the internal metrics port, which is never publicly routable, so they are off the public surface by default rather than by remembering to disable them ([API §6.3](API.md#63-where-it-is-exposed-and-where-it-is-not)).

**Rate limiting** is per tenant and per user in a sliding Redis window, tightest on the expensive and abuse-sensitive endpoints: 20/min for checkout, 10/min for login, 300/min for search. Rate limiting **fails open** if Redis is unavailable, with an alert — dropping legitimate paying customers to enforce a limit is a worse business outcome than briefly tolerating abuse, and this trade-off is stated explicitly so it is a decision rather than an accident.

**Secrets** are Azure Key Vault references resolved at revision start by each service's own user-assigned managed identity — the value never reaches Bicep, a pipeline log, or `az containerapp show`. Key Vault has soft-delete, purge protection, RBAC authorisation, and a private endpoint. There is no `.env` in any real environment, and config is validated by zod at boot so the process refuses to start on invalid or missing values rather than failing obscurely under load. Gitleaks runs pre-commit and in CI.

**Supply chain.** `pnpm install --frozen-lockfile` with integrity checking, Dependabot on a weekly cadence, Trivy and Snyk gating on CRITICAL/HIGH, SBOM generation and SLSA provenance attestation on every build, distroless non-root images with pinned digests, and no `postinstall` scripts allowed without review — which is the vector most likely to be used against a payments codebase.

---

## 7. Audit logging

Every security- and money-relevant action is written to an append-only audit log with a full actor, target, and outcome — separate from application logs, retained seven years, and immutable — a Blob Storage container with a time-based immutability policy (WORM), which no operator or service principal can shorten. The list of audited events is deliberately specific: authentication (success, failure, MFA, lockout, refresh reuse), authorisation denials, every checkout and payment action including declines and refunds, invoice issue and credit notes, payment-method changes, role changes, cross-tenant access, ops actions such as DLQ replay and saga force-compensation, and any data export or erasure.

```jsonc
{
  "eventType": "CHECKOUT_INITIATED",
  "occurredAt": "2026-08-07T10:31:00.489Z",
  "actor": { "type": "USER", "id": "usr_01JBQ…", "email": "sofia@nikestudio.example",
             "ip": "203.0.113.42", "userAgent": "Mozilla/5.0…", "sessionId": "ses_01JBQ…" },
  "tenantId": "ten_01JBQ…",
  "target": { "type": "Order", "id": "ord_01JBQ…", "name": "Nike SS26 Apparel — Batch 04" },
  "action": "CREATE_CHECKOUT_SESSION",
  "outcome": "SUCCESS",
  "details": { "amount": { "amount": 163020, "currency": "GBP" },
               "paymentMethodRef": "pm_01JBQ…", "sessionId": "cko_01JBQ…" },
  "correlationId": "req_01JBQ…"   // joins the audit log to traces and logs
}
```

Audit logs are the primary artefact in a payment dispute, so they record *attempts and denials* as well as successes — a log that only contains what worked cannot answer "did someone try?".

---

## 8. Privacy and data protection

Encryption in transit is TLS 1.3 externally and mTLS between services; at rest it is AES-256 on Azure managed disks, Blob Storage, and Atlas, with client-side field-level encryption for the few genuinely sensitive fields (MFA secrets, mandate evidence) so they are unreadable even to a database administrator.

Personal data is minimised by design: we store business contact details, not consumer PII, and no card data at all. Emails are stored as hashes where only matching is needed (suppression list) and in cleartext only where sending requires it. Notification bodies are stored as a hash plus a rendering context rather than the full body.

Retention is defined per data class rather than left implicit: operational data for the contract term plus 90 days, invoices and payment records for seven years (statutory), audit logs seven years, application logs 30 days, traces 7 days, `processed_messages` 30 days, and published outbox rows 7 days. Right-to-erasure is implemented as a job that anonymises the user record and their references while **preserving invoice and payment data**, which is a legal-basis conflict resolved in favour of the statutory retention requirement — documented so the decision is defensible rather than accidental. Every tenant can export their own data through a self-service endpoint.

---

## 9. Verification

Security claims need evidence, so the controls above are checked continuously rather than asserted. In CI: SAST (CodeQL, Semgrep with custom rules for our tenant-scoping and money-handling patterns), dependency and container scanning, secret scanning, and an IaC scan (Checkov plus the Bicep linter) on the infrastructure templates. In the test suite: cross-tenant access tests against every endpoint, authorisation matrix tests for every role and route combination, negative tests asserting that a client-supplied `amount` or `tenantId` is rejected, and webhook forgery tests asserting an unsigned or replayed webhook changes nothing.

Beyond automation, an annual third-party penetration test with remediation tracked to closure, a quarterly access review of production and privileged roles, and a written incident response plan that has actually been rehearsed — including the specific runbooks for a suspected double charge and a suspected cross-tenant leak, because those are the two incidents this system is most likely to have and the worst two to improvise.
