CREATE TABLE market_media_uploads (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'rejected', 'deleted')),
  provider_reference text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  width integer NOT NULL CHECK (width BETWEEN 32 AND 10000),
  height integer NOT NULL CHECK (height BETWEEN 32 AND 10000),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  deleted_at timestamptz
);

CREATE INDEX market_media_owner_status ON market_media_uploads(owner_id, status, created_at DESC);

ALTER TABLE market_discovery_settings ADD COLUMN hidden boolean NOT NULL DEFAULT false;
