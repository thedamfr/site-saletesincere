-- Additive and safe to apply twice. Application rollback must retain this table:
-- dropping it would remove the barrier against repeating an uncertain effect.
CREATE TABLE IF NOT EXISTS newsletter_requests (
  id uuid PRIMARY KEY,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  list_id bigint NOT NULL CHECK (list_id > 0),
  state text NOT NULL DEFAULT 'ready'
    CHECK (state IN ('ready', 'sending', 'submitted', 'uncertain', 'rejected')),
  phase text CHECK (phase IN ('create_contact', 'add_to_list')),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempted_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (email, list_id)
);

CREATE INDEX IF NOT EXISTS newsletter_requests_recovery_idx
  ON newsletter_requests (next_attempt_at, created_at)
  WHERE state IN ('ready', 'sending', 'uncertain');

REVOKE ALL ON newsletter_requests FROM PUBLIC;

-- Keep every attempted mutation, including explicit rejections later retried.
-- Neither app rollback nor retry may erase this append-only history.
CREATE TABLE IF NOT EXISTS newsletter_attempts (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES newsletter_requests(id),
  phase text NOT NULL CHECK (phase IN ('create_contact', 'add_to_list')),
  attempted_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS newsletter_attempts_request_idx
  ON newsletter_attempts (request_id, attempted_at);

REVOKE ALL ON newsletter_attempts FROM PUBLIC;

CREATE OR REPLACE FUNCTION protect_newsletter_attempts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'newsletter_attempts_are_immutable' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS newsletter_attempts_immutable ON newsletter_attempts;
CREATE TRIGGER newsletter_attempts_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON newsletter_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION protect_newsletter_attempts();
