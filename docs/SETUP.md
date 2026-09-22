# Development setup

Use Node.js 22.16–24. Install dependencies with `npm ci`.

## Synthetic demo

Run `npm run demo`, then open `http://127.0.0.1:3000/docs`. Data is synthetic and ephemeral. Production mode rejects demo authentication and synthetic finance.

## PostgreSQL

Set `POSTGRES_PASSWORD` locally and run `docker compose up -d postgres`. Copy `.env.example` to `.env`; `.env` is ignored. Supply `DATABASE_URL` and exact CORS origins. For direct Google sign-in, also supply the Google client ID, client secret and exact callback URI. Run `npm run db:migrate`, then `npm run dev`.

Migrations are checksum protected. Never edit an applied migration; add a new migration. Use a privileged migration role separately from the restricted runtime role described in `ops/runtime-grants.sql`.

## Authentication and providers

Afridict owns email/password credentials and revocable sessions. Google uses a direct Authorization Code flow with server-owned state and PKCE; Google's immutable subject, not an email address, identifies the linked account. Twilio Verify requires its service SID, API key SID, API key secret, and a separate abuse-hash key. Leave Google or Twilio values blank when that integration is disabled.

Never commit `.env`, keys, tokens, customer records, production URLs containing credentials, or copied provider responses containing personal data.
