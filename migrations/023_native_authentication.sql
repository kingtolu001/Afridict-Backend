CREATE TABLE auth_credentials (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE CHECK (char_length(email) <= 254),
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_account ON auth_sessions(account_id, expires_at DESC);

CREATE TABLE password_reset_challenges (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_reference text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_account ON password_reset_challenges(account_id, created_at DESC);

CREATE TRIGGER auth_session_no_delete BEFORE DELETE ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER password_reset_no_delete BEFORE DELETE ON password_reset_challenges
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
