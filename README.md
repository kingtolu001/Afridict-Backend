# Afridict Backend

Afridict is financial and prediction-market infrastructure for Africa-first event markets. This repository contains the transactional backend foundation: identity and capability policy, governed generalized markets, append-only double-entry accounting, collateral reservations, funding workflows, reconciliation, audit records, and versioned OpenAPI contracts. It is not a standalone betting application.

The current implementation is a production-shaped modular monolith with an isolated synthetic demo and a hosted NGN sandbox. The hosted sandbox uses SwervPay Development collections and test liquidity; it cannot create withdrawals or observe blockchain deposits. Real trading, real payments, custody activation, market resolution, and Robinhood Chain settlement remain disabled until their provider, legal, security, finance, and operational gates are approved.

## Run locally

Requirements: Node.js 22.16–24 and npm. For the synthetic environment:

```bash
npm ci
npm run demo
```

Open `http://127.0.0.1:3000/docs`. The demo binds to loopback, resets its embedded PostgreSQL database on restart, and uses synthetic `demo.<persona>` selectors. It starts three currently tradable markets with collateral, visible order-book depth, and example fills for frontend development. Never expose it publicly.

For PostgreSQL development, copy `.env.example` to an untracked `.env`. Set `POSTGRES_PASSWORD` and set `DATABASE_URL` to the matching `afridict` connection on `127.0.0.1:5432`, then run:

```bash
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Native email/password authentication owns Afridict sessions and recovery. Direct Google sign-in is disabled unless `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and an exact `GOOGLE_REDIRECT_URI` are supplied; production redirects require HTTPS. Twilio Verify is disabled unless every required server-side value is supplied. Keep all secrets in the environment or an approved secret manager.

`GET /v1/wallets` returns separate NGN and USD views. USD is the exact `USDT_BSC` asset on BNB Smart Chain and is never combined with NGN. USDT deposit observation remains disabled until a read-only `BSC_RPC_URL` is configured and finance registers a custody-controlled address for the account.

SwervPay sandbox configuration creates one-time NGN collection accounts through a durable worker. `POST /v1/webhooks/swervpay` accepts only authenticated `collection.completed` credits for the configured business, rejects mismatched amounts, and credits each provider transaction once. Afridict stores kobo and converts provider request and event amounts at the adapter boundary.

Set `FINANCIAL_MODE=sandbox` only on a deployment configured with all SwervPay sandbox values. Startup provisions a clearly labeled NGN sandbox market, restart-safe test liquidity, and sandbox eligibility for native accounts. Password or Google users can request a minimum NGN 200 Development collection and place matched NGN orders. The mode rejects NGN payouts, crypto deposits, crypto withdrawals, and BSC observer configuration. `FINANCIAL_MODE=disabled` remains the default.

Structured JSON logging is enabled outside tests. Optional Sentry error reporting is enabled only by an HTTPS `ERROR_TRACKING_DSN`; reports are sanitized and contain no request body, authenticated user, provider payload, or original exception message.

## Verification

```bash
npm run check
npm run test:coverage
npm run api:check
npm audit --omit=dev --audit-level=high
```

`npm run check` runs type checking, lint, tests, build, OpenAPI generation, and contract validation. `npm run test:coverage` enforces the measured statement, branch, function, and line floors. GitHub Actions exposes each gate separately, runs integration tests against PostgreSQL, audits production dependencies, and Dependabot proposes grouped dependency updates.

## Contracts and architecture

- `api/openapi.json` is the generated OpenAPI 3.1 HTTP contract.
- `api/asyncapi.json` is the AsyncAPI 3.0 WebSocket message and sequence-recovery contract.
- `api/client-types.ts` contains generated TypeScript client types.
- `docs/ARCHITECTURE.md` explains system boundaries and data authority.
- `docs/IMPLEMENTATION_INVENTORY.md` records completed, partial, and missing work plus the PR sequence.
- `docs/adr/` records durable architecture decisions.
- `docs/DELIVERY_PLAN.md` records implementation order and activation gates.
- `CONTRIBUTING.md` defines the change, review, and fresh-clone verification workflow.
- `CHANGELOG.md` records externally meaningful behavior and operational changes.

Financial amounts cross APIs as exact integer strings. Clients must reuse the same idempotency key and body when retry behavior permits it, treat pending/uncertain states explicitly, and never infer settlement from a webhook or transaction hash.

The wallet conversion API quotes direct NGN/USDT exchanges for 30 seconds and executes them atomically against ring-fenced treasury inventory. NGN uses kobo; `USDT_BSC` identifies USDT on BNB Smart Chain with 18 decimals. Both single-asset journals link to one immutable trade. The token, rates, inventory recognition and real-money financial mode remain approval-gated.

Each published event can expose independent NGN and `USDT_BSC` execution books. The selected wallet becomes the explicit `asset_code`; CLOB matching, AMM inventory, RFQs, positions, realtime sequences, payouts, and settlement batches stay isolated by that asset. All books share one governed event outcome, while each book keeps its approved contract payout unit. Prices remain probability micros on a 1,000,000 scale. Public clients can read `/v1/markets/{id}/collateral-policy`; authenticated clients use `/v1/markets/{id}/collateral` to discover enabled books and wallet readiness. Multi-book commands must include `asset_code`, and conversion remains a separate accepted quote.

The synthetic liquidity API includes role-gated AMM activation, finance-controlled treasury funding,
approved reference prices, 15-second user quotes, atomic execution, position reporting, governed
redemption, and testnet settlement claims. Institutional RFQs add maker-checker entity approval,
approved Ed25519 dealer keys, expiring signed quotes, per-entity exposure limits, and atomic two-party
collateral. These routes remain disabled outside the isolated demo.

Authenticated clients can create a 60-second one-use realtime ticket with `POST /v1/realtime/tickets`,
open `/v1/realtime`, and send the ticket in the first JSON frame. The stream replays canonical market
events after a client cursor and publishes aggregate book and private position snapshots. See the
AsyncAPI contract for frame schemas, recovery steps, and close codes.
