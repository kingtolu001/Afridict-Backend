CREATE TABLE crypto_deposit_addresses (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES accounts(id),
  asset_code text NOT NULL REFERENCES token_asset_registry(asset_code),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  address text NOT NULL CHECK (address ~ '^0x[a-f0-9]{40}$'),
  custody_reference text NOT NULL UNIQUE,
  evidence_ref text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','retired','exception')),
  provisioned_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id,address)
);
CREATE UNIQUE INDEX crypto_deposit_address_active_owner_asset
  ON crypto_deposit_addresses(owner_id,asset_code) WHERE state='active';

CREATE TABLE crypto_deposit_observations (
  id uuid PRIMARY KEY,
  address_id uuid NOT NULL REFERENCES crypto_deposit_addresses(id),
  owner_id uuid NOT NULL REFERENCES accounts(id),
  asset_code text NOT NULL REFERENCES token_asset_registry(asset_code),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[a-f0-9]{40}$'),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[a-f0-9]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[a-f0-9]{64}$'),
  amount_minor numeric(78,0) NOT NULL CHECK (amount_minor > 0),
  confirmations integer NOT NULL CHECK (confirmations >= 0),
  finality_policy_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('confirming','finalized','reverted','exception')),
  journal_id uuid UNIQUE REFERENCES ledger_journals(id),
  observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  reverted_at timestamptz,
  UNIQUE (chain_id,transaction_hash,log_index),
  CHECK ((state='finalized' OR (state='exception' AND journal_id IS NOT NULL))=(journal_id IS NOT NULL)),
  CHECK ((journal_id IS NOT NULL)=(finalized_at IS NOT NULL)),
  CHECK ((state='reverted')=(reverted_at IS NOT NULL))
);
CREATE INDEX crypto_deposit_observation_owner ON crypto_deposit_observations(owner_id,observed_at DESC);
CREATE INDEX crypto_deposit_observation_pending ON crypto_deposit_observations(state,updated_at)
  WHERE state='confirming';

CREATE FUNCTION guard_crypto_deposit_address() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.asset_code<>OLD.asset_code OR
    NEW.chain_id<>OLD.chain_id OR NEW.address<>OLD.address OR NEW.custody_reference<>OLD.custody_reference OR
    NEW.evidence_ref<>OLD.evidence_ref OR NEW.provisioned_by<>OLD.provisioned_by OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Crypto deposit address identity is immutable';
  END IF;
  IF NOT ((OLD.state='active' AND NEW.state IN ('retired','exception')) OR NEW.state=OLD.state) THEN
    RAISE EXCEPTION 'Invalid crypto deposit address transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crypto_deposit_address_guard BEFORE UPDATE ON crypto_deposit_addresses
  FOR EACH ROW EXECUTE FUNCTION guard_crypto_deposit_address();
CREATE TRIGGER crypto_deposit_address_no_delete BEFORE DELETE ON crypto_deposit_addresses
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION guard_crypto_deposit_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.address_id<>OLD.address_id OR NEW.owner_id<>OLD.owner_id OR
    NEW.asset_code<>OLD.asset_code OR NEW.chain_id<>OLD.chain_id OR NEW.contract_address<>OLD.contract_address OR
    NEW.transaction_hash<>OLD.transaction_hash OR NEW.log_index<>OLD.log_index OR NEW.amount_minor<>OLD.amount_minor OR
    NEW.finality_policy_ref<>OLD.finality_policy_ref OR NEW.observed_at<>OLD.observed_at THEN
    RAISE EXCEPTION 'Crypto deposit observation identity is immutable';
  END IF;
  IF NEW.confirmations<OLD.confirmations AND NEW.state NOT IN ('reverted','exception') THEN
    RAISE EXCEPTION 'Crypto deposit confirmations cannot decrease without an exception';
  END IF;
  IF NOT ((OLD.state='confirming' AND NEW.state IN ('confirming','finalized','reverted','exception')) OR
    (OLD.state='finalized' AND NEW.state IN ('finalized','exception')) OR NEW.state=OLD.state) THEN
    RAISE EXCEPTION 'Invalid crypto deposit observation transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crypto_deposit_observation_guard BEFORE UPDATE ON crypto_deposit_observations
  FOR EACH ROW EXECUTE FUNCTION guard_crypto_deposit_observation();
CREATE TRIGGER crypto_deposit_observation_no_delete BEFORE DELETE ON crypto_deposit_observations
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
