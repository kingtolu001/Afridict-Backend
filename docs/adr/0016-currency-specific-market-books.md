# ADR 0016: Isolate execution books by collateral asset

Status: accepted for the synthetic execution environment. Production activation remains gated.

## Context

Afridict presents NGN and USD as separate wallets. USD is backed by the exact `USDT_BSC` asset. A customer who selects either wallet must be able to trade the same published event in that asset without an implicit conversion. A single market-wide order book would allow unlike assets and contract units to cross, corrupt price-time priority, collateral accounting, payouts, and settlement.

## Decision

A published market and its resolution policy remain common, while execution is partitioned by `(market_id, asset_code)`. Every partition has an immutable book identifier, contract payout unit, sequence, orders, fills, liquidity state, positions, and settlement batches.

When a market has more than one active book, order, AMM, RFQ, realtime, and settlement operations require `asset_code`. A single-book market may omit it for backward compatibility. CLOB matching, AMM inventory, RFQ exposure, event replay, positions, redemption totals, and claim manifests never combine assets. Prices retain the universal probability scale of 1,000,000; payout amounts use the selected book's contract unit.

All books for an event close under one governed outcome. Redemption derives the asset and unit from each immutable fill and reports totals grouped by asset. Chain settlement produces a separate manifest for each asset.

## Consequences

- Choosing a wallet selects an execution book; it does not convert funds.
- A frontend must retain `asset_code` with market, order, quote, RFQ, position, realtime cursor, and settlement state.
- Sequence recovery is scoped to a book. A cursor from one asset cannot resume another asset's stream.
- Liquidity and displayed depth cannot be summed across NGN and USDT.
- New collateral assets can be added through governed bindings without duplicating the event or resolution record.
- Production enablement still requires approved accounting, custody, market-risk, treasury, legal, and provider controls for each asset.

