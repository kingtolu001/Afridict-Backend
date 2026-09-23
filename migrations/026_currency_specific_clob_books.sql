-- A published prediction market can expose isolated collateral books. The market
-- resolution remains shared, while matching, sequences and financial effects are
-- keyed by an immutable book identity.
ALTER TABLE clob_asset_bindings DROP CONSTRAINT clob_asset_bindings_pkey;
ALTER TABLE clob_asset_bindings ADD PRIMARY KEY (policy_ref,asset_code);

ALTER TABLE clob_markets ADD COLUMN id uuid;
UPDATE clob_markets SET id=market_id;
ALTER TABLE clob_markets ALTER COLUMN id SET NOT NULL;
ALTER TABLE clob_markets ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE clob_orders ADD COLUMN book_id uuid;
ALTER TABLE clob_fills ADD COLUMN book_id uuid;
ALTER TABLE clob_events ADD COLUMN book_id uuid;
UPDATE clob_orders SET book_id=market_id;
UPDATE clob_fills SET book_id=market_id;
UPDATE clob_events SET book_id=market_id;
ALTER TABLE clob_orders ALTER COLUMN book_id SET NOT NULL;
ALTER TABLE clob_fills ALTER COLUMN book_id SET NOT NULL;
ALTER TABLE clob_events ALTER COLUMN book_id SET NOT NULL;

ALTER TABLE clob_orders DROP CONSTRAINT clob_orders_market_id_fkey;
ALTER TABLE clob_fills DROP CONSTRAINT clob_fills_market_id_fkey;
ALTER TABLE clob_events DROP CONSTRAINT clob_events_market_id_fkey;
ALTER TABLE rfq_requests DROP CONSTRAINT rfq_requests_market_id_fkey;
ALTER TABLE rfq_fills DROP CONSTRAINT rfq_fills_market_id_fkey;
ALTER TABLE clob_markets DROP CONSTRAINT clob_markets_pkey;
ALTER TABLE clob_markets ADD PRIMARY KEY (id);
ALTER TABLE clob_markets ADD CONSTRAINT clob_markets_market_asset_key UNIQUE (market_id,asset_code);
ALTER TABLE clob_orders ADD CONSTRAINT clob_orders_book_id_fkey FOREIGN KEY (book_id) REFERENCES clob_markets(id);
ALTER TABLE clob_fills ADD CONSTRAINT clob_fills_book_id_fkey FOREIGN KEY (book_id) REFERENCES clob_markets(id);
ALTER TABLE clob_events ADD CONSTRAINT clob_events_book_id_fkey FOREIGN KEY (book_id) REFERENCES clob_markets(id);
ALTER TABLE rfq_requests ADD CONSTRAINT rfq_requests_market_id_fkey FOREIGN KEY (market_id) REFERENCES markets(id);
ALTER TABLE rfq_fills ADD CONSTRAINT rfq_fills_market_id_fkey FOREIGN KEY (market_id) REFERENCES markets(id);

ALTER TABLE clob_orders DROP CONSTRAINT clob_orders_market_id_sequence_key;
ALTER TABLE clob_orders ADD CONSTRAINT clob_orders_book_sequence_key UNIQUE (book_id,sequence);
ALTER TABLE clob_fills DROP CONSTRAINT clob_fills_market_id_sequence_key;
ALTER TABLE clob_fills ADD CONSTRAINT clob_fills_book_sequence_key UNIQUE (book_id,sequence);
ALTER TABLE clob_events DROP CONSTRAINT clob_events_pkey;
ALTER TABLE clob_events ADD PRIMARY KEY (book_id,sequence);

DROP INDEX clob_book;
CREATE INDEX clob_book ON clob_orders(book_id,outcome_id,side,limit_price,sequence) WHERE state='open';
DROP INDEX clob_owner_orders;
CREATE INDEX clob_owner_orders ON clob_orders(owner_id,book_id,sequence DESC);
DROP INDEX clob_market_fills;
CREATE INDEX clob_market_fills ON clob_fills(book_id,sequence);

CREATE OR REPLACE FUNCTION guard_clob_market_collateral() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.market_id<>OLD.market_id OR NEW.asset_code<>OLD.asset_code OR
    NEW.contract_unit_minor<>OLD.contract_unit_minor OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Market book identity and collateral are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_clob_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.book_id<>OLD.book_id OR NEW.market_id<>OLD.market_id OR NEW.owner_id<>OLD.owner_id OR
    NEW.reservation_id<>OLD.reservation_id OR NEW.outcome_id<>OLD.outcome_id OR
    NEW.side<>OLD.side OR NEW.limit_price<>OLD.limit_price OR
    NEW.quantity<>OLD.quantity OR NEW.reserved_per_share<>OLD.reserved_per_share OR
    NEW.sequence<>OLD.sequence OR NEW.created_at<>OLD.created_at OR
    NEW.remaining>OLD.remaining OR
    (OLD.state<>'open' AND NEW.state<>OLD.state) OR
    (NEW.state='open' AND NEW.remaining=0) THEN
    RAISE EXCEPTION 'CLOB order identity and terminal state are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION verify_clob_fill_collateral() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE contract_unit numeric; book_market uuid;
BEGIN
  SELECT contract_unit_minor,market_id INTO contract_unit,book_market FROM clob_markets WHERE id=NEW.book_id;
  IF contract_unit IS NULL OR book_market<>NEW.market_id OR
    NEW.buyer_collateral+NEW.seller_collateral<>NEW.quantity*contract_unit THEN
    RAISE EXCEPTION 'CLOB fill must conserve its governed book contract unit';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION verify_resolution_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; case_state text; journal_kind text; journal_asset text; market_asset text;
BEGIN
  SELECT f.quantity*m.contract_unit_minor,m.asset_code INTO expected,market_asset
  FROM clob_fills f JOIN clob_markets m ON m.id=f.book_id
  WHERE f.id=NEW.fill_id AND f.market_id=NEW.market_id;
  SELECT state INTO case_state FROM resolution_cases WHERE market_id=NEW.market_id;
  SELECT kind,asset_code INTO journal_kind,journal_asset FROM ledger_journals
  WHERE id=NEW.journal_id AND reference_id=NEW.fill_id::text;
  IF expected IS NULL OR NEW.buyer_minor+NEW.seller_minor<>expected OR
    case_state IS DISTINCT FROM 'finalized' OR journal_kind IS DISTINCT FROM 'resolution_redemption' OR
    journal_asset IS DISTINCT FROM market_asset THEN
    RAISE EXCEPTION 'Redemption must conserve one finalized matched payout';
  END IF;
  RETURN NEW;
END;
$$;

-- AMM pools and quotes inherit the same currency-specific book identity.
ALTER TABLE amm_reference_prices ADD COLUMN asset_code text;
ALTER TABLE amm_quotes ADD COLUMN asset_code text;
UPDATE amm_reference_prices r SET asset_code=p.asset_code FROM amm_pools p
  WHERE p.market_id=r.market_id AND p.outcome_id=r.outcome_id;
UPDATE amm_quotes q SET asset_code=p.asset_code FROM amm_pools p
  WHERE p.market_id=q.market_id AND p.outcome_id=q.outcome_id;
ALTER TABLE amm_reference_prices ALTER COLUMN asset_code SET NOT NULL;
ALTER TABLE amm_quotes ALTER COLUMN asset_code SET NOT NULL;
ALTER TABLE amm_reference_prices ADD CONSTRAINT amm_reference_prices_asset_fkey FOREIGN KEY (asset_code) REFERENCES financial_assets(code);
ALTER TABLE amm_quotes ADD CONSTRAINT amm_quotes_asset_fkey FOREIGN KEY (asset_code) REFERENCES financial_assets(code);
ALTER TABLE amm_reference_prices DROP CONSTRAINT amm_reference_prices_market_id_outcome_id_fkey;
ALTER TABLE amm_quotes DROP CONSTRAINT amm_quotes_market_id_outcome_id_fkey;
ALTER TABLE amm_pools DROP CONSTRAINT amm_pools_pkey;
ALTER TABLE amm_pools ADD PRIMARY KEY (market_id,outcome_id,asset_code);
ALTER TABLE amm_reference_prices ADD CONSTRAINT amm_reference_prices_pool_fkey
  FOREIGN KEY (market_id,outcome_id,asset_code) REFERENCES amm_pools(market_id,outcome_id,asset_code);
ALTER TABLE amm_quotes ADD CONSTRAINT amm_quotes_pool_fkey
  FOREIGN KEY (market_id,outcome_id,asset_code) REFERENCES amm_pools(market_id,outcome_id,asset_code);
DROP INDEX amm_reference_latest;
CREATE INDEX amm_reference_latest ON amm_reference_prices(market_id,outcome_id,asset_code,observed_at DESC);

CREATE OR REPLACE FUNCTION guard_amm_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.market_id<>OLD.market_id OR
    NEW.outcome_id<>OLD.outcome_id OR NEW.asset_code<>OLD.asset_code OR NEW.side<>OLD.side OR NEW.quantity<>OLD.quantity OR
    NEW.reference_price_id<>OLD.reference_price_id OR NEW.price<>OLD.price OR
    NEW.user_collateral<>OLD.user_collateral OR NEW.amm_collateral<>OLD.amm_collateral OR
    NEW.fee<>OLD.fee OR NEW.user_total<>OLD.user_total OR NEW.expires_at<>OLD.expires_at OR
    NEW.created_at<>OLD.created_at OR OLD.state<>'quoted' OR NEW.state NOT IN ('executed','expired') THEN
    RAISE EXCEPTION 'AMM quote identity and terminal state are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION verify_amm_pool_collateral() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE market_unit numeric;
BEGIN
  SELECT contract_unit_minor INTO market_unit FROM clob_markets
    WHERE market_id=NEW.market_id AND asset_code=NEW.asset_code;
  IF market_unit IS NULL OR NEW.contract_unit_minor<>market_unit OR
    (TG_OP='UPDATE' AND (NEW.market_id<>OLD.market_id OR NEW.outcome_id<>OLD.outcome_id OR
      NEW.asset_code<>OLD.asset_code OR NEW.contract_unit_minor<>OLD.contract_unit_minor)) THEN
    RAISE EXCEPTION 'AMM collateral must match an immutable market book';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION verify_amm_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; quote_owner uuid; quote_state text; case_state text;
  journal_kind text; journal_asset text; market_asset text;
BEGIN
  SELECT q.quantity*p.contract_unit_minor,q.owner_id,q.state,p.asset_code
    INTO expected,quote_owner,quote_state,market_asset
  FROM amm_quotes q JOIN amm_pools p ON p.market_id=q.market_id AND p.outcome_id=q.outcome_id AND p.asset_code=q.asset_code
  WHERE q.id=NEW.quote_id AND q.market_id=NEW.market_id;
  SELECT state INTO case_state FROM resolution_cases WHERE market_id=NEW.market_id;
  SELECT kind,asset_code INTO journal_kind,journal_asset FROM ledger_journals
    WHERE id=NEW.journal_id AND reference_id=NEW.quote_id::text;
  IF expected IS NULL OR NEW.owner_id<>quote_owner OR NEW.user_minor+NEW.treasury_minor<>expected OR
    quote_state IS DISTINCT FROM 'executed' OR case_state IS DISTINCT FROM 'finalized' OR
    journal_kind IS DISTINCT FROM 'resolution_redemption' OR journal_asset IS DISTINCT FROM market_asset THEN
    RAISE EXCEPTION 'AMM redemption must conserve one finalized executed quote';
  END IF;
  RETURN NEW;
END;
$$;

-- RFQ requests name their collateral book explicitly; quotes inherit it.
ALTER TABLE rfq_requests ADD COLUMN asset_code text;
ALTER TABLE rfq_fills ADD COLUMN asset_code text;
UPDATE rfq_requests r SET asset_code=m.asset_code FROM clob_markets m WHERE m.market_id=r.market_id;
UPDATE rfq_fills f SET asset_code=m.asset_code FROM clob_markets m WHERE m.market_id=f.market_id;
ALTER TABLE rfq_requests ALTER COLUMN asset_code SET NOT NULL;
ALTER TABLE rfq_fills ALTER COLUMN asset_code SET NOT NULL;
ALTER TABLE rfq_requests ADD CONSTRAINT rfq_requests_asset_fkey FOREIGN KEY (asset_code) REFERENCES financial_assets(code);
ALTER TABLE rfq_fills ADD CONSTRAINT rfq_fills_asset_fkey FOREIGN KEY (asset_code) REFERENCES financial_assets(code);
ALTER TABLE rfq_fills DROP CONSTRAINT rfq_fills_market_id_sequence_key;
ALTER TABLE rfq_fills ADD CONSTRAINT rfq_fills_book_sequence_key UNIQUE(market_id,asset_code,sequence);

CREATE OR REPLACE FUNCTION guard_rfq_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.entity_id<>OLD.entity_id OR NEW.owner_id<>OLD.owner_id OR
    NEW.market_id<>OLD.market_id OR NEW.asset_code<>OLD.asset_code OR NEW.outcome_id<>OLD.outcome_id OR NEW.side<>OLD.side OR
    NEW.quantity<>OLD.quantity OR NEW.expires_at<>OLD.expires_at OR NEW.created_at<>OLD.created_at OR
    OLD.state<>'open' OR NEW.state NOT IN ('accepted','cancelled','expired') THEN
    RAISE EXCEPTION 'RFQ request identity and terminal state are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION verify_rfq_fill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row rfq_requests%ROWTYPE; quote_row rfq_quotes%ROWTYPE;
  journal_kind text; journal_asset text; contract_unit numeric;
BEGIN
  SELECT * INTO request_row FROM rfq_requests WHERE id=NEW.request_id;
  SELECT * INTO quote_row FROM rfq_quotes WHERE id=NEW.quote_id;
  SELECT kind,asset_code INTO journal_kind,journal_asset FROM ledger_journals
    WHERE id=NEW.journal_id AND reference_id=NEW.id::text;
  SELECT contract_unit_minor INTO contract_unit FROM clob_markets
    WHERE market_id=NEW.market_id AND asset_code=NEW.asset_code;
  IF request_row.id IS NULL OR quote_row.id IS NULL OR request_row.state<>'open' OR quote_row.state<>'open' OR
    quote_row.request_id<>request_row.id OR NEW.market_id<>request_row.market_id OR NEW.asset_code<>request_row.asset_code OR
    NEW.requester_entity_id<>request_row.entity_id OR NEW.dealer_entity_id<>quote_row.dealer_entity_id OR
    NEW.requester_owner_id<>request_row.owner_id OR NEW.dealer_owner_id<>quote_row.dealer_owner_id OR
    NEW.requester_side<>request_row.side OR NEW.outcome_id<>request_row.outcome_id OR
    NEW.price<>quote_row.price OR NEW.quantity<>request_row.quantity OR journal_kind<>'rfq_execution' OR
    journal_asset<>NEW.asset_code OR contract_unit IS NULL OR
    NEW.buyer_collateral+NEW.seller_collateral<>NEW.quantity*contract_unit THEN
    RAISE EXCEPTION 'RFQ fill must match its signed quote, request, governed collateral and execution journal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION verify_rfq_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; case_state text; journal_kind text; journal_asset text; market_asset text;
BEGIN
  SELECT f.quantity*m.contract_unit_minor,f.asset_code INTO expected,market_asset
  FROM rfq_fills f JOIN clob_markets m ON m.market_id=f.market_id AND m.asset_code=f.asset_code
  WHERE f.id=NEW.fill_id AND f.market_id=NEW.market_id;
  SELECT state INTO case_state FROM resolution_cases WHERE market_id=NEW.market_id;
  SELECT kind,asset_code INTO journal_kind,journal_asset FROM ledger_journals
  WHERE id=NEW.journal_id AND reference_id=NEW.fill_id::text;
  IF expected IS NULL OR NEW.buyer_minor+NEW.seller_minor<>expected OR
    case_state IS DISTINCT FROM 'finalized' OR journal_kind IS DISTINCT FROM 'resolution_redemption' OR
    journal_asset IS DISTINCT FROM market_asset THEN
    RAISE EXCEPTION 'RFQ redemption must conserve one finalized fill payout';
  END IF;
  RETURN NEW;
END;
$$;
