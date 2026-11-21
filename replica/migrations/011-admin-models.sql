ALTER TABLE gateway.models ADD COLUMN admin_managed boolean NOT NULL DEFAULT false;
ALTER TABLE gateway.pricing_groups ADD COLUMN admin_managed boolean NOT NULL DEFAULT false;
ALTER TABLE gateway.channel_probes ADD COLUMN cache_usage_verified boolean NOT NULL DEFAULT false;

-- With distinct prices, a successful compatible probe already required cache usage in every enabled mode.
UPDATE gateway.channel_probes p SET cache_usage_verified=true
FROM gateway.channel_versions v,gateway.model_rates r
WHERE p.version_id=v.id AND p.rate_id=r.id AND p.status='passed' AND v.adapter='compatible'
  AND r.input_micros_per_mtok<>r.cached_input_micros_per_mtok;

CREATE FUNCTION gateway.can_manage_model(target uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM gateway.models m WHERE m.id=target AND m.code<>'mock-text' AND (
      m.admin_managed OR (
        EXISTS (SELECT 1 FROM gateway.channel_routes cr WHERE cr.model_id=m.id) AND NOT EXISTS (
          SELECT 1 FROM gateway.model_rates r WHERE r.model_id=m.id AND r.closed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM gateway.channel_routes cr WHERE cr.model_id=r.model_id AND cr.group_id=r.group_id)
        )
      )
    )
  );
$$;

CREATE FUNCTION gateway.admin_write_model(actor uuid,event_id uuid,operation text,payload jsonb,recent boolean,credentials jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  model_row gateway.models%ROWTYPE;
  group_row gateway.pricing_groups%ROWTYPE;
  old_rate gateway.model_rates%ROWTYPE;
  route_row gateway.channel_runtime_routes%ROWTYPE;
  result_id uuid;
  effective_at timestamptz;
  model_code text := CASE operation WHEN 'rate-publish' THEN payload->>'model' ELSE payload->>'code' END;
  group_code text := CASE operation WHEN 'rate-publish' THEN payload->>'group' ELSE payload->>'code' END;
  enabled_state boolean := (payload->>'enabled')::boolean;
  model_context integer := (payload->>'maxContextTokens')::integer;
  model_output integer := (payload->>'maxOutputTokens')::integer;
  group_name text := payload->>'name';
  input_price bigint := (payload->>'inputMicros')::bigint;
  cache_price bigint := (payload->>'cacheMicros')::bigint;
  output_price bigint := (payload->>'outputMicros')::bigint;
  multiplier integer := (payload->>'multiplierBps')::integer;
  event_details jsonb := '{}'::jsonb;
  denied text;
BEGIN
  IF operation IS NULL OR operation NOT IN ('create','state','group-create','group-rename','group-state','rate-publish') THEN
    RAISE EXCEPTION 'Invalid model operation';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(961020034);
  <<change_model>>
  BEGIN
    IF gateway.admin_role_for(actor) IS DISTINCT FROM 'system_admin' THEN
      denied := 'model_forbidden'; EXIT change_model;
    END IF;
    IF (operation='rate-publish' OR (operation IN ('state','group-state') AND enabled_state)) AND recent IS DISTINCT FROM true THEN
      denied := 'admin_recent_auth_required'; EXIT change_model;
    END IF;
    IF operation='state' AND enabled_state THEN
      PERFORM pg_advisory_xact_lock_shared(961020032);
    END IF;
    PERFORM pg_advisory_xact_lock(961020036);

    IF operation LIKE 'group-%' THEN
      IF group_code IS NULL OR group_code !~ '^[a-z0-9][a-z0-9-]{0,39}$' THEN
        denied := 'invalid_request'; EXIT change_model;
      END IF;
      event_details := jsonb_build_object('group',group_code);
      SELECT * INTO group_row FROM gateway.pricing_groups WHERE code=group_code;
    ELSE
      IF model_code IS NULL OR model_code !~ '^[a-z0-9][a-z0-9-]{0,63}$' THEN
        denied := 'invalid_request'; EXIT change_model;
      END IF;
      event_details := jsonb_build_object('model',model_code);
      SELECT * INTO model_row FROM gateway.models WHERE code=model_code;
    END IF;
    IF operation IN ('state','group-state','rate-publish') AND
      (payload->>'reason' IS NULL OR length(btrim(payload->>'reason')) NOT BETWEEN 3 AND 160) THEN
      denied := 'invalid_request'; EXIT change_model;
    END IF;

    CASE operation
      WHEN 'create' THEN
        IF model_row.id IS NOT NULL OR model_code IN ('mock-text','openai-mini','compatible-chat') OR payload->>'reserved'='true' THEN
          denied := 'model_duplicate'; EXIT change_model;
        END IF;
        IF model_context IS NULL OR model_context NOT BETWEEN 128 AND 5000000 OR
          model_output IS NULL OR model_output NOT BETWEEN 1 AND 128 THEN
          denied := 'invalid_request'; EXIT change_model;
        END IF;
        INSERT INTO gateway.models(code,upstream_model,max_context_tokens,max_output_tokens,enabled,admin_managed)
          VALUES (model_code,model_code,model_context,model_output,false,true) RETURNING id INTO result_id;
        event_details := event_details || jsonb_build_object('maxContextTokens',model_context,'maxOutputTokens',model_output,'enabled',false);
      WHEN 'state' THEN
        IF model_row.id IS NULL THEN denied := 'model_not_found'; EXIT change_model; END IF;
        IF enabled_state IS NULL THEN denied := 'invalid_request'; EXIT change_model; END IF;
        IF NOT gateway.can_manage_model(model_row.id) THEN
          denied := 'legacy_model_managed'; EXIT change_model;
        END IF;
        IF enabled_state AND (EXISTS (SELECT 1 FROM gateway.stripe_sandbox WHERE enabled) OR NOT EXISTS (
          SELECT 1 FROM gateway.channel_runtime_routes cr
            JOIN gateway.pricing_groups g ON g.id=cr.group_id AND g.enabled
            JOIN gateway.model_rates r ON r.model_id=cr.model_id AND r.group_id=cr.group_id AND r.closed_at IS NULL
          WHERE cr.model_id=model_row.id AND cr.effective AND credentials->>cr.credential_ref=cr.credential_fingerprint
        )) THEN
          denied := 'model_route_required'; EXIT change_model;
        END IF;
        UPDATE gateway.models SET enabled=enabled_state,updated_at=clock_timestamp() WHERE id=model_row.id RETURNING id INTO result_id;
        event_details := event_details || jsonb_build_object('before',model_row.enabled,'after',enabled_state);
      WHEN 'group-create', 'group-rename' THEN
        IF group_name IS NULL OR length(btrim(group_name)) NOT BETWEEN 1 AND 80 THEN
          denied := 'invalid_request'; EXIT change_model;
        END IF;
        IF operation='group-create' THEN
          IF group_row.id IS NOT NULL THEN denied := 'model_group_duplicate'; EXIT change_model; END IF;
          INSERT INTO gateway.pricing_groups(code,name,enabled,admin_managed) VALUES (group_code,group_name,false,true)
            RETURNING id INTO result_id;
        ELSE
          IF group_row.id IS NULL THEN denied := 'model_group_not_found'; EXIT change_model; END IF;
          UPDATE gateway.pricing_groups SET name=group_name,admin_managed=true,updated_at=clock_timestamp()
            WHERE id=group_row.id RETURNING id INTO result_id;
        END IF;
        event_details := event_details || jsonb_build_object('before',group_row.name,'after',group_name);
      WHEN 'group-state' THEN
        IF group_row.id IS NULL THEN denied := 'model_group_not_found'; EXIT change_model; END IF;
        IF enabled_state IS NULL THEN denied := 'invalid_request'; EXIT change_model; END IF;
        UPDATE gateway.pricing_groups SET enabled=enabled_state,updated_at=clock_timestamp()
          WHERE id=group_row.id RETURNING id INTO result_id;
        event_details := event_details || jsonb_build_object('before',group_row.enabled,'after',enabled_state);
      WHEN 'rate-publish' THEN
        IF model_row.id IS NULL THEN denied := 'model_not_found'; EXIT change_model; END IF;
        SELECT * INTO group_row FROM gateway.pricing_groups WHERE code=group_code;
        IF group_row.id IS NULL THEN denied := 'model_group_not_found'; EXIT change_model; END IF;
        event_details := event_details || jsonb_build_object('group',group_code);
        SELECT * INTO route_row FROM gateway.channel_runtime_routes
          WHERE model_id=model_row.id AND group_id=group_row.id;
        IF model_code='mock-text' OR (route_row.version_id IS NULL AND NOT gateway.can_manage_model(model_row.id)) THEN
          denied := 'legacy_rate_managed'; EXIT change_model;
        END IF;
        IF input_price IS NULL OR input_price NOT BETWEEN 0 AND 999999999999999 OR
          cache_price IS NULL OR cache_price NOT BETWEEN 0 AND 999999999999999 OR
          output_price IS NULL OR output_price NOT BETWEEN 0 AND 999999999999999 OR
          (input_price=0 AND output_price=0) OR multiplier IS NULL OR multiplier NOT BETWEEN 1 AND 100000 OR
          NOT (payload ? 'expectedRateId') THEN
          denied := 'invalid_request'; EXIT change_model;
        END IF;
        SELECT * INTO old_rate FROM gateway.model_rates WHERE model_id=model_row.id AND group_id=group_row.id AND closed_at IS NULL;
        IF old_rate.id IS DISTINCT FROM (payload->>'expectedRateId')::uuid THEN
          denied := 'model_rate_changed'; EXIT change_model;
        END IF;
        IF input_price<>cache_price AND route_row.effective AND route_row.adapter='compatible' AND NOT coalesce((
          SELECT p.status='passed' AND p.cache_usage_verified
          FROM gateway.channel_versions v
          CROSS JOIN LATERAL jsonb_array_elements(v.config->'bindings') WITH ORDINALITY AS b(value,position)
          JOIN gateway.channel_probes p ON p.version_id=v.id AND p.binding=b.position-1
          WHERE v.id=route_row.version_id AND b.value->>'model'=model_code AND b.value->>'group'=group_code
          ORDER BY p.started_at DESC,p.id DESC LIMIT 1
        ),false) THEN
          denied := 'model_cache_probe_required'; EXIT change_model;
        END IF;
        -- Extending a fully migrated model claims its new pair before a future environment seed can.
        IF route_row.version_id IS NULL AND NOT model_row.admin_managed THEN
          UPDATE gateway.models SET admin_managed=true,updated_at=clock_timestamp() WHERE id=model_row.id;
          event_details := event_details || jsonb_build_object('adoptedModel',true);
        END IF;
        effective_at := clock_timestamp();
        UPDATE gateway.model_rates SET closed_at=effective_at,updated_at=effective_at WHERE id=old_rate.id;
        INSERT INTO gateway.model_rates(model_id,group_id,input_micros_per_mtok,cached_input_micros_per_mtok,
          output_micros_per_mtok,multiplier_bps,created_at,updated_at)
          VALUES (model_row.id,group_row.id,input_price,cache_price,output_price,multiplier,effective_at,effective_at)
          RETURNING id INTO result_id;
        event_details := event_details || jsonb_build_object('rateId',result_id,'previousRateId',old_rate.id,
          'before',CASE WHEN old_rate.id IS NOT NULL THEN jsonb_build_object('inputMicros',old_rate.input_micros_per_mtok::text,
            'cacheMicros',old_rate.cached_input_micros_per_mtok::text,'outputMicros',old_rate.output_micros_per_mtok::text,
            'multiplierBps',old_rate.multiplier_bps) END,
          'after',jsonb_build_object('inputMicros',input_price::text,'cacheMicros',cache_price::text,
            'outputMicros',output_price::text,'multiplierBps',multiplier));
    END CASE;
  END change_model;

  INSERT INTO gateway.admin_audit_events(request_id,action,outcome,reason,actor_user_id,details)
    VALUES (event_id,'model.'||replace(operation,'-','_'),CASE WHEN denied IS NULL THEN 'success' ELSE 'denied' END,
      coalesce(denied,payload->>'reason',operation),actor,event_details);
  RETURN jsonb_build_object('id',result_id,'denied',denied);
END $$;

REVOKE ALL ON FUNCTION gateway.admin_write_model(uuid,uuid,text,jsonb,boolean,jsonb) FROM PUBLIC,opentoken_app;
REVOKE ALL ON FUNCTION gateway.can_manage_model(uuid) FROM PUBLIC,opentoken_app;
GRANT EXECUTE ON FUNCTION gateway.admin_write_model(uuid,uuid,text,jsonb,boolean,jsonb),gateway.can_manage_model(uuid) TO opentoken_app;
