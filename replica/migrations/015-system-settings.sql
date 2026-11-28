CREATE TABLE gateway.setting_versions (
  version integer PRIMARY KEY CHECK (version >= 0),
  announcement text NOT NULL CHECK (length(announcement) <= 1000),
  support_url text NOT NULL CHECK (support_url='' OR
    (length(support_url)<=512 AND support_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^[:space:]?#]*)?$')),
  time_zone text NOT NULL,
  single_micros bigint NOT NULL CHECK (single_micros>=0),
  daily_micros bigint NOT NULL CHECK (daily_micros>=0)
);
REVOKE ALL ON gateway.setting_versions FROM PUBLIC,opentoken_app;

CREATE FUNCTION gateway.site_display() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT coalesce((SELECT jsonb_build_object('announcement',announcement,'supportUrl',support_url,'timeZone',time_zone)
    FROM gateway.setting_versions ORDER BY version DESC LIMIT 1),
    '{"announcement":"","supportUrl":"","timeZone":"UTC"}'::jsonb);
$$;

CREATE FUNCTION gateway.admin_settings(actor uuid,legacy_single bigint,legacy_daily bigint,older_than integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  role_name text := gateway.admin_role_for(actor);
  current_row jsonb;
  history jsonb;
BEGIN
  IF role_name IS NULL OR role_name NOT IN ('system_admin','operator') THEN RETURN NULL; END IF;
  SELECT gateway.site_display() || jsonb_build_object('version',coalesce(v.version,0),
    'singleMicros',coalesce(v.single_micros,legacy_single)::text,'dailyMicros',coalesce(v.daily_micros,legacy_daily)::text)
    INTO current_row FROM (VALUES(1)) dummy(n)
    LEFT JOIN (SELECT * FROM gateway.setting_versions ORDER BY version DESC LIMIT 1) v ON true;
  IF role_name='operator' THEN RETURN jsonb_build_object('current',current_row); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('version',version,'announcement',announcement,'supportUrl',support_url,
      'timeZone',time_zone,'singleMicros',single_micros::text,'dailyMicros',daily_micros::text) ORDER BY version DESC),'[]'::jsonb)
    INTO history FROM (SELECT * FROM gateway.setting_versions WHERE older_than IS NULL OR version<older_than
      ORDER BY version DESC LIMIT 20) page;
  IF current_row->>'version'='0' AND older_than IS NULL THEN history := jsonb_build_array(current_row); END IF;
  RETURN jsonb_build_object('current',current_row,'history',history);
END $$;

CREATE FUNCTION gateway.write_settings(actor uuid,expected integer,restore_id integer,fields jsonb,reason text,
  recent boolean,legacy_single bigint,legacy_daily bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  prior integer;
  next_row gateway.setting_versions%ROWTYPE;
  denied text;
  event_id uuid;
  action_name text := CASE WHEN restore_id IS NULL THEN 'settings.publish' ELSE 'settings.rollback' END;
BEGIN
  PERFORM pg_advisory_xact_lock(961020038);
  SELECT coalesce(max(version),0) INTO prior FROM gateway.setting_versions;
  IF gateway.admin_role_for(actor) IS DISTINCT FROM 'system_admin' THEN denied := 'forbidden';
  ELSIF recent IS NOT TRUE THEN denied := 'admin_recent_auth_required';
  ELSIF prior IS DISTINCT FROM expected THEN denied := 'version_conflict';
  ELSIF reason IS NULL OR length(trim(reason)) NOT BETWEEN 1 AND 200 THEN denied := 'invalid_settings';
  ELSIF restore_id IS NOT NULL THEN
    SELECT * INTO next_row FROM gateway.setting_versions WHERE version=restore_id AND version<prior;
    IF NOT FOUND OR fields IS NOT NULL THEN denied := 'invalid_settings'; END IF;
  ELSE
    IF jsonb_typeof(fields) IS DISTINCT FROM 'object'
      OR NOT (fields ?& ARRAY['announcement','supportUrl','timeZone','singleMicros','dailyMicros'])
      OR fields - ARRAY['announcement','supportUrl','timeZone','singleMicros','dailyMicros'] <> '{}'::jsonb
      OR EXISTS(SELECT 1 FROM jsonb_each(fields) WHERE jsonb_typeof(value)<>'string')
      OR length(fields->>'announcement')>1000 OR length(fields->>'supportUrl')>512
      OR (fields->>'supportUrl'<>'' AND fields->>'supportUrl' !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^[:space:]?#]*)?$')
      OR fields->>'singleMicros' !~ '^(0|[1-9][0-9]{0,18})$' OR fields->>'dailyMicros' !~ '^(0|[1-9][0-9]{0,18})$'
      OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=fields->>'timeZone') THEN denied := 'invalid_settings';
    ELSIF (fields->>'singleMicros')::numeric>9223372036854775807 OR (fields->>'dailyMicros')::numeric>9223372036854775807 THEN
      denied := 'invalid_settings';
    ELSE
      next_row.announcement := fields->>'announcement';
      next_row.support_url := fields->>'supportUrl';
      next_row.time_zone := fields->>'timeZone';
      next_row.single_micros := (fields->>'singleMicros')::bigint;
      next_row.daily_micros := (fields->>'dailyMicros')::bigint;
    END IF;
  END IF;
  IF denied IS NOT NULL THEN
    event_id := gateway.audit_redeem_admin(actor,action_name,'denied',denied,'{}');
    RETURN jsonb_build_object('result',denied,'requestId',event_id);
  END IF;
  IF prior=0 THEN
    INSERT INTO gateway.setting_versions VALUES (0,'','','UTC',legacy_single,legacy_daily);
  END IF;
  next_row.version := prior+1;
  INSERT INTO gateway.setting_versions SELECT next_row.*;
  event_id := gateway.audit_redeem_admin(actor,action_name,'success',reason,
    jsonb_build_object('before',prior,'after',next_row.version,'restoredFrom',restore_id));
  RETURN jsonb_build_object('result','ok','requestId',event_id,'version',next_row.version);
END $$;

-- Older application processes also enforce the current database quota during rollout.
ALTER FUNCTION gateway.admin_issue_redeem(uuid,uuid,bytea,bigint,timestamptz,bigint,bigint) RENAME TO issue_redeem_with_limits;
REVOKE ALL ON FUNCTION gateway.issue_redeem_with_limits(uuid,uuid,bytea,bigint,timestamptz,bigint,bigint) FROM PUBLIC,opentoken_app;
CREATE FUNCTION gateway.admin_issue_redeem(account_id uuid,operation_id uuid,code_digest bytea,amount bigint,
  expiry timestamptz,single_limit bigint,daily_limit bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v gateway.setting_versions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(961020038);
  SELECT * INTO v FROM gateway.setting_versions ORDER BY version DESC LIMIT 1;
  RETURN gateway.issue_redeem_with_limits(account_id,operation_id,code_digest,amount,expiry,
    coalesce(v.single_micros,single_limit),coalesce(v.daily_micros,daily_limit));
END $$;
REVOKE ALL ON FUNCTION gateway.site_display(),gateway.admin_settings(uuid,bigint,bigint,integer),
  gateway.write_settings(uuid,integer,integer,jsonb,text,boolean,bigint,bigint),
  gateway.admin_issue_redeem(uuid,uuid,bytea,bigint,timestamptz,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gateway.site_display(),gateway.admin_settings(uuid,bigint,bigint,integer),
  gateway.write_settings(uuid,integer,integer,jsonb,text,boolean,bigint,bigint),
  gateway.admin_issue_redeem(uuid,uuid,bytea,bigint,timestamptz,bigint,bigint) TO opentoken_app;

CREATE FUNCTION gateway.settings_audit_change(candidate jsonb,action text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN action IN ('settings.publish','settings.rollback') AND jsonb_typeof(candidate)='number'
    AND candidate::text ~ '^[0-9]{1,10}$' THEN candidate ELSE gateway.audit_safe_change(candidate,action) END;
$$;
REVOKE ALL ON FUNCTION gateway.settings_audit_change(jsonb,text) FROM PUBLIC,opentoken_app;

CREATE OR REPLACE FUNCTION gateway.admin_list_operation_events(actor uuid,filters jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  actor_role text := gateway.admin_role_for(actor);
  cursor_id uuid := (filters->>'cursor')::uuid;
  from_at timestamptz := (filters->>'from')::timestamptz;
  to_at timestamptz := (filters->>'to')::timestamptz;
  actor_filter uuid := (filters->>'actorId')::uuid;
  event_filter uuid := (filters->>'requestId')::uuid;
  object_filter text := filters->>'object';
  page_size int := (filters->>'limit')::int;
BEGIN
  IF actor_role IS NULL THEN RETURN NULL; END IF;
  IF page_size IS NULL OR page_size NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid log page size'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(item ORDER BY item."occurredAt" DESC,item."requestId" DESC) FROM (
      SELECT visible."requestId",visible."occurredAt",visible."actorId",visible."targetId",visible.source,
        visible.action,visible.outcome,visible.reason,visible.fields
          || CASE WHEN change.before_value IS NOT NULL THEN jsonb_build_object('before',change.before_value) ELSE '{}'::jsonb END
          || CASE WHEN change.after_value IS NOT NULL THEN jsonb_build_object('after',change.after_value) ELSE '{}'::jsonb END AS details
      FROM (
        SELECT e.request_id AS "requestId",e.occurred_at AS "occurredAt",e.actor_user_id AS "actorId",
          e.target_user_id AS "targetId",CASE WHEN e.actor_user_id IS NULL THEN 'database' ELSE 'account' END AS source,
          CASE WHEN e.action IN ('admin.page','admin.session','admin.role_change','channel.create','channel.edit',
            'channel.probe_started','channel.probe_finished','channel.enable','channel.disable','channel.rollback',
            'model.create','model.state','model.group_create','model.group_rename','model.group_state','model.rate_publish',
            'redeem.issue','redeem.void','redeem.credit','user.state','user.role','user.delete','user.invite_started','user.invite_finished',
            'user.invite_reconciled','settings.publish','settings.rollback') THEN e.action ELSE 'other' END AS action,
          e.outcome,CASE WHEN (CASE
            WHEN e.action IN ('admin.page','admin.session') THEN e.reason IN ('granted','role_required')
            WHEN e.action='admin.role_change' THEN e.reason IN ('revoked','bootstrap','assigned','account_ineligible','last_admin','first_admin_required')
            WHEN e.action IN ('redeem.issue','redeem.void','redeem.credit') THEN e.reason IN ('issued','voided','credited',
              'invalid_expiry','issue_conflict','forbidden','operator_daily_limit','operator_single_limit','code_not_found','code_redeemed','code_expired')
            WHEN e.action='user.invite_started' THEN e.reason='started'
            WHEN e.action='user.invite_finished' THEN e.reason IN ('issued','failed','unknown')
            WHEN e.action='user.invite_reconciled' THEN e.reason IN ('auth_account_found','auth_account_absent')
            WHEN e.action IN ('channel.create','channel.edit','channel.probe_started') THEN e.reason IN ('draft_saved','test_started')
            WHEN e.action='channel.probe_finished' THEN e.reason IN ('passed','timeout','auth_failed','model_unavailable','upstream_unavailable','unverified')
            WHEN e.outcome='denied' THEN e.reason IN ('admin_recent_auth_required','channel_probe_required','channel_route_conflict',
              'channel_credential_changed','model_rate_changed','model_route_required','model_cache_probe_required','user_forbidden',
              'user_self_change','user_not_found','user_state_changed','user_role_changed','user_deleted','user_billing_open','user_ineligible')
            ELSE false END)
            THEN e.reason WHEN e.outcome='success' THEN 'recorded' ELSE 'rejected' END AS reason,
          gateway.audit_safe_fields(e.details,CASE
            WHEN starts_with(e.action,'channel.') THEN ARRAY['channelId','versionId','previousDraft','previousVersion','probeId','elapsedMs','binding','bindings']
            WHEN starts_with(e.action,'redeem.') THEN ARRAY['codeId','receiptId','operationId','amountMicros']
            WHEN starts_with(e.action,'model.') THEN ARRAY['rateId','previousRateId','maxContextTokens','maxOutputTokens','enabled','adoptedModel']
            WHEN starts_with(e.action,'user.') THEN ARRAY['operationId','revision','revokedKeys']
            WHEN e.action='admin.role_change' THEN ARRAY['requestedRole']
            ELSE ARRAY[]::text[] END)
            || jsonb_strip_nulls(jsonb_build_object('modelId',m.id,'groupId',g.id)) AS fields,e.details,
          m.code AS model_code,g.code AS group_code
        FROM gateway.admin_audit_events e
        LEFT JOIN gateway.models m ON starts_with(e.action,'model.') AND m.code=e.details->>'model'
        LEFT JOIN gateway.pricing_groups g ON starts_with(e.action,'model.') AND g.code=e.details->>'group'
        WHERE (actor_role<>'operator' OR e.actor_user_id=actor)
          AND (actor_filter IS NULL OR e.actor_user_id=actor_filter)
          AND (event_filter IS NULL OR e.request_id=event_filter)
          AND (from_at IS NULL OR e.occurred_at>=from_at) AND (to_at IS NULL OR e.occurred_at<to_at)
          AND (filters->>'outcome' IS NULL OR e.outcome=filters->>'outcome')
          AND (cursor_id IS NULL OR (e.occurred_at,e.request_id)<(
            SELECT c.occurred_at,c.request_id FROM gateway.admin_audit_events c
            WHERE c.request_id=cursor_id AND (actor_role<>'operator' OR c.actor_user_id=actor)))
      ) visible
      CROSS JOIN LATERAL (SELECT gateway.settings_audit_change(visible.details->'before',visible.action) AS before_value,
        gateway.settings_audit_change(visible.details->'after',visible.action) AS after_value) change
      WHERE (filters->>'action' IS NULL OR visible.action=filters->>'action')
        AND (object_filter IS NULL OR visible."targetId"::text=object_filter OR object_filter IN
          (visible.fields->>'channelId',visible.fields->>'codeId',visible.fields->>'operationId',
            visible.fields->>'receiptId',visible.fields->>'rateId',visible.fields->>'modelId',visible.fields->>'groupId',
            visible.model_code,visible.group_code))
      ORDER BY visible."occurredAt" DESC,visible."requestId" DESC LIMIT page_size+1
    ) item
  ),'[]'::jsonb);
END $$;
