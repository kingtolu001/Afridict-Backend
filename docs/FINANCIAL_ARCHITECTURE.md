# Financial authority and implementation decisions

Status: engineering reference for review. Custody, payout governance, legal, collateral and chain-finality approvals remain open. Phase 5 implements a synthetic-only ledger and workflow proof; no real funds are moved.

## Decision and boundaries

Use a TypeScript/Fastify modular monolith for identity, policy, market-governance and financial workflow APIs, with PostgreSQL transactional storage. Runtime JSON schemas drive validation, OpenAPI and generated TypeScript client types. The Phase 5 financial core posts balanced append-only journals and serializes collateral reservations. Its payment and chain inputs are synthetic adapters, and production finance starts disabled. Keep trading execution and financial ownership behind modules that can later be extracted on measured fault-isolation or throughput requirements. This release does not create a matching engine or chain contracts.

Go remains a candidate for an extracted matching engine if deterministic benchmarks, GC behavior and team capability justify it. A distributed service per domain is rejected for the current empty repository: it would add failure modes before measurements exist. Runtime selection does not alter CLOB/AMM/RFQ scope.

| Fact | Authority | Derived copies and recovery |
| --- | --- | --- |
| Account authentication | Afridict password/session authority plus direct Google authorization linked by immutable subject | Account records and server-owned roles remain authoritative; Google email is never the identity key |
| Application roles and restrictions | Server-managed PostgreSQL account records | Read on every authenticated operation; provisioning has no public role-grant endpoint |
| Eligibility review | PostgreSQL maker-checker workflow and access-controlled evidence reference | No raw identity artifacts in API payloads, events or logs |
| Published market policy | Immutable versioned terms and canonical SHA-256 hash, later registered on chain | Reviews bind market version and hash; changes require a new reviewed market/version before publication |
| Order admission and matching order | Future durable per-market execution journal | Replica/cache replay must reproduce event ordering |
| Off-chain financial effects | Append-only double-entry ledger | User balances are projections, never editable fields |
| On-chain ownership and collateral | Finalized Robinhood Chain contract state | Receipts/indexers are observations until configured finality criteria pass |
| Partner fiat settlement | Partner's reconciled statement under contractual settlement rules | Signed webhooks initiate verification; they are not spendable collateral |
| Resolution evidence | Content-addressed preserved evidence plus published source hierarchy | A fetched API value cannot independently authorize payout |

## Custody and reservation recommendation

Recommend user-attributed contract escrow behind embedded self-custody smart accounts. Reserve only finalized, eligible, unencumbered collateral. An enforced withdrawal path must prevent collateral already allocated to settlement from leaving escrow. A reservation in PostgreSQL alone cannot provide that guarantee. Reject relying on wallet allowances or stale indexed balances to guarantee executable orders. An omnibus custodial balance would change legal and key-control boundaries and requires a separate decision.

Custody counsel, protocol engineering and security must approve ownership rights, escrow exit rights, session scopes, upgrade power and insolvency behavior. These approvals are not inferred from this recommendation. Until then, code may simulate reservations but may not integrate real-money escrow.

One reservation authority must cover CLOB, AMM, RFQ and withdrawals. Seller outcome inventory requires the same protection as buyer collateral. Shared-account spending across market partitions must serialize at the reservation authority, not merely within each book. On-chain nonces and cumulative filled quantities enforce replay limits independently of the relayer.

## Exact accounting and payout mathematics

Financial quantities are bounded integer strings over the wire and bigint in reference calculations. Assets, scales and units are explicit. Do not compare different assets or sum them without separately booked conversion transactions. The reference arithmetic is implemented in src/financial/model.ts and verified by property tests.

Market execution follows the same rule. A published event may have independent NGN and `USDT_BSC` books keyed by `(market_id, asset_code)`. Each book has its own contract unit, orders, fills, liquidity exposure, event sequence, positions, and settlement manifest. Matching and liquidity never cross assets. One governed resolution result applies to every book, and redemption reports payout totals grouped by asset.

An illustrative custody-balance chart, conditional on the approved accounting model:

| Account class | Normal side | Example |
| --- | --- | --- |
| Asset | Debit | Verified partner receivable; finalized escrow collateral |
| Liability | Credit | User available; user reserved; user withdrawable; unresolved payout obligation |
| Equity/revenue | Credit | Explicit protocol fee revenue or equity; never an unexplained balancing plug |
| Expense | Debit | Disclosed subsidy or provider fee expense |

Deposit example: debit finalized collateral asset 100; credit user available liability 100. Reservation: debit user available liability 40; credit user reserved liability 40. Cancellation: debit reserved liability 40; credit available liability 40 only after outstanding settlement exposure is provably absent. Seller transfer and fees must be a multi-posting transaction with separately specified inventory movements. Partner receivables remain nonspendable until collateral and approved settlement policy permit recognition as available.

Self-custody ownership may require a memorandum/reconciliation ledger instead of recognizing customer assets and liabilities on Afridict's corporate balance sheet. Finance and counsel own that classification. Do not copy the illustrative postings directly into production accounting.

For maximum buyer reservation, notional = ceil(quantity * limit_price / price_scale); fee = ceil(notional * fee_bps / 10000). This reference assumes fees accrue cumulatively per order; per-fill rounding requires a separately proven bound. Partial-fill implementation must compute incremental cumulative fees or reserve an explicit worst-case fee budget. Fees, inventory, rebates, subsidy and payout dust each need named accounts.

Generalized payout vector: a nonnegative integer weight for each outcome and a positive denominator D, with weights summing to D. Binary/categorical finalization selects one weight D and others zero. Scalar short/long weights use U - clamp(x,L,U) and clamp(x,L,U) - L, with D = U - L. The illustrative payout is floor(quantity * weight / D), with the remainder tracked; it must not disappear or become discretionary operator revenue. Redemption splitting can change dust, so production contracts must use cumulative entitlement or an approved aggregation policy. Invalid/cancelled payout vectors and unclaimed dust disposition require market-policy approval; no arbitrary equal refund is assumed.

## State transitions and failure ownership

| Flow | States and key rule |
| --- | --- |
| Funding | initiated -> partner_pending -> conversion_pending -> chain_pending -> reconciled_available; failed or exception may branch before availability |
| Reservation | held -> partially_consumed -> consumed; held/partially_consumed -> release_pending -> released only after pending fills are fenced |
| Settlement | prepared -> submitted -> observed -> finalized; submitted/observed -> uncertain on missing or conflicting evidence; reverted may return to prepared only after reconciliation |
| Withdrawal | requested -> eligibility_checked -> reserved -> submitted -> finalized; timeout stays uncertain and does not release the reservation |
| Resolution | proposed -> challenged/adjudicated or uncontested -> timelocked -> finalized; finalized is immutable |

Transaction hashes identify submission attempts. Chain observations include chain ID, block hash, transaction hash and log index. A stable economic effect ID identifies the accepted fill or redemption across replacement/replay attempts. Account-scoped idempotency keys and database unique constraints prevent duplicate commands. An uncertain chain submission is not a safe cancellation signal.

For `USDT_BSC`, the browser supplies only a transaction hash and log index as a discovery hint. A read-only BSC RPC adapter decodes the exact `Transfer` event to the account's custody-controlled address. Confirming observations have no ledger effect. Finalized observations post one unique balanced journal; disappearance before finality marks the observation reverted, while a contradiction after credit opens a critical exception and preserves the journal for authorized compensating recovery.

No automatic compensation rewrites history. Reorg handling removes or marks orphaned observations in derived stores and issues traceable compensating journals only under the finality/reconciliation policy. A contradiction involving a previously accepted finality assumption halts affected risk and enters an owned incident workflow.

## Durability, authorization and audit

Recommend no loss of acknowledged financial commands within an explicitly agreed AZ-failure envelope. A synchronous durable journal must precede acknowledgement. The generic sub-minute RPO target is insufficient as the sole financial-command guarantee. Region loss, quorum failure, backup recovery and operator error need separately documented guarantees and tests before implementation.

Governance commands use one database transaction for state, idempotent response, append-only audit and outbox event. Failed transactions leave none of those effects. Current idempotency records are retained indefinitely; deletion requires an approved retention/replay design. Inbox effects and deduplication markers commit together. Publish checks lock the market and relevant template/country policy records so changes cannot interleave unnoticed.

Account privileges are server-owned; no user request supplies roles. Native or directly linked Google authentication establishes the account only; country and resource authorization are separate. TLS termination, production distributed rate limits, credential rotation, privileged MFA/recovery and least-privilege runtime database credentials are operational controls still requiring deployment integration. Application rate limits currently protect each process; they do not establish a global quota.

Database triggers reject audit/review/outbox history mutation and published-market changes. Production runtime credentials must lack schema ownership, trigger modification, TRUNCATE and privileged registry/role writes. The optional `ops/runtime-grants.sql` grants a non-login role the API's current minimum table privileges; a DBA must apply it and grant its membership only to the approved login role. Startup refuses a production database role that can update account roles, approval registries or audit history. A database owner can defeat ordinary triggers; independent audit export and key separation are required before production. No claim of tamper-proof storage is made for a developer database.

## Open decisions and review triggers

1. Country, provider, custody, collateral and financial accounting: leadership, counsel, finance and protocol owners; block real integrations.
2. Payout/rounding/cancellation/dust policies: market integrity, finance and protocol; block settlement and redemption.
3. Immediate guardian pause exception versus universal dual approval: security and governance; no emergency endpoint is implemented until resolved.
4. Chain finality, RPC independence and account-abstraction capabilities: protocol/platform; verify primary evidence and test provider behavior.
5. Acknowledged-command durability and workload: backend/platform/finance; benchmark expected launch peak and test the declared failure envelope.
6. Native authentication and administrative principal provisioning: security/product; review password hashing, MFA, session revocation, recovery, abuse controls, direct Google configuration and audit obligations. Adapter tests do not substitute for a production security review.

Review these decisions when custody rights, regulatory guidance, chain behavior, workload, provider capability or threat evidence changes. Production activation is blocked until the full platform programme gates pass.
