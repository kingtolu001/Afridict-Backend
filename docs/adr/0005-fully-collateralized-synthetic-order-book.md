# ADR 0005: Fully collateralized synthetic order book

Status: accepted for the isolated synthetic environment; production activation remains blocked.

## Context

Afridict's published market terms define outcomes, an exposure limit, a fee rate, a trading window and a collateral policy reference. Publishing those terms does not fund an outcome, authorize a real collateral asset or activate trading. An order book needs to survive retries and concurrent order submissions without spending the same user balance twice.

## Decision

The synthetic book matches a buyer of an outcome against a seller funding the complementary claim. A sell order is a fully funded short on that outcome, not a sale of inventory the user already owns. For categorical markets, the seller's claim pays if **any other** outcome wins. Scalar markets use the published payout vector at resolution; the matching engine does not infer a binary result.

The initial demo used a fixed payout of 1,000,000 collateral minor units. [ADR 0013](0013-governed-market-collateral-units.md) supersedes that unit assumption: prices remain integers from 1 to 999,999 on a 1,000,000 probability scale, while each governed asset binding supplies its own contract payout unit. Each side pays a separately rounded **per-share** fee, multiplied by quantity. A buy reserves its highest allowed price and a sell reserves its lowest allowed price; execution at a better resting price immediately returns the difference. Partial fills therefore cannot incur more than the original reservation.

All order acceptance, matches, fills, cancellation and market events run in the caller's database transaction. A market row lock orders competing commands. Each market assigns one increasing sequence to every acceptance, fill, cancellation, activation and halt. The maker's limit price is the execution price; best price and then earlier admission sequence determine priority. The authenticated principal and server-owned account identify the order owner; the idempotency key binds retries to the exact request. The demo uses synthetic personas, while production uses revocable Afridict sessions created by native password or explicitly linked Google authentication. No client-supplied owner, account balance, timestamp or execution sequence is trusted.

Each fill moves both sides' collateral from reserved user balances to market escrow, and fees into the protocol-fee liability bucket, using balanced append-only journals with unique effect identifiers. Order state and reservation consumption change in the same transaction as the fill. Unmatched order quantity can be cancelled even after a halt; matched collateral stays escrowed pending a separate governed resolution and redemption design. Reconciliation counts user claims, market collateral and accrued fees separately against custody escrow.

Activation requires a published market within its trading window, explicit trading permission for every published jurisdiction, and an approved binding between its published collateral policy reference and an approved **synthetic** financial asset. There is no default asset binding. Only a market approver can activate or halt. A halted market cannot reopen automatically. The server permits this route only with demo authentication and synthetic finance outside production; it rejects real-money execution.

## Consequences and remaining gates

The order book, private order/fill reads, fill-derived position projection, aggregate book snapshot and sequenced public event feed have OpenAPI schemas and generated TypeScript types. A frontend can build against these synthetic contracts. A production venue still needs reviewed collateral/payout mappings, independently governed trading activation, real custody and settlement adapters, market resolution/redemption, restricted-owner cancellation and recovery procedures, operational event delivery, and an approved signing policy if orders must carry a signature independent of account authentication. A fill is a collateralized claim, **not** a finalized winning payout.
