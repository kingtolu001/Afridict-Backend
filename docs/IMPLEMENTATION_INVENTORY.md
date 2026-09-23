# Implementation inventory and PR plan

Reviewed 15 September 2026 against merged backend implementation. No frontend directory or frontend implementation exists in this repository. Existing shared history will not be destructively rewritten.

## Current implementation

| Area | Status | Evidence and remaining work |
| --- | --- | --- |
| Project foundation | COMPLETE | Fastify/TypeScript, PostgreSQL, migrations, CI, Docker, config and OpenAPI generation |
| Frontend architecture | NOT STARTED | Frontend directory was removed at owner request; API types and handoff exist |
| Design system | NOT STARTED | No UI assets or components in this backend repository |
| Authentication | PARTIAL | Native scrypt credentials, revocable opaque sessions, recovery workflows and direct Google OAuth with explicit subject linking exist; privileged MFA, global abuse controls and production delivery validation remain |
| Registration | PARTIAL | Native and Google registration persist normalized profile and consent evidence; production contact delivery and country activation remain |
| Email verification | PARTIAL | Provider port exists; persisted workflow is PR #1; production Twilio/SendGrid configuration unvalidated |
| Phone verification | PARTIAL | E.164 normalization and Twilio port exist; persisted workflow is PR #1 |
| Twilio | PARTIAL | Verify adapter and tests exist; credentials, service policy, monitoring and production validation remain |
| SendGrid | NOT STARTED | Transactional email port only; adapter, outbox worker, domain authentication and event processing absent |
| Persona | NOT STARTED | Normalized interface only; adapter, inquiry/session, signed webhooks and ordering absent |
| Capability model | PARTIAL | Fail-closed action decisions exist; production action gates and policy registries remain |
| Wallet architecture | PARTIAL | NGN and exact `USDT_BSC` balances remain separate; direct conversion uses immutable quotes and two linked single-asset journals; normalized transaction history remains |
| Double-entry ledger | COMPLETE | Balanced append-only journals, exact integer amounts and mutation guards are tested; production accounting approval remains a gate |
| NGN wallet / USD wallet | PARTIAL | `/v1/wallets` exposes separate zero-inclusive NGN and USD (exact `USDT_BSC`) projections with independent balances, rails and activation flags; production custody and activation remain |
| SwervPay | PARTIAL | Typed sandbox adapter, one-time NGN collection instructions, account resolution and guarded payouts exist; commercial terms, webhook identity and independent reconciliation remain |
| NGN deposits / withdrawals | PARTIAL | NGN 200 minimum collection intents and administrator-reviewed payout state machine exist; production provider approval and settlement reconciliation remain |
| Bank resolution / payment methods | PARTIAL | Ephemeral bank resolution and encrypted-at-rest payout details exist; reusable accounts and production validation remain |
| Markets | PARTIAL | Generalized definitions, governance, evidence policy and publication exist; opening/trading lifecycle absent |
| CLOB / orderbook | COMPLETE (SYNTHETIC) | Deterministic price-time matching, governed NGN/USDT-capable contract units, automatic market-wallet selection, partial fills, cancellation, sequence recovery, fees, halts and concurrency tests |
| AMM | COMPLETE (SYNTHETIC) | Governed treasury, bounded exact quotes, exposure/loss/slippage controls, atomic execution, redemption and settlement |
| Institutional RFQ | COMPLETE (SYNTHETIC) | Maker-checker entities, Ed25519 dealer quotes, expiry, exposure limits, atomic two-party execution and settlement |
| Collateral reservation | COMPLETE (SYNTHETIC) | CLOB, AMM, RFQ and withdrawal paths share one owner/asset serialization authority |
| Positions / portfolio | PARTIAL | Unsettled CLOB, AMM and RFQ positions are derived from immutable fills; production valuation remains absent |
| Settlement | PARTIAL | Governed redemptions and deterministic Robinhood Chain testnet claim batches exist; production deployment remains absent |
| Robinhood Chain | PARTIAL | Smart-account and finality observation schemas exist; RPC, signing, indexing and reorg adapters absent |
| Crypto deposits / withdrawals | PARTIAL | Custody-address registration, read-only BSC Transfer-log verification, confirmation states, exactly-once final credit, reorg exceptions and manual finance-reviewed withdrawals exist; durable scanning, multiple RPC/custody reconciliation and production custody remain |
| Realtime | COMPLETE (SYNTHETIC) | One-use browser authentication, ordered market replay, book and private position snapshots, cursor recovery, bounded backpressure and AsyncAPI contract |
| Notifications | NOT STARTED | Transactional outbox primitive exists; no delivery workers/providers |
| Transaction history | PARTIAL | User ledger statement endpoint includes linked conversion journals; normalized cross-domain transaction model remains |
| Admin | PARTIAL | Market/compliance governance and audit endpoints exist; finance/resolution/operations consoles incomplete |
| Reconciliation | PARTIAL | Stored ledger/partner/chain comparison and exceptions exist; independent provider/chain sources absent |
| Audit logging | COMPLETE | Append-only attributable audit and outbox records cover implemented privileged workflows |
| Tests | PARTIAL | Money movement, duplicate webhook, CLOB/AMM/RFQ/withdrawal concurrency, resolution, payout conservation, settlement finality and reorg tests exist; production adapters, load and recovery exercises remain |
| Observability | PARTIAL | Request IDs and safe logs exist; metrics, traces, alerts and SLOs absent |
| Documentation | PARTIAL | Architecture/setup/ADRs are PR #9; runbooks and API lifecycle policy remain |

## Existing commit classification

| Commit | Substantial work |
| --- | --- |
| `acada8c` | Initial OpenAPI contract |
| `43957b8` | Service foundation, identity/eligibility, market governance, CI, migrations and financial reference model |
| `3a80d6c` | Audited external market-proposal rejection |
| `d7fc08c` | Ledger, reservations, synthetic funding/finality and reconciliation |
| `8346c66` | Account assurance and capability policy |
| `26ed0e3` | Federated password/Google authentication discovery |
| `b2e514d` | Contact provider ports, Twilio Verify adapter and phone normalization |
| `0eaa35a` | Registration profile and policy acceptance |

`43957b8` spans several domains, but it is already public and shared. Rewriting it would damage the real commit history. New work uses focused branches and PRs.

## Remaining meaningful PR sequence

| Work | Reviewable output | Dependency | Primary risk |
| --- | --- | --- | --- |
| Realtime feeds | Authorized WebSocket order, trade, position and resolution streams with snapshot/sequence recovery | Canonical market events | Missed or duplicated client state |
| Developer platform | API keys/OAuth, scopes, quotas, signed webhook delivery, sandbox and SDKs | Stable HTTP and realtime contracts | Credential abuse and replay |
| Operational assurance | Durable workers, metrics, alerts, reconciliation console, runbooks, backups and recovery exercises | Domain workflows and deployment environment | Undetected financial or provider failure |
| Production activation | Native-auth security review, privileged MFA, validated direct Google configuration, SwervPay, audited custody/chain deployment, country/legal approval and treasury controls | External approvals and production adapters | Unauthorized or premature real-money operation |

Each PR must contain independently reviewable implementation, contracts and tests. Empty or cosmetic PRs are not created.
