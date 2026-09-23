# ADR 0017: Hosted NGN sandbox

## Status

Accepted

## Decision

Add `FINANCIAL_MODE=sandbox` for a publicly hosted test environment using native authentication and SwervPay Development collections. Startup requires the complete SwervPay sandbox configuration, rejects a BNB Smart Chain observer, provisions one clearly labeled NGN sandbox market, and seeds restart-safe test counterparties. Native password and Google registrations receive sandbox-only verification and eligibility.

The sandbox accepts NGN Development deposits and permits collateralized NGN CLOB orders. It rejects fiat payouts, blockchain deposits, and crypto withdrawals. The default remains `disabled`; the local `synthetic` mode remains restricted to demo authentication on loopback.

## Rationale

Frontend and provider integration need a deployed registration, deposit, buy, and sell journey. SwervPay Development balances are not customer funds, while the existing USDT observer targets BNB Smart Chain and could observe real tokens. Restricting the hosted sandbox to NGN prevents test eligibility and test liquidity from being confused with real custody.

## Consequences

Sandbox balances, eligibility evidence, markets, and liquidity are explicitly labeled and cannot authorize withdrawals. Bootstrap operations lock their account rows and reuse stable financial effect identifiers so concurrent restarts do not duplicate funds or resting orders. A future live mode requires separate legal, custody, treasury, identity, country, asset, and operational approvals; this decision does not grant them.
