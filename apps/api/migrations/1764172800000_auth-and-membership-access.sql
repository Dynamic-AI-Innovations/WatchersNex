-- Up Migration
--
-- Authentication support (ADR-006) and the two narrow, audited ways the app
-- may cross the tenant boundary. Both are SECURITY DEFINER functions with a
-- fixed search_path and a single, explicit purpose; the tables themselves
-- stay protected by row-level security.

ALTER TABLE users
  ADD COLUMN failed_login_count int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT now();

-- "Which organisations does this user belong to?" is needed before any tenant
-- is chosen (login, organisation switcher). It returns only the caller-supplied
-- user's own memberships; the API passes the ID from the authenticated session.
CREATE FUNCTION wnx_memberships_for_user(p_user_id uuid)
  RETURNS TABLE (organisation_id uuid, role text, name text, slug citext)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.organisation_id, m.role, o.name, o.slug
    FROM memberships m
    JOIN organisations o ON o.id = m.organisation_id
    WHERE m.user_id = p_user_id
      AND o.status = 'active'
    ORDER BY o.name
  $$;
REVOKE ALL ON FUNCTION wnx_memberships_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wnx_memberships_for_user(uuid) TO wnx_app;

-- Account-level audit events (login, password reset) belong to no organisation,
-- so the tenant policy on audit_events can't admit them. This function writes
-- exactly one append-only row with organisation_id NULL.
CREATE FUNCTION wnx_record_account_audit(
  p_id uuid, p_actor_id uuid, p_action text, p_ip inet, p_metadata jsonb)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    INSERT INTO audit_events (id, organisation_id, actor_id, actor_type, action, resource_type, resource_id, ip, metadata)
    VALUES (p_id, NULL, p_actor_id, 'user', p_action, 'user', p_actor_id, p_ip, coalesce(p_metadata, '{}'));
  $$;
REVOKE ALL ON FUNCTION wnx_record_account_audit(uuid, uuid, text, inet, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wnx_record_account_audit(uuid, uuid, text, inet, jsonb) TO wnx_app;

-- Down Migration
DROP FUNCTION IF EXISTS wnx_record_account_audit(uuid, uuid, text, inet, jsonb);
DROP FUNCTION IF EXISTS wnx_memberships_for_user(uuid);
ALTER TABLE users
  DROP COLUMN IF EXISTS password_changed_at,
  DROP COLUMN IF EXISTS locked_until,
  DROP COLUMN IF EXISTS failed_login_count;
