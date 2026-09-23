# ADR 0015: Independently observed USDT-BSC deposits

Status: accepted engineering foundation; custody and production activation pending.

## Context

Afridict presents a USD wallet backed by the exact `USDT_BSC` ledger asset. A customer must be able to deposit USDT on BNB Smart Chain without allowing a browser, finance operator or custody dashboard assertion to create spendable balance. Deposit addresses are custody infrastructure and must never imply that Afridict stores a private key in the application database.

## Decision

Each account may have one active custody-controlled address for `USDT_BSC`. A finance operator registers the address, opaque custody allocation reference and evidence after the external custody system creates it. The customer API exposes the address and exact chain/token identity but never returns custody metadata or credentials.

A customer may submit a transaction hash and log index for discovery. This input is only a lookup hint. Afridict's read-only BSC observer verifies chain ID 56, the configured USDT contract, the exact ERC-20 `Transfer` log, recipient address, integer amount, canonical block and current confirmation count. The minimum accepted deposit is 1 USDT, or `10^18` contract units. Production RPC configuration requires HTTPS; the default engineering finality policy is 12 confirmations and must be reviewed against custody, chain and risk requirements before activation.

Confirming transfers are recorded without a ledger effect. A finalized transfer creates one append-only `deposit_finalized` journal from safeguarded token escrow to the account's `user_available` balance. The `(chain_id, transaction_hash, log_index)` identity and the journal effect ID make duplicate and concurrent submissions converge on one credit.

A transfer that disappears before finality becomes `reverted` and creates no balance. A changed or missing transfer after credit becomes `exception`, opens a critical financial reconciliation item and retains the original journal. Recovery requires an authorized compensating entry and account/risk response; application code never deletes or mutates the posted financial history.

## Consequences

- The USD wallet remains exact `USDT_BSC`; it is not a generic dollar liability.
- Address provisioning remains unavailable until the token, custody allocation and finance evidence are approved.
- Deposit observation remains unavailable until a read-only BSC RPC is configured.
- Independent RPC observation reduces reliance on a custody dashboard but does not replace custody reconciliation, multiple RPC sources, treasury controls or legal approval.
- Durable address scanning, provider-specific custody automation and automated exception operations remain operational work. The transaction-reference endpoint is safe to retry and does not trust customer-supplied transfer fields.
