CREATE INDEX clob_fills_public_history
  ON clob_fills(book_id,outcome_id,created_at,sequence);

CREATE INDEX amm_quotes_public_history
  ON amm_quotes(market_id,asset_code,outcome_id,executed_at)
  WHERE state='executed';

CREATE INDEX rfq_fills_public_history
  ON rfq_fills(market_id,asset_code,outcome_id,created_at,sequence);
