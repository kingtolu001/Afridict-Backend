-- Run as a database administrator after migrations. The login role used by
-- DATABASE_URL must be granted membership separately by an authorized DBA.
-- Do not use the migration owner or this non-login role as an API credential.
CREATE ROLE afridict_runtime NOLOGIN;
GRANT USAGE ON SCHEMA public TO afridict_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO afridict_runtime;
GRANT INSERT ON accounts, eligibility, eligibility_reviews, market_templates,
  country_policies, evidence_sources, policy_registry, market_proposals, markets,
  market_reviews, command_results, audit_events, outbox, outbox_deliveries, inbox,
  ledger_accounts, ledger_journals, ledger_entries, collateral_reservations,
  financial_exceptions, deposit_intents, partner_events, chain_observations, account_assurance, account_profiles,
  contact_verifications, contact_verification_events, identity_inquiries, identity_provider_events, fiat_collection_requests,
  private_payout_details, manual_crypto_withdrawals, crypto_deposit_addresses, crypto_deposit_observations,
  withdrawals, reconciliation_runs
  TO afridict_runtime;
REVOKE INSERT ON market_templates, country_policies, evidence_sources, policy_registry,
  financial_assets, smart_accounts
  FROM afridict_runtime;
GRANT UPDATE ON eligibility, eligibility_reviews, market_proposals, markets,
  command_results, outbox_deliveries, collateral_reservations, financial_exceptions,
  deposit_intents, withdrawals, account_assurance, contact_verifications, identity_inquiries, fiat_collection_requests,
  manual_crypto_withdrawals, crypto_deposit_observations TO afridict_runtime;
-- No UPDATE/DELETE/TRUNCATE on audit_events, outbox, market_reviews or
-- the approved registries; no UPDATE on accounts or published market policy.
