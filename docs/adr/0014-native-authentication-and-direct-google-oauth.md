# ADR 0014: Native accounts and direct Google OAuth

Status: accepted. Supersedes ADR 0002.

## Context

Afridict requires email/password accounts and Google sign-in without delegating account ownership to a separate identity vendor. The platform already owns eligibility, contact verification, roles and financial capabilities, so the account authority must remain consistent across password and Google entry paths. Email addresses can change and cannot safely identify a Google account.

## Decision

Afridict owns password credentials, opaque sessions, password recovery and authentication audit records. Passwords use per-account salts and memory-hard scrypt derivation. Only session-token SHA-256 digests are stored. Sessions expire after 24 hours, logout revokes the presented session, and password replacement revokes every existing session. Failed login and recovery attempts commit before the API returns a rejection so lockout controls survive transaction rollback.

Google sign-in integrates directly with Google's OAuth 2.0 authorization-code endpoints. Afridict creates one-use state and a PKCE verifier, restricts the configured redirect URI, exchanges the code from the backend, requests only email and profile identity scopes, and discards Google access tokens after reading the verified identity. Production configuration requires a client ID, client secret and HTTPS redirect URI.

The immutable Google `sub` value is the external identity key. A verified email is registration evidence and a display/contact value; it is never the linking key. Google email verification satisfies Afridict email possession only when Google is authoritative for the address, currently Gmail or a Google-hosted domain claim. Other addresses still require Afridict contact verification. If a Google email matches an existing native account, sign-in returns `link_required`. The account owner must authenticate to Afridict and complete a separately state-bound Google authorization before the subject can be linked. A Google subject and an Afridict account can each participate in at most one link.

An unlinked Google identity receives a short-lived one-use registration credential. Registration still requires jurisdiction, phone number and versioned policy acceptance, creates pending eligibility, and issues an Afridict session. No Google password, access token or refresh token is persisted.

## Consequences

- Afridict owns credential security, breach response, recovery, abuse controls and session operations.
- Direct Google authorization can be replaced without changing account, role, eligibility or capability records.
- Privileged-account MFA, session inventory/revocation UI, global rate-limit storage and security review remain production gates.
- Frontends must discover enabled methods from `/v1/auth/configuration`, open Google authorization in a full browser, and treat `authenticated`, `registration_required` and `link_required` as distinct states.
- Demo personas remain restricted to the loopback synthetic environment.

Google's server-side flow requires exact redirect URI matching and recommends state validation; authorization-code handling is documented at https://developers.google.com/identity/protocols/oauth2/web-server. Google's identity reference states that `sub`, rather than email, is the stable account identifier: https://developers.google.com/identity/openid-connect/reference.
