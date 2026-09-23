ALTER TABLE fiat_collection_requests DROP CONSTRAINT fiat_collection_requests_state_check;
ALTER TABLE fiat_collection_requests DROP CONSTRAINT fiat_collection_requests_check;
ALTER TABLE fiat_collection_requests ADD COLUMN provider_transaction_id text UNIQUE;
ALTER TABLE fiat_collection_requests ADD COLUMN settled_minor numeric(78,0) CHECK (settled_minor>0);
ALTER TABLE fiat_collection_requests ADD CONSTRAINT fiat_collection_requests_state_check CHECK
  (state IN ('instruction_pending','instruction_creating','instructions_available','instruction_uncertain','settled'));
ALTER TABLE fiat_collection_requests ADD CONSTRAINT fiat_collection_requests_instruction_check CHECK
  ((state IN ('instructions_available','settled')) = (provider_reference IS NOT NULL AND account_name IS NOT NULL
    AND account_number IS NOT NULL AND bank_code IS NOT NULL AND bank_name IS NOT NULL));
ALTER TABLE fiat_collection_requests ADD CONSTRAINT fiat_collection_requests_settlement_check CHECK
  ((state='settled') = (provider_transaction_id IS NOT NULL AND settled_minor IS NOT NULL));

