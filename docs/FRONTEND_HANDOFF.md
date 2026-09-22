# Frontend integration handoff

## Start the synthetic environment

Use Node 22. Run `npm ci`, then `npm run demo`. Open http://127.0.0.1:3000/docs for interactive OpenAPI documentation. The demo uses embedded PostgreSQL and resets on restart. It seeds synthetic binary, categorical and scalar markets under the reserved ZZ jurisdiction. No actual legal approvals, KYC results, money, wallets or chain transactions are involved.

Choose a synthetic persona in the Swagger Authorize dialog with `demo.trader`, `demo.creator`, `demo.approver`, `demo.legal`, `demo.integrity`, `demo.resolution`, `demo.compliance`, `demo.other_compliance`, `demo.proposer`, or `demo.auditor`. Swagger supplies the Bearer prefix. These are fixture selectors, not real credentials. `demo.new_user` exercises onboarding. Production accepts none of these selectors.

Consumer screens can integrate /v1/me, /v1/session, /v1/eligibility, /v1/markets and evidence policy. Admin screens use the governed draft/review/publish flow. Each role should see only permitted actions, but the backend enforces permission independently of the UI.

Phase 5 also exposes synthetic financial workflows: /v1/financial-assets, /v1/balances, deposit intents, withdrawals and statements. `demo.finance` can advance the synthetic partner, chain and uncertain-withdrawal states using the documented Synthetic operations. The UI must keep `partner_confirmed` deposits pending and keep `submitted` or `uncertain` withdrawals reserved. `funding_instructions_available=false` means no real beneficiary or payment instructions exist. `spendable=false` means the balance cannot be used for trading yet.

## Contract and generation

- `api/openapi.json`: generated HTTP contract with operation descriptions, schemas, status/error definitions, headers and synthetic policy examples.
- `api/client-types.ts`: generated TypeScript types; import as types without copying server code.
- `api/market-examples.json`: complete synthetic request policies for all three market structures.
- `npm run api:generate`: regenerate the published contract and types after reviewed schema changes.
- `npm run api:lint`: validate the OpenAPI artifact.
- `npm run api:check`: verify generated contract/type files match the committed artifacts.

Every write requires an Idempotency-Key, 8-128 ASCII letters/digits/underscore/hyphen. Retain the key across timeout and retry of the same action; generate a new key for a changed command. A retry can return its original representation even after later changes; use GET to refresh current state. Keys are scoped to authenticated identity across all write operations and retained indefinitely in this release.

All responses include X-Request-Id. Errors include code, message and request_id. Branch on code, never message. 401 means reauthenticate; 403 means forbidden/restricted; 409 means refresh state or correct a key conflict; 422 means market-policy validation; 429/503 require backoff. A timeout or 500 does not prove a command failed. Include the original key when retrying.

Market policy versions implement optimistic concurrency. Creator edits apply only to draft/rejected states. Submit changes to review; product/legal/integrity/resolution actors approve the exact policy hash. The creator and original proposer cannot review or publish. Publication remains scheduled metadata and always returns trading_enabled=false. Do not display a trade button based only on publication or eligible status.

Pagination cursors must be passed back unchanged with the same filters. Monetary limits and scalar values are strings; use bigint/decimal-safe formatting. Timestamps are instants, returned in UTC; display the market's named resolution timezone when interpreting source policy. API serialization strips private provider identity and internal approval evidence from public responses.

## Normal PostgreSQL development

Set POSTGRES_PASSWORD locally and run `docker compose up -d postgres`. Supply DATABASE_URL using environment variables or a local .env copied from .env.example. Add Google client ID, client secret and the exact frontend callback URI only when testing direct Google sign-in. Then run `npm run db:migrate` and `npm run dev`.

Native authentication has no default Google, Twilio or Persona credentials, privileged account, country approval or market template approval. Those values and records require controlled operator provisioning and specialist decisions. Use the isolated demo for frontend development while those decisions are open. Production must use a restricted runtime database role distinct from the migration/registry provisioning role. A DBA must apply the reviewed runtime grants and provision the login before deployment.

## Delivery and unresolved integrations

Frontend integration is contract-ready, not a completed frontend implementation. The frontend developer still needs to review naming, error presentation, navigation and interaction behavior against the contract. Real-provider sign-in/recovery and KYC integration remain pending provider selection. Real partner funding, WebSocket market feeds, trading, independently indexed chain settlement, final evidence collection and redemptions belong to subsequent delivery and activation work. The current Phase 5 API is suitable for financial-state frontend integration through the synthetic demo.

Do not connect a production frontend to the synthetic environment. Default demo bind is loopback; do not expose it through a tunnel or public proxy.
