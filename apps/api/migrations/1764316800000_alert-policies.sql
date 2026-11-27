-- Up Migration
--
-- Alert policies (FR-011): who is told about incidents, for which severities
-- and events. An organisation with no enabled policy falls back to emailing
-- every owner and admin, so nobody is ever left unalerted by default.

CREATE TABLE alert_policies (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Alerts fire for incidents at this severity or more severe (sev1 is most severe).
  min_severity text NOT NULL DEFAULT 'sev4' CHECK (min_severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  notify_on text[] NOT NULL DEFAULT '{opened,resolved}' CHECK (notify_on <@ ARRAY['opened', 'resolved']::text[] AND cardinality(notify_on) > 0),
  -- Members by user ID, plus addresses outside the organisation (on-call aliases, distribution lists).
  member_ids uuid[] NOT NULL DEFAULT '{}',
  external_emails text[] NOT NULL DEFAULT '{}' CHECK (cardinality(external_emails) <= 20),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_policies_org_idx ON alert_policies (organisation_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON alert_policies TO wnx_app;
GRANT DELETE ON invitations TO wnx_app;

ALTER TABLE alert_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON alert_policies
  USING (organisation_id = wnx_current_org())
  WITH CHECK (organisation_id = wnx_current_org());

-- Accepting an invitation happens before the invitee belongs to the
-- organisation, so it can't run under that tenant's RLS context from the
-- invitee's side. This function does exactly one thing: given the hash of a
-- valid, unexpired, unused invitation token and the accepting user's ID and
-- email, it records the membership if the emails match. Returns the
-- organisation ID, or NULL when the token is invalid or the email differs.
CREATE FUNCTION wnx_accept_invitation(p_token_hash bytea, p_user_id uuid, p_email citext)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    inv record;
  BEGIN
    SELECT * INTO inv FROM invitations
     WHERE token_hash = p_token_hash AND accepted_at IS NULL AND expires_at > now()
     FOR UPDATE;
    IF NOT FOUND OR inv.email <> p_email THEN
      RETURN NULL;
    END IF;
    INSERT INTO memberships (organisation_id, user_id, role)
    VALUES (inv.organisation_id, p_user_id, inv.role)
    ON CONFLICT (organisation_id, user_id) DO NOTHING;
    UPDATE invitations SET accepted_at = now() WHERE id = inv.id;
    INSERT INTO audit_events (id, organisation_id, actor_id, actor_type, action, resource_type, resource_id, metadata)
    VALUES (gen_random_uuid(), inv.organisation_id, p_user_id, 'user', 'member.join', 'invitation', inv.id,
            jsonb_build_object('role', inv.role));
    RETURN inv.organisation_id;
  END
  $$;
REVOKE ALL ON FUNCTION wnx_accept_invitation(bytea, uuid, citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wnx_accept_invitation(bytea, uuid, citext) TO wnx_app;

-- An invitee who opens the link needs to see which organisation invited them
-- and with what role, before accepting. Returns nothing for invalid tokens.
CREATE FUNCTION wnx_invitation_preview(p_token_hash bytea)
  RETURNS TABLE (organisation_name text, role text, email citext, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT o.name, i.role, i.email, i.expires_at
    FROM invitations i JOIN organisations o ON o.id = i.organisation_id
    WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.expires_at > now()
  $$;
REVOKE ALL ON FUNCTION wnx_invitation_preview(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wnx_invitation_preview(bytea) TO wnx_app;

-- Down Migration
DROP FUNCTION IF EXISTS wnx_invitation_preview(bytea);
DROP FUNCTION IF EXISTS wnx_accept_invitation(bytea, uuid, citext);
REVOKE DELETE ON invitations FROM wnx_app;
DROP TABLE IF EXISTS alert_policies;
