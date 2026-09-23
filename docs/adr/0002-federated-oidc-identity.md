# ADR 0002: Federate password and Google authentication through OIDC

Status: superseded by [ADR 0014](0014-native-authentication-and-direct-google-oauth.md).

One OIDC provider will own email/password credentials, recovery, MFA, sessions, and Google federation. Afridict verifies issuer, audience, signature, expiry, and immutable subject claims, then applies server-owned roles and capabilities. Google email is not an account key.

Local password storage and direct email-based account linking were rejected because they would create competing identity authorities and unsafe takeover paths. Authentication methods remain disabled until the provider contract and operational controls are approved.

The product owner later selected Afridict-owned native accounts and direct Google OAuth. ADR 0014 records the replacement controls and retains the prohibition on email-only account linking.
