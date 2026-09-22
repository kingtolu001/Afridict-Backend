CREATE TABLE google_auth_challenges (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  code_verifier text NOT NULL CHECK (char_length(code_verifier) BETWEEN 43 AND 128),
  intent text NOT NULL CHECK (intent IN ('login','link')),
  account_id uuid REFERENCES accounts(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((intent='link')=(account_id IS NOT NULL)),
  CHECK (expires_at>created_at)
);
CREATE INDEX google_auth_challenge_expiry ON google_auth_challenges(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE google_identities (
  google_subject text PRIMARY KEY CHECK (char_length(google_subject) BETWEEN 1 AND 255),
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id),
  email_at_link text NOT NULL CHECK (char_length(email_at_link)<=254),
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE google_registration_tokens (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  google_subject text NOT NULL CHECK (char_length(google_subject) BETWEEN 1 AND 255),
  email text NOT NULL CHECK (char_length(email)<=254),
  email_authoritative boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at>created_at)
);
CREATE INDEX google_registration_expiry ON google_registration_tokens(expires_at) WHERE consumed_at IS NULL;

CREATE FUNCTION guard_google_auth_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.state_hash<>OLD.state_hash OR NEW.code_verifier<>OLD.code_verifier OR
    NEW.intent<>OLD.intent OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.expires_at<>OLD.expires_at OR
    NEW.created_at<>OLD.created_at OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'Google authorization challenge identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER google_auth_challenge_guard BEFORE UPDATE ON google_auth_challenges
  FOR EACH ROW EXECUTE FUNCTION guard_google_auth_challenge();

CREATE TRIGGER google_identity_immutable BEFORE UPDATE OR DELETE ON google_identities
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION guard_google_registration_token() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.token_hash<>OLD.token_hash OR NEW.google_subject<>OLD.google_subject OR
    NEW.email<>OLD.email OR NEW.email_authoritative<>OLD.email_authoritative OR NEW.expires_at<>OLD.expires_at OR
    NEW.created_at<>OLD.created_at OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'Google registration token identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER google_registration_token_guard BEFORE UPDATE ON google_registration_tokens
  FOR EACH ROW EXECUTE FUNCTION guard_google_registration_token();
