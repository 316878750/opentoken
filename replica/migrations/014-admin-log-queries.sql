CREATE INDEX login_events_user_time_idx ON gateway.login_events(user_id,occurred_at DESC,request_id DESC);
CREATE INDEX admin_audit_actor_time_idx ON gateway.admin_audit_events(actor_user_id,occurred_at DESC,request_id DESC);

CREATE FUNCTION gateway.admin_list_login_events(actor uuid,filters jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  actor_role text := gateway.admin_role_for(actor);
  cursor_id uuid := (filters->>'cursor')::uuid;
  from_at timestamptz := (filters->>'from')::timestamptz;
  to_at timestamptz := (filters->>'to')::timestamptz;
  user_filter uuid := (filters->>'userId')::uuid;
  event_filter uuid := (filters->>'requestId')::uuid;
  page_size int := (filters->>'limit')::int;
BEGIN
  IF actor_role IS NULL OR actor_role NOT IN ('system_admin','auditor') THEN RETURN NULL; END IF;
  IF page_size IS NULL OR page_size NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid log page size'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(item ORDER BY item."occurredAt" DESC,item."requestId" DESC) FROM (
      SELECT e.request_id AS "requestId",e.occurred_at AS "occurredAt",e.user_id AS "userId",
        left(encode(e.identifier_digest,'hex'),12) AS identifier,e.outcome,
        CASE e.outcome WHEN 'success' THEN 'authenticated' WHEN 'failure' THEN 'credentials_or_account'
          WHEN 'rate_limited' THEN 'auth_rate_limit' ELSE 'auth_unavailable' END AS reason
      FROM gateway.login_events e
      WHERE (from_at IS NULL OR e.occurred_at>=from_at) AND (to_at IS NULL OR e.occurred_at<to_at)
        AND (user_filter IS NULL OR e.user_id=user_filter)
        AND (event_filter IS NULL OR e.request_id=event_filter)
        AND (filters->>'outcome' IS NULL OR e.outcome=filters->>'outcome')
        AND (filters->>'identifier' IS NULL OR left(encode(e.identifier_digest,'hex'),12)=filters->>'identifier')
        AND (cursor_id IS NULL OR (e.occurred_at,e.request_id)<(
          SELECT c.occurred_at,c.request_id FROM gateway.login_events c WHERE c.request_id=cursor_id))
      ORDER BY e.occurred_at DESC,e.request_id DESC LIMIT page_size+1
    ) item
  ),'[]'::jsonb);
END $$;

-- Free text can contain credentials or PII. Expose only typed operational fields.
CREATE FUNCTION gateway.audit_safe_fields(fields jsonb,allowed_keys text[])
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
  FROM jsonb_each(CASE WHEN jsonb_typeof(fields)='object' THEN fields ELSE '{}'::jsonb END) AS f(key,value)
  WHERE key=ANY(allowed_keys) AND ((
    key IN ('codeId','operationId','receiptId','channelId','versionId','previousDraft','previousVersion','probeId','rateId','previousRateId')
    AND jsonb_typeof(value)='string' AND value#>>'{}' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  ) OR (
    key IN ('inputMicros','cacheMicros','outputMicros','amountMicros','multiplierBps','revision','revokedKeys','elapsedMs',
      'binding','bindings','maxContextTokens','maxOutputTokens')
    AND jsonb_typeof(value) IN ('string','number') AND value#>>'{}' ~ '^-?[0-9]{1,16}$'
  ) OR (
    key IN ('suspended','enabled','adoptedModel') AND jsonb_typeof(value)='boolean'
  ) OR (
    key IN ('role','requestedRole') AND (value='null'::jsonb OR value#>>'{}' IN ('system_admin','operator','auditor'))
  ));
$$;

CREATE FUNCTION gateway.audit_safe_change(candidate jsonb,action text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE
    WHEN action IN ('user.state','channel.disable','model.state','model.group_state')
      AND jsonb_typeof(candidate)='boolean' THEN candidate
    WHEN action IN ('user.role','admin.role_change') AND
      (candidate='null'::jsonb OR candidate#>>'{}' IN ('system_admin','operator','auditor')) THEN candidate
    WHEN action='user.delete' AND candidate#>>'{}'='deleted' THEN candidate
    WHEN action='redeem.void' AND candidate#>>'{}' IN ('active','voided') THEN candidate
    WHEN action='user.invite_reconciled' AND candidate#>>'{}' IN ('pending','issued','failed','unknown') THEN candidate
    WHEN action='user.delete' AND jsonb_typeof(candidate)='object'
      THEN nullif(gateway.audit_safe_fields(candidate,ARRAY['suspended','role']),'{}'::jsonb)
    WHEN action='model.rate_publish' AND jsonb_typeof(candidate) IN ('object','null')
      THEN CASE WHEN candidate='null'::jsonb THEN candidate ELSE
        nullif(gateway.audit_safe_fields(candidate,ARRAY['inputMicros','cacheMicros','outputMicros','multiplierBps']),'{}'::jsonb) END
    END;
$$;

CREATE FUNCTION gateway.admin_list_operation_events(actor uuid,filters jsonb)
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
            'user.invite_reconciled') THEN e.action ELSE 'other' END AS action,
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
      CROSS JOIN LATERAL (SELECT gateway.audit_safe_change(visible.details->'before',visible.action) AS before_value,
        gateway.audit_safe_change(visible.details->'after',visible.action) AS after_value) change
      WHERE (filters->>'action' IS NULL OR visible.action=filters->>'action')
        AND (object_filter IS NULL OR visible."targetId"::text=object_filter OR object_filter IN
          (visible.fields->>'channelId',visible.fields->>'codeId',visible.fields->>'operationId',
            visible.fields->>'receiptId',visible.fields->>'rateId',visible.fields->>'modelId',visible.fields->>'groupId',
            visible.model_code,visible.group_code))
      ORDER BY visible."occurredAt" DESC,visible."requestId" DESC LIMIT page_size+1
    ) item
  ),'[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION gateway.audit_safe_fields(jsonb,text[]),gateway.audit_safe_change(jsonb,text),
  gateway.admin_list_login_events(uuid,jsonb),gateway.admin_list_operation_events(uuid,jsonb) FROM PUBLIC,opentoken_app;
GRANT EXECUTE ON FUNCTION gateway.admin_list_login_events(uuid,jsonb),gateway.admin_list_operation_events(uuid,jsonb) TO opentoken_app;
