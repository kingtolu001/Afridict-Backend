CREATE TABLE market_discovery_settings (
  market_id uuid PRIMARY KEY REFERENCES markets(id),
  featured_rank integer CHECK (featured_rank BETWEEN 1 AND 1000),
  updated_by uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX market_featured_rank_unique
  ON market_discovery_settings(featured_rank)
  WHERE featured_rank IS NOT NULL;
