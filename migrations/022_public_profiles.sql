CREATE TABLE public_profiles (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  username text,
  username_normalized text,
  display_name text CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 100),
  bio text CHECK (bio IS NULL OR char_length(bio) <= 500),
  avatar_media_id uuid,
  cover_media_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (username_normalized)
);

CREATE TABLE profile_media_uploads (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('avatar', 'cover')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'rejected', 'deleted')),
  provider_reference text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  width integer NOT NULL CHECK (width BETWEEN 32 AND 10000),
  height integer NOT NULL CHECK (height BETWEEN 32 AND 10000),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX profile_media_account_status ON profile_media_uploads(account_id, status, created_at DESC);
ALTER TABLE public_profiles ADD CONSTRAINT public_profiles_avatar_fk FOREIGN KEY (avatar_media_id) REFERENCES profile_media_uploads(id);
ALTER TABLE public_profiles ADD CONSTRAINT public_profiles_cover_fk FOREIGN KEY (cover_media_id) REFERENCES profile_media_uploads(id);
