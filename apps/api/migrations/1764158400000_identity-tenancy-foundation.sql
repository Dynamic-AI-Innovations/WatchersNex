-- Up Migration
--
-- Foundation schema: identity, tenancy, plans, audit and the event outbox.
-- Design reference: Technical Architecture and System Design v0.1, Section 4.
-- Monitors, results and incidents arrive with their own modules (Phase 4).

CREATE EXTENSION IF NOT EXISTS citext;

-- The role every tenant transaction runs as (SET LOCAL ROLE). It can never
-- bypass row-level security, whatever role the connection itself uses.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wnx_app') THEN
    CREATE ROLE wnx_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO wnx_app;
-- Lets the connecting role switch to wnx_app inside a transaction.
GRANT wnx_app TO CURRENT_USER;

-- The tenant of the current transaction, or NULL when none is set.
-- NULLIF matters: on a pooled connection that had the setting before,
-- current_setting returns '' rather than NULL, and ''::uuid would error.
CREATE FUNCTION wnx_current_org() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.current_org', true), '')::uuid $$;

-- plans -----------------------------------------------------------------
CREATE TABLE plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  limits jsonb NOT NULL
);
-- Provisional pilot plan; commercial tiers are defined in pricing validation (G-01).
INSERT INTO plans (id, name, limits) VALUES
  ('pilot', 'Pilot', '{"monitors": 50, "min_interval_seconds": 60, "regions": 4, "seats": 10, "retention_days": 30}');

-- identity --------------------------------------------------------------
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email citext NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'deleted')),
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  mfa_verified boolean NOT NULL DEFAULT false,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE verification_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE mfa_factors (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('totp')),
  secret_ciphertext bytea NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- tenancy ---------------------------------------------------------------
CREATE TABLE organisations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  timezone text NOT NULL DEFAULT 'UTC',
  plan_id text NOT NULL REFERENCES plans (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE memberships (
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  email citext NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  token_hash bytea NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);

-- audit and outbox ------------------------------------------------------
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organisation_id uuid REFERENCES organisations (id),
  actor_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'platform_admin', 'system', 'probe')),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  ip inet,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_org_time_idx ON audit_events (organisation_id, occurred_at DESC);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  organisation_id uuid,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- privileges for wnx_app --------------------------------------------------
GRANT SELECT ON plans TO wnx_app;
GRANT SELECT, INSERT, UPDATE ON users, sessions, verification_tokens TO wnx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_factors TO wnx_app;
GRANT SELECT, INSERT, UPDATE ON organisations TO wnx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, invitations TO wnx_app;
-- Audit is append-only for the application (threat T-09).
GRANT SELECT, INSERT ON audit_events TO wnx_app;
GRANT INSERT ON outbox TO wnx_app;
GRANT USAGE ON SEQUENCE outbox_id_seq TO wnx_app;

-- row-level security ------------------------------------------------------
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organisations
  USING (id = wnx_current_org())
  WITH CHECK (id = wnx_current_org());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (organisation_id = wnx_current_org())
  WITH CHECK (organisation_id = wnx_current_org());

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitations
  USING (organisation_id = wnx_current_org())
  WITH CHECK (organisation_id = wnx_current_org());

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (organisation_id = wnx_current_org())
  WITH CHECK (organisation_id = wnx_current_org());

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox
  USING (organisation_id = wnx_current_org())
  WITH CHECK (organisation_id = wnx_current_org());

-- Down Migration
DROP TABLE IF EXISTS outbox, audit_events, invitations, memberships, organisations,
  mfa_factors, verification_tokens, sessions, users, plans;
DROP FUNCTION IF EXISTS wnx_current_org();
-- The wnx_app role is kept: other databases on the server may use it.
