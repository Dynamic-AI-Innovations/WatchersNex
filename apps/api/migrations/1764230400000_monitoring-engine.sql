-- Up Migration
--
-- Monitoring engine, core region (WP-04/WP-05; Technical Architecture
-- Sections 3, 4 and 7). Every table is tenant-scoped with forced RLS. The
-- check worker crosses tenants only through wnx_claim_due_monitors(), which
-- returns the minimum needed to run a check and nothing else.

CREATE TABLE monitors (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  type text NOT NULL CHECK (type IN ('http', 'api', 'ssl', 'dns')),
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 2048),
  config jsonb NOT NULL DEFAULT '{}',
  interval_seconds int NOT NULL CHECK (interval_seconds IN (60, 300, 600)),
  criticality text NOT NULL DEFAULT 'standard' CHECK (criticality IN ('critical', 'standard', 'low')),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users (id),
  authorisation_attested_at timestamptz NOT NULL,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX monitors_org_idx ON monitors (organisation_id) WHERE deleted_at IS NULL;
CREATE INDEX monitors_due_idx ON monitors (next_check_at) WHERE enabled AND deleted_at IS NULL;

CREATE TABLE monitor_states (
  monitor_id uuid PRIMARY KEY REFERENCES monitors (id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'up', 'suspected', 'down', 'recovering', 'paused')),
  consecutive_failures int NOT NULL DEFAULT 0,
  consecutive_successes int NOT NULL DEFAULT 0,
  first_failure_at timestamptz,
  open_incident_id uuid,
  last_checked_at timestamptz,
  last_outcome text,
  last_status_code smallint,
  last_latency_ms int,
  last_failure_class text,
  last_detail text,
  version bigint NOT NULL DEFAULT 0
);

-- Raw results, partitioned by day and dropped whole when past retention.
CREATE TABLE check_results (
  monitor_id uuid NOT NULL,
  organisation_id uuid NOT NULL,
  region text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  checked_at timestamptz NOT NULL,
  attempt smallint NOT NULL DEFAULT 1,
  outcome text NOT NULL CHECK (outcome IN ('up', 'down')),
  failure_class text,
  status_code smallint,
  latency_ms int,
  timings_ms jsonb,
  detail jsonb,
  PRIMARY KEY (monitor_id, checked_at, attempt)
) PARTITION BY RANGE (checked_at);
-- Safety net: a result never fails to insert for want of a partition.
CREATE TABLE check_results_default PARTITION OF check_results DEFAULT;
CREATE INDEX check_results_org_time_idx ON check_results (organisation_id, checked_at DESC);

CREATE TABLE incidents (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  number int NOT NULL,
  monitor_id uuid NOT NULL REFERENCES monitors (id),
  title text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  status text NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
  started_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users (id),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users (id),
  UNIQUE (organisation_id, number)
);
-- At most one unresolved incident per monitor, even under concurrent evaluation.
CREATE UNIQUE INDEX incidents_one_open_per_monitor ON incidents (monitor_id) WHERE status <> 'resolved';
CREATE INDEX incidents_org_started_idx ON incidents (organisation_id, started_at DESC);

CREATE TABLE incident_events (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations (id),
  incident_id uuid NOT NULL REFERENCES incidents (id),
  type text NOT NULL CHECK (type IN ('opened', 'notified', 'acknowledged', 'note', 'severity_changed', 'resolved', 'reopened')),
  actor_id uuid REFERENCES users (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX incident_events_incident_idx ON incident_events (incident_id, occurred_at);

-- Privileges -------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON monitors, monitor_states, incidents TO wnx_app;
GRANT SELECT, INSERT ON check_results, incident_events TO wnx_app;

-- Row-level security -----------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['monitors', 'monitor_states', 'check_results', 'incidents', 'incident_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organisation_id = wnx_current_org()) WITH CHECK (organisation_id = wnx_current_org())', t);
  END LOOP;
END
$$;

-- Worker entry point -----------------------------------------------------
-- Claims up to p_limit due monitors across all tenants and moves their next
-- run forward by one interval plus up to 2 s of jitter, in one statement, so
-- two workers can never claim the same check (SKIP LOCKED).
CREATE FUNCTION wnx_claim_due_monitors(p_limit int)
  RETURNS TABLE (id uuid, organisation_id uuid, type text, target text, config jsonb,
                 interval_seconds int, criticality text, scheduled_at timestamptz)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH due AS (
      SELECT m.id, m.next_check_at
      FROM monitors m
      WHERE m.enabled AND m.deleted_at IS NULL AND m.next_check_at <= now()
      ORDER BY m.next_check_at
      LIMIT LEAST(GREATEST(p_limit, 1), 200)
      FOR UPDATE SKIP LOCKED
    )
    UPDATE monitors m
       SET next_check_at = greatest(due.next_check_at + make_interval(secs => m.interval_seconds), now())
                           + make_interval(secs => random() * 2)
      FROM due
     WHERE m.id = due.id
    RETURNING m.id, m.organisation_id, m.type, m.target, m.config, m.interval_seconds, m.criticality, due.next_check_at
  $$;
REVOKE ALL ON FUNCTION wnx_claim_due_monitors(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wnx_claim_due_monitors(int) TO wnx_app;

-- Keeps daily result partitions ahead of time and drops ones past retention.
CREATE FUNCTION wnx_maintain_result_partitions(p_days_ahead int, p_retention_days int)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    d date;
    part record;
  BEGIN
    FOR i IN 0..GREATEST(p_days_ahead, 1) LOOP
      d := current_date + i;
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF check_results FOR VALUES FROM (%L) TO (%L)',
        'check_results_' || to_char(d, 'YYYYMMDD'), d, d + 1);
    END LOOP;
    FOR part IN
      SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'check_results'
        AND c.relname ~ '^check_results_[0-9]{8}$'
        AND to_date(substring(c.relname from 15), 'YYYYMMDD') < current_date - GREATEST(p_retention_days, 7)
    LOOP
      EXECUTE format('DROP TABLE %I', part.relname);
    END LOOP;
  END
  $$;
REVOKE ALL ON FUNCTION wnx_maintain_result_partitions(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wnx_maintain_result_partitions(int, int) TO wnx_app;

SELECT wnx_maintain_result_partitions(3, 30);

-- Down Migration
DROP FUNCTION IF EXISTS wnx_maintain_result_partitions(int, int);
DROP FUNCTION IF EXISTS wnx_claim_due_monitors(int);
DROP TABLE IF EXISTS incident_events, incidents, check_results, monitor_states, monitors;
