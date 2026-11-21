CREATE TABLE gateway.channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_version_id uuid,
  active_version_id uuid,
  enabled boolean NOT NULL DEFAULT false,
  CHECK (NOT enabled OR active_version_id IS NOT NULL),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE gateway.channel_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES gateway.channels(id) ON DELETE RESTRICT,
  name text NOT NULL,
  credential_ref text NOT NULL,
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  adapter text NOT NULL CHECK (adapter IN ('official','compatible')),
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  UNIQUE(channel_id,id)
);
CREATE INDEX channel_versions_history ON gateway.channel_versions(channel_id,created_at DESC);

-- An inactive row remains the authority for this pair, preventing fallback to an old environment route.
CREATE TABLE gateway.channel_routes (
  model_id uuid NOT NULL REFERENCES gateway.models(id) ON DELETE RESTRICT,
  group_id uuid NOT NULL REFERENCES gateway.pricing_groups(id) ON DELETE RESTRICT,
  channel_id uuid NOT NULL,
  version_id uuid NOT NULL,
  current_binding boolean NOT NULL,
  upstream_model text NOT NULL,
  response_model text NOT NULL,
  streaming boolean NOT NULL,
  token_field text NOT NULL CHECK (token_field IN ('max_tokens','max_completion_tokens')),
  PRIMARY KEY(model_id,group_id),
  FOREIGN KEY(channel_id,version_id) REFERENCES gateway.channel_versions(channel_id,id) ON DELETE RESTRICT
);
CREATE INDEX channel_routes_channel ON gateway.channel_routes(channel_id);

CREATE TABLE gateway.channel_probes (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES gateway.channel_versions(id) ON DELETE RESTRICT,
  binding integer NOT NULL CHECK (binding>=-1),
  rate_id uuid REFERENCES gateway.model_rates(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('pending','passed','auth_failed','model_unavailable','timeout','upstream_unavailable','unverified')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  elapsed_ms integer CHECK (elapsed_ms>=0),
  CHECK ((status='pending') = (finished_at IS NULL))
);
CREATE INDEX channel_probes_latest ON gateway.channel_probes(version_id,binding,started_at DESC,id DESC);
CREATE UNIQUE INDEX channel_probes_one_pending ON gateway.channel_probes(version_id,binding) WHERE status='pending';

ALTER TABLE gateway.usage_requests ADD COLUMN channel_version_id uuid REFERENCES gateway.channel_versions(id) ON DELETE RESTRICT;

CREATE VIEW gateway.channel_runtime_routes AS
  SELECT r.*,v.credential_ref,v.credential_fingerprint,v.adapter,
    (c.enabled AND c.active_version_id=r.version_id AND r.current_binding) AS effective
  FROM gateway.channel_routes r JOIN gateway.channels c ON c.id=r.channel_id
    JOIN gateway.channel_versions v ON v.id=r.version_id;

CREATE FUNCTION gateway.audit_channel(actor uuid,event_id uuid,event_action text,event_outcome text,event_reason text,event_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF event_action NOT IN ('channel.create','channel.edit','channel.probe_started','channel.probe_finished','channel.enable','channel.disable','channel.rollback') OR
    (gateway.admin_role_for(actor) IS DISTINCT FROM 'system_admin' AND NOT (
      (event_outcome='denied' AND event_reason='channel_forbidden' AND event_action IN ('channel.enable','channel.disable','channel.rollback')) OR
      (event_action='channel.probe_finished' AND EXISTS (SELECT 1 FROM gateway.admin_audit_events a
        WHERE a.action='channel.probe_started' AND a.actor_user_id=actor AND a.request_id::text=event_payload->>'probeId')
    ))) THEN
    RAISE EXCEPTION 'Channel audit is restricted';
  END IF;
  INSERT INTO gateway.admin_audit_events(request_id,action,outcome,reason,actor_user_id,details)
    VALUES (event_id,event_action,event_outcome,event_reason,actor,event_payload);
END $$;

REVOKE ALL ON gateway.channels,gateway.channel_versions,gateway.channel_routes,gateway.channel_probes,
  gateway.channel_runtime_routes FROM PUBLIC,opentoken_app;
REVOKE ALL ON FUNCTION gateway.audit_channel(uuid,uuid,text,text,text,jsonb) FROM PUBLIC,opentoken_app;
GRANT SELECT,INSERT,UPDATE ON gateway.channels,gateway.channel_routes,gateway.channel_probes TO opentoken_app;
GRANT SELECT,INSERT,UPDATE(published_at) ON gateway.channel_versions TO opentoken_app;
GRANT SELECT ON gateway.channel_runtime_routes TO opentoken_app;
GRANT EXECUTE ON FUNCTION gateway.audit_channel(uuid,uuid,text,text,text,jsonb) TO opentoken_app;
