-- Multi-currency markets need limits in each collateral asset's exact minor units.
-- Existing bindings retain the published market-level fallback until reviewed.
ALTER TABLE clob_asset_bindings ADD COLUMN exposure_limit_minor numeric(78,0)
  CHECK (exposure_limit_minor IS NULL OR exposure_limit_minor >= contract_unit_minor);

CREATE OR REPLACE FUNCTION guard_clob_asset_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy_ref<>OLD.policy_ref OR NEW.asset_code<>OLD.asset_code OR
    NEW.contract_unit_minor<>OLD.contract_unit_minor OR NEW.evidence_ref<>OLD.evidence_ref OR
    (OLD.exposure_limit_minor IS NOT NULL AND NEW.exposure_limit_minor IS DISTINCT FROM OLD.exposure_limit_minor) THEN
    RAISE EXCEPTION 'Collateral binding identity, contract unit and exposure limit are immutable';
  END IF;
  RETURN NEW;
END;
$$;
