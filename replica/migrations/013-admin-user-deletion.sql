ALTER TABLE gateway.account_states ADD COLUMN deleted_at timestamptz;
ALTER TABLE gateway.account_states ADD CONSTRAINT account_states_deleted_suspended CHECK (deleted_at IS NULL OR suspended);

CREATE OR REPLACE FUNCTION gateway.admin_list_users(actor uuid,keyword text,status_filter text,after_id uuid,page_size integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  actor_role text := gateway.admin_role_for(actor);
BEGIN
  IF actor_role IS NULL OR actor_role NOT IN ('system_admin','operator') THEN RETURN NULL; END IF;
  IF page_size IS NULL OR page_size NOT BETWEEN 1 AND 50 OR length(keyword)>254 THEN
    RAISE EXCEPTION 'Invalid user list filter';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(item ORDER BY item.id) FROM (
      SELECT u.id,
        CASE WHEN actor_role='system_admin' THEN u.email
          WHEN position('@' IN u.email)>1 THEN left(u.email,1)||'***@'||split_part(u.email,'@',2) END AS email,
        u.email_confirmed_at IS NOT NULL AS "emailConfirmed",account.status,a.role,
        coalesce(s.revision,0)::text AS revision,
        coalesce(s.suspended,false) AS suspended,s.deleted_at AS "deletedAt",
        CASE WHEN actor_role='system_admin' AND w.user_id IS NOT NULL THEN jsonb_build_object(
          'balanceMicros',w.balance_micros::text,'heldMicros',w.held_micros::text,
          'refundHeldMicros',w.refund_held_micros::text) END AS wallet
      FROM auth.users u
      LEFT JOIN gateway.account_states s ON s.user_id=u.id
      LEFT JOIN gateway.admin_roles a ON a.user_id=u.id
      LEFT JOIN gateway.wallets w ON actor_role='system_admin' AND w.user_id=u.id
      CROSS JOIN LATERAL (SELECT CASE
        WHEN s.deleted_at IS NOT NULL THEN 'deleted'
        WHEN s.suspended THEN 'suspended'
        WHEN u.deleted_at IS NOT NULL OR u.banned_until>statement_timestamp() THEN 'auth_blocked'
        WHEN u.email_confirmed_at IS NULL THEN 'pending'
        ELSE 'active' END AS status) account
      WHERE (after_id IS NULL OR u.id>after_id)
        AND CASE WHEN account.status='deleted' THEN coalesce(status_filter='deleted' AND actor_role='system_admin',false)
          ELSE status_filter IS NULL OR status_filter=account.status END
        AND (keyword IS NULL OR u.id::text=lower(keyword)
          OR (actor_role='system_admin' AND starts_with(lower(u.email),lower(keyword))))
      ORDER BY u.id LIMIT page_size+1
    ) item
  ),'[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION gateway.admin_write_user(actor uuid,event_id uuid,target uuid,operation text,payload jsonb,recent boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  prior_role text;
  next_role text := payload->>'role';
  prior_suspension boolean;
  next_suspension boolean := (payload->>'suspended')::boolean;
  state_revision bigint;
  prior_deleted timestamptz;
  revoked_keys integer;
  denied text;
  event_details jsonb := '{}'::jsonb;
BEGIN
  IF actor IS NULL OR target IS NULL OR operation IS NULL OR operation NOT IN ('state','role','delete') THEN
    RAISE EXCEPTION 'Invalid user operation';
  END IF;
  -- Use the same lock as the bootstrap and recovery role commands.
  PERFORM pg_advisory_xact_lock(961020034);
  <<change_account>>
  BEGIN
    IF gateway.admin_role_for(actor) IS DISTINCT FROM 'system_admin' THEN denied := 'user_forbidden'; EXIT change_account; END IF;
    IF recent IS DISTINCT FROM true THEN denied := 'admin_recent_auth_required'; EXIT change_account; END IF;
    IF actor=target THEN denied := 'user_self_change'; EXIT change_account; END IF;
    IF payload->>'reason' IS NULL OR length(btrim(payload->>'reason')) NOT BETWEEN 3 AND 160 THEN
      denied := 'invalid_request'; EXIT change_account;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id=target) THEN denied := 'user_not_found'; EXIT change_account; END IF;
    -- Share the gateway admission and checkout boundary for this account.
    PERFORM pg_advisory_xact_lock(961020037,hashtext(target::text));
    SELECT suspended,revision,deleted_at INTO prior_suspension,state_revision,prior_deleted
      FROM gateway.account_states WHERE user_id=target;
    IF prior_deleted IS NOT NULL THEN denied := 'user_deleted'; EXIT change_account; END IF;
    prior_suspension := coalesce(prior_suspension,false);
    state_revision := coalesce(state_revision,0);
    SELECT role INTO prior_role FROM gateway.admin_roles WHERE user_id=target;
    IF prior_role='system_admin' AND (operation='delete' OR next_suspension OR (operation='role' AND next_role IS DISTINCT FROM 'system_admin'))
      AND NOT EXISTS (SELECT 1 FROM gateway.admin_roles r JOIN gateway.admin_eligible_accounts u ON u.id=r.user_id
        WHERE r.role='system_admin' AND r.user_id<>target) THEN
      denied := 'last_admin'; EXIT change_account;
    END IF;

    IF operation IN ('state','delete') AND state_revision::text IS DISTINCT FROM payload->>'expectedRevision' THEN
      denied := 'user_state_changed'; EXIT change_account;
    END IF;
    IF operation='delete' THEN
      IF target::text IS DISTINCT FROM payload->>'confirmation' OR NOT (payload ? 'expectedRole') THEN
        denied := 'user_delete_confirmation'; EXIT change_account;
      END IF;
      IF prior_role IS DISTINCT FROM payload->>'expectedRole' THEN denied := 'user_role_changed'; EXIT change_account; END IF;
      IF EXISTS (SELECT 1 FROM gateway.stripe_orders o WHERE o.user_id=target AND (
        o.state='open' OR
        (o.subscription_id IS NOT NULL AND coalesce(o.subscription_status,'pending') NOT IN ('canceled','incomplete_expired'))
      )) THEN
        denied := 'user_billing_open'; EXIT change_account;
      END IF;
      state_revision := state_revision+1;
      INSERT INTO gateway.account_states(user_id,suspended,revision,deleted_at)
        VALUES (target,true,state_revision,clock_timestamp())
        ON CONFLICT (user_id) DO UPDATE SET suspended=true,revision=excluded.revision,
          deleted_at=excluded.deleted_at,updated_at=excluded.updated_at;
      DELETE FROM gateway.admin_roles WHERE user_id=target;
      UPDATE gateway.api_keys SET status='revoked',updated_at=clock_timestamp() WHERE user_id=target AND status<>'revoked';
      GET DIAGNOSTICS revoked_keys = ROW_COUNT;
      event_details := jsonb_build_object('before',jsonb_build_object('suspended',prior_suspension,'role',prior_role),
        'after','deleted','revision',state_revision::text,'revokedKeys',revoked_keys);
    ELSIF operation='state' THEN
      IF next_suspension IS NULL THEN denied := 'invalid_request'; EXIT change_account; END IF;
      IF prior_suspension IS DISTINCT FROM next_suspension THEN
        state_revision := state_revision+1;
        INSERT INTO gateway.account_states(user_id,suspended,revision) VALUES (target,next_suspension,state_revision)
          ON CONFLICT (user_id) DO UPDATE SET suspended=excluded.suspended,revision=excluded.revision,updated_at=clock_timestamp();
      END IF;
      event_details := jsonb_build_object('before',prior_suspension,'after',next_suspension,'revision',state_revision::text);
    ELSE
      IF NOT (payload ? 'expectedRole' AND payload ? 'role') OR
        (next_role IS NOT NULL AND next_role NOT IN ('system_admin','operator','auditor')) THEN
        denied := 'invalid_request'; EXIT change_account;
      END IF;
      IF prior_role IS DISTINCT FROM payload->>'expectedRole' THEN denied := 'user_role_changed'; EXIT change_account; END IF;
      IF next_role IS NULL THEN
        DELETE FROM gateway.admin_roles WHERE user_id=target;
      ELSIF gateway.account_access(target) IS NULL THEN
        denied := 'user_ineligible'; EXIT change_account;
      ELSE
        INSERT INTO gateway.admin_roles(user_id,role) VALUES (target,next_role) ON CONFLICT (user_id) DO UPDATE SET role=excluded.role;
      END IF;
      event_details := jsonb_build_object('before',prior_role,'after',next_role);
    END IF;
  END change_account;

  INSERT INTO gateway.admin_audit_events(request_id,action,outcome,reason,actor_user_id,target_user_id,details)
    VALUES (event_id,'user.'||operation,CASE WHEN denied IS NULL THEN 'success' ELSE 'denied' END,
      coalesce(denied,payload->>'reason'),actor,target,event_details);
  RETURN jsonb_build_object('denied',denied)||event_details;
END $$;
