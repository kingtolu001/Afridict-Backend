# Afridict delivery plan

Status: phases 1-11 have synthetic engineering foundations; Phase 9 execution scope is complete. Specialist approvals and production integration remain open.
Updated: 15 September 2026. Fourteen total phases. Completed phase numbers are historical and are not renumbered.

## Baseline and collaboration

The supplied Project Definition v1.1 and Technical Architecture v1.1 define the working product baseline. The Backend Engineer Persona v1.1 and Systems Architect Persona v1.2 provide supporting role context. Their leadership-review status does not establish legal, security, custody, or launch approval.

The complete production programme includes consumer markets, binary/categorical/scalar structures, primary CLOB, bounded AMM, institutional RFQ, governed resolution, administration, developer access, partners, data products, and Robinhood Chain settlement. Delivery order does not remove capabilities from the production readiness gate.

Repository-owned architecture, setup and ADR documents are reviewed through pull requests. Supplied source documents remain external and are not republished. Commit messages describe the change, without phase labels or AI attribution.

The backend owns API contracts, server implementation, authorization, financial correctness, integration environments, examples, and contract verification. The frontend developer owns screens, interaction, accessibility, and client integration. Both review public contracts before implementation. Do not select a frontend framework for the frontend developer.

## Delivery sequence

Each phase ends with reviewable outputs and evidence. Estimates follow workload and staffing decisions; these phases are not calendar promises. Independent work may overlap once its input contracts are stable.

| Phase | Backend and architecture output | Frontend handoff | Exit evidence |
| --- | --- | --- | --- |
| 1. Financial decisions and API foundation | Authority matrix; decision register; custody/escrow options and recommendation; chart of accounts; payout mathematics; reservation and settlement state machines; API conventions | OpenAPI conventions, state vocabulary, error shape, exact amount format, domain map | Review records identify approved decisions and unresolved blockers; financial examples balance; no assumed custody or legal approval |
| 2. Service and delivery foundation | Runtime decision; modular domain layout; local PostgreSQL; migrations; CI; configuration and secrets boundaries; request IDs; audit/outbox/inbox primitives; docs rendering and contract checks | Runnable local environment, interactive API reference, mock server, generated TypeScript types, sample environment | Clean setup works; CI validates contracts; migration and recovery rehearsal; no production credentials |
| 3. Identity, eligibility, and scoped access | Authentication adapter; accounts; policy decisions; user/admin authorization; maker-checker primitive; session and recovery integration boundaries | Onboarding, session, eligibility, access-denied, recovery and role-aware UI contracts | Authorization and cross-account tests; approval separation; safe errors and audit records; provider decisions documented |
| 4. Market governance and discovery | Generalized market schemas; templates; draft/review/publish lifecycle; immutable policy hashes; external proposal intake; catalog and evidence metadata | Market list/detail, filters, pagination, market type display, admin drafts and approvals; synthetic fixtures for all structures | Publication requires eligibility, complete resolution policy, distinct approver, and approved template; lifecycle and immutability tests |
| 5. Ledger, custody integration, and funding | Append-only balanced journals; shared reservations; smart-account integration; deposit/conversion/withdrawal state machines; partner adapters and reconciliation | Available/reserved/pending balances, deposit intents, withdrawal status, fees and statements; retry examples | Duplicate and concurrent money-flow tests; partner/chain/ledger reconciliation; pending funds cannot be spent; approved custody model before real integration assumptions |
| 6. Contact identity and capabilities | Native registration/session contract; direct Google OAuth; email/phone verification behind Twilio ports; SendGrid events; normalized Persona identity; action-based capability policy, audit and abuse controls | Registration, password and Google entry, email/phone code flow, identity status, `GET /v1/me/capabilities` and blocked-action reasons | Credential lockout and recovery tests; verified contact journey; duplicate/timeout/out-of-order tests; NGN withdrawal denied without verified identity; no provider secret or raw KYC in browser/API |
| 7. NGN wallets and SwervPay rails | Distinct NGN and USD ledger accounts/projections; SwervPay behind fiat provider port; deposit instructions, bank resolution, payouts, verified webhooks, independent reconciliation and compensations | NGN/USD wallet views, deposit and payout states, bank selection, exact fees and safe retry behavior | Provider contract and commercial approval validated; duplicate-event and lost-response tests; one ledger effect; no money credited from client assertion |
| 8. CLOB admission and deterministic execution | Order journal, price-time matching, signed admission, shared collateral, partial fills, cancels, fees, halts, replay and recovery | Order/cancel/status API, order book and private account feeds with sequence/resume rules | Deterministic replay; cancel/fill and concurrent-order races; no fill beyond reserved collateral; measured load/failover |
| 9. AMM and institutional RFQ | Bounded liquidity router, inventory/subsidy/loss controls, entity workflows, signed quotes, expiry and limits on shared financial controls | Quote preview, execution route, slippage, RFQ lifecycle and institutional exposure | Combined CLOB/AMM/RFQ/withdrawal concurrency; expired quotes rejected; loss caps and manipulation controls |
| 10. Resolution, disputes and redemption | Evidence adapters/archive; bonded proposals; challenges; recusals/quorum; adjudication; timelock; invalid/cancelled payouts and redemption | Evidence timeline, challenge status, governed outcome and payout breakdown | Source outage/correction rehearsals; payout conservation for every market type; no early redemption or outcome mutation |
| 11. Robinhood Chain settlement | Approved smart-account/custody interfaces; multi-RPC indexing, nonce/submission, reorg/finality, settlement batches, contracts, reconciler and recovery | Provisional versus finalized execution, chain transaction and withdrawal status | Independent finality and reorg tests; submitted hash never treated as settlement; chain/ledger/partner claims reconcile |
| 12. Realtime, developer, partner and data products | Sequenced WebSocket feeds; API keys/OAuth, scopes, quotas, metering/billing, signed webhooks, sandbox, history/probability quality, widgets, TS/Python/Go SDKs and ABI packages | Realtime order, trade, position and resolution updates; developer portal, usage/log views, sandbox and partner examples | Sequence recovery and authorization; SDK/webhook compatibility; replay protection; environment isolation; quotas; history reconciles with canonical events |
| 13. Operational assurance | Exception console, surveillance, treasury controls, scoped pauses, observability, backup/DR, key/upgrade governance, provider outage drills, runbooks and security reviews | Admin queues, audit views, incident banners, support and responsible-use contracts | Critical/high findings closed; recovery/dispute game days; privacy/accessibility review; load at 3x approved launch peak |
| 14. Controlled activation and operation | Country pack, partner readiness, release/migration rehearsal, signed artifacts, canary/exposure limits, launch decision and incident ownership | Stable release contract, production config, release notes, support and rollout checks | Every production capability passes legal/security/operations gates; finance reconciles; monitored canary before limits expand |

## Dependencies and parallel work

- Phase 1 defines financial semantics before phases 5-8 implement them. Phase 2 supplies infrastructure used by all services.
- The frontend can begin against reviewed synthetic contracts during phases 2-4. It need not wait for live payments or chain settlement.
- Protocol design and security analysis start in phase 1. Contract implementation proceeds alongside the backend once custody, payout and settlement invariants are reviewed.
- Legal classification, country selection, evidence-source diligence, collateral/partner selection, staffing and liquidity budgets start immediately under human owners. They block affected integration and activation decisions, not local contract and simulation work.
- Developer access, admin authorization, audit and observability apply from the first feature. Their later phases complete the product and assurance scope rather than introduce these controls late.

## Frontend API delivery agreement

The versioned OpenAPI file is the HTTP contract. Put descriptions, examples, schema constraints, request/response headers, authorization and deterministic errors directly in it. Publish rendered documentation when the service foundation exists. Describe WebSocket channels and message/replay semantics separately using an event contract; OpenAPI is not the complete WebSocket protocol description.

Every operation must include:

1. Stable operationId, purpose, actor, scopes and resource-level authorization rules.
2. Request schema and success/error responses, with realistic synthetic examples.
3. Exact money/quantity/price units, precision, rounding policy, timestamps and nullability.
4. Pending and terminal states, polling/reconnect behavior, and what acknowledgement proves.
5. Idempotency scope, payload-equivalence rule, retention, concurrent retry handling, and conflicts where applicable.
6. Pagination/filter/sort semantics and quotas where applicable.
7. Request IDs and safe error codes with frontend recovery guidance.
8. Mock fixtures and generated TypeScript types, followed by implementation conformance tests.

Mocks must be labelled synthetic. No production URL or credential is invented. OpenAPI changes are reviewed before a frontend developer depends on them. CI must reject invalid schemas, incompatible released-contract changes, and server responses that drift from the contract. Breaking changes require a new version or an explicit unreleased-contract agreement; deprecation periods remain to be approved.

Shared frontend scenarios include empty/loading/forbidden states, expired sessions, insufficient collateral, market suspension, partial fills, pending settlement, provider outages, disputed outcomes, failed withdrawals, and safe retry after a lost response.

## Decisions and conflicts to close

| Decision | Proposed direction or issue | Accountable reviewers | Blocks |
| --- | --- | --- | --- |
| Custody and collateral locks | Embedded self-custody is proposed; define escrow rights and enforce reservations across all execution and withdrawal paths | Architect, protocol, security, counsel | Final vault and money-moving design |
| Financial authority | Distinguish workflow, trading journal, financial ledger, partner statements, chain observations and finalized chain records | Architect, backend, finance | Journal and settlement implementation |
| Payout model | Define scalar payout vectors, invalid/cancelled outcomes, integer units, fees and dust conservation | Protocol, finance, market integrity | Generalized contracts and redemption |
| Emergency action authority | Source documents allow immediate scoped guardian pause; pasted request broadly requires dual approval for emergency actions | Security, governance | Emergency authorization implementation |
| Durability | Sub-minute generic RPO does not specify loss tolerance for acknowledged financial commands; define zero-loss requirement within an explicit failure envelope | Architect, platform, finance | Production admission and DR design |
| Economic identity | Transaction hash/log index identifies observations, not a replacement-safe economic effect | Backend, protocol, finance | Reorg-safe postings |
| Finality and infrastructure | Verify chain configuration, finality model, provider independence, supported collateral, AA and operational limits from primary evidence | Protocol, platform | Chain adapters and activation |
| Country/partners | First country, legal route, payment/conversion obligations, chargeback exposure and collateral remain unapproved | Leadership, counsel, finance | Real-money activation |
| Workload/runtime | Select backend runtime after financial prototype and team constraints; measure hot-market and shared-account contention | Architect, backend, platform | Capacity commitments and service extraction |

## Completion and release rules

A feature is complete only when its contract, implementation, relevant migrations, authorization, audit evidence, failure behavior, reconciliation, observability and required tests agree. Frontend integration is verified against the same contract. Do not mark a phase complete based on scaffolding or mocks.

Use expand/contract database changes and rehearse upgrades on representative data. Application rollback must remain compatible with migrated data. Financial recovery uses authorized compensating entries, never history edits. Contract migrations and finalized outcomes do not have ordinary application rollback semantics.

Review decisions when legal requirements, custody assumptions, chain behavior, workload, provider capability or threat evidence changes. No production deployment, treasury movement, key change, contract upgrade or final outcome action occurs merely because code is merged.

## Current progress

- Phase 1 engineering outputs: financial authority, ledger/reservation/payout reference mathematics and decision register in `docs/FINANCIAL_ARCHITECTURE.md`; specialist custody, accounting, legal, payout and finality approvals remain open.
- Phase 2 engineering outputs: TypeScript/Fastify service, PostgreSQL migration, transactional idempotency/audit/outbox/inbox primitives, CI, Docker build, generated OpenAPI/types and local interactive documentation. Real PostgreSQL runs in CI; local smoke tests used embedded PostgreSQL because Docker Desktop was unavailable.
- Phase 3 engineering outputs: Afridict-owned password credentials and revocable opaque sessions, direct Google OAuth with explicit subject linking, self-service account creation, server-owned roles, session/eligibility reads and two-actor compliance decisions. Privileged MFA, production recovery delivery, global abuse controls and privileged account provisioning remain operational gates.
- Phase 4 engineering outputs: generalized market drafts, source and policy registries, external proposal intake/adoption/rejection, independent reviews, immutable publication, public catalog/evidence-policy APIs and synthetic fixtures for all three structures. Real country/category/source approvals and chain market creation remain open; publication cannot activate trading.
- Phase 5 engineering outputs: append-only balanced journal enforcement, one owner/asset reservation authority, synthetic deposit/withdrawal state machines, signed partner webhook verification, configured-finality observations, user balances/statements and finance reconciliation with owned exceptions. Production financial mode remains disabled until custody, collateral, partner, finality and country approvals close; stored-observation reconciliation is not independent partner/chain proof.
- Phase 9 engineering outputs: deterministic CLOB, bounded AMM and signed institutional RFQ execution share one collateral authority. RFQ entities require maker-checker approval, dealer quotes use approved Ed25519 keys, and fills enter positions, governed redemption and testnet settlement. Cross-path concurrency, expiry, signature, exposure and exactly-once tests pass. Production liquidity remains disabled.
- Phases 10-11 engineering outputs: evidence-backed disputes, independent quorum and timelocked redemption feed deterministic Robinhood Chain testnet claim batches with multi-observer finality and reorg handling. External source, RPC, signer, custody and contract deployments remain approval-gated.
- Local verification: `npm run check` passed 39 tests, type checking, linting, build and OpenAPI validation before contact-verification work moved to its feature PR. `npm run demo` served three synthetic published markets, interactive docs and persona-scoped identity responses.
- New confirmed provider and product decisions are recorded in `docs/PRODUCT_DECISIONS.md`. Phase 6 begins with a fail-closed capability foundation, then contact verification and Persona adapters after provider contracts and auth ownership are validated. Phase 7 introduces a separately accounted NGN wallet and SwervPay rails without treating NGN as finalized chain collateral.
- Realtime feed contracts and asset-scoped sequence recovery are complete. The NGN/USDT wallet foundation identifies exact USDT-BSC, exposes separate zero-inclusive wallet projections, verifies BSC deposit logs through a read-only observer, stores expiring evidenced conversion rates and atomically posts asset-balanced journals against ring-fenced inventory. One published event can now activate isolated NGN and USDT books across CLOB, AMM, RFQ, positions, resolution payout, realtime, and settlement. Developer access, durable deposit scanning, multiple-RPC/custody reconciliation, operational assurance and controlled activation remain. SwervPay, custody, legal, country and treasury approvals remain external activation gates.
