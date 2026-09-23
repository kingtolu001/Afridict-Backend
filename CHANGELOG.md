# Changelog

This file records externally meaningful backend behavior and operational changes. The project has not issued a production release.

## Unreleased

### Added

- Separate NGN and USD (USDT_BSC) wallet projections plus custody-address registration and independently observed USDT deposit states.
- Finalized USDT deposits credit exactly once after configured BSC confirmation depth; pre-final reorgs remain unavailable and post-final contradictions open critical reconciliation exceptions.
- Direct Google authorization-code sign-in and explicit account linking with one-use state, PKCE, immutable Google subjects, and short-lived registration credentials.
- Afridict-native password registration, revocable opaque sessions, recovery, public profiles and onboarding projections.
- Exact NGN/USDT wallet conversion quotes with 30-second expiry, rational rates, explicit fees, ring-fenced treasury inventory, atomic execution, and concurrency protection.
- An unapproved-by-default BNB Smart Chain USDT asset identity and finance-audited rate and inventory controls.
- Governed per-market collateral assets and contract payout units across CLOB, AMM, RFQ and redemption, with caller wallet-readiness APIs.
- Deterministic, non-executable AMM quote mathematics with conservative inventory, subsidy, slippage, and worst-case loss bounds.
- Governed synthetic AMM activation, treasury funding, fresh-reference quotes, atomic execution, portfolio positions, exactly-once redemption, reconciliation, and settlement claims.
- Maker-checker institutional onboarding and Ed25519-signed RFQs with expiry, entity exposure limits, atomic two-party collateral, redemption, and settlement claims.
- A startup-relative synthetic trading demo with open books, funded personas, visible depth, and example fills.
- Governed binary, categorical, and scalar market definitions with independent policy review.
- Append-only double-entry accounting, shared collateral reservations, and reconciliation records.
- Synthetic NGN and approved-token funding workflows with explicit finance review and uncertain states.
- A fully collateralized deterministic synthetic order book with concurrency protection.
- Recoverable authenticated WebSocket feeds for market events, aggregate books, private positions, and resolution changes, documented with AsyncAPI.
- Evidence-backed resolution, independent adjudication, idempotent redemption, and testnet claim settlement preparation.
- Generated OpenAPI 3.1 documentation and TypeScript client types for frontend integration.
- Enforced test coverage, explicit CI quality gates, dependency update automation, structured logs, and optional sanitized error reporting.

### Security

- Failed password and recovery attempts commit before rejection so account lockout controls survive transaction rollback.
- Google email matches never link accounts automatically; an existing account must authenticate and complete a separately bound Google authorization.
- Production financial paths fail closed until provider, custody, governance, country and deployment approvals are configured.
- Secrets, raw identity documents, customer request bodies, and original exception messages are excluded from operational telemetry.
