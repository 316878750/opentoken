CREATE TABLE gateway.account_states (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  suspended boolean NOT NULL,
  revision bigint NOT NULL CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE gateway.admin_user_invites (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  email_digest bytea NOT NULL CHECK (octet_length(email_digest)=32),
  status text NOT NULL CHECK (status IN ('pending','issued','failed','unknown')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK ((status='pending')=(finished_at IS NULL))
);
CREATE UNIQUE INDEX admin_user_invite_one_claim ON gateway.admin_user_invites(email_digest) WHERE status<>'failed';

CREATE OR REPLACE VIEW gateway.admin_eligible_accounts AS
  SELECT u.id FROM auth.users u LEFT JOIN gateway.account_states s ON s.user_id=u.id
  WHERE u.email_confirmed_at IS NOT NULL AND u.deleted_at IS NULL
    AND (u.banned_until IS NULL OR u.banned_until<=statement_timestamp()) AND NOT coalesce(s.suspended,false);

-- A missing state row identifies an account that has never been suspended.
CREATE FUNCTION gateway.account_access(account_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT coalesce(s.revision,0) FROM gateway.admin_eligible_accounts u
  LEFT JOIN gateway.account_states s ON s.user_id=u.id WHERE u.id=account_id;
$$;

CREATE FUNCTION gateway.admin_list_users(actor uuid,keyword text,status_filter text,after_id uuid,page_size integer)
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
        coalesce(s.suspended,false) AS suspended,
        CASE WHEN actor_role='system_admin' AND w.user_id IS NOT NULL THEN jsonb_build_object(
          'balanceMicros',w.balance_micros::text,'heldMicros',w.held_micros::text,
          'refundHeldMicros',w.refund_held_micros::text) END AS wallet
      FROM auth.users u
      LEFT JOIN gateway.account_states s ON s.user_id=u.id
      LEFT JOIN gateway.admin_roles a ON a.user_id=u.id
      LEFT JOIN gateway.wallets w ON actor_role='system_admin' AND w.user_id=u.id
      CROSS JOIN LATERAL (SELECT CASE
        WHEN s.suspended THEN 'suspended'
        WHEN u.deleted_at IS NOT NULL OR u.banned_until>statement_timestamp() THEN 'auth_blocked'
        WHEN u.email_confirmed_at IS NULL THEN 'pending'
        ELSE 'active' END AS status) account
      WHERE (after_id IS NULL OR u.id>after_id)
        AND (status_filter IS NULL OR status_filter=account.status)
        AND (keyword IS NULL OR u.id::text=lower(keyword)
          OR (actor_role='system_admin' AND starts_with(lower(u.email),lower(keyword))))
      ORDER BY u.id LIMIT page_size+1
    ) item
  ),'[]'::jsonb);
END $$;

CREATE FUNCTION gateway.admin_write_user(actor uuid,event_id uuid,target uuid,operation text,payload jsonb,recent boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  prior_role text;
  next_role text := payload->>'role';
  prior_suspension boolean;
  next_suspension boolean := (payload->>'suspended')::boolean;
  state_revision bigint;
  denied text;
  event_details jsonb := '{}'::jsonb;
BEGIN
  IF actor IS NULL OR target IS NULL OR operation IS NULL OR operation NOT IN ('state','role') THEN
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
    SELECT role INTO prior_role FROM gateway.admin_roles WHERE user_id=target;
    IF prior_role='system_admin' AND (next_suspension OR (operation='role' AND next_role IS DISTINCT FROM 'system_admin'))
      AND NOT EXISTS (SELECT 1 FROM gateway.admin_roles r JOIN gateway.admin_eligible_accounts u ON u.id=r.user_id
        WHERE r.role='system_admin' AND r.user_id<>target) THEN
      denied := 'last_admin'; EXIT change_account;
    END IF;

    IF operation='state' THEN
      -- Serialize pause/resume with gateway admission for this account only.
      PERFORM pg_advisory_xact_lock(961020037,hashtext(target::text));
      SELECT suspended,revision INTO prior_suspension,state_revision FROM gateway.account_states WHERE user_id=target;
      prior_suspension := coalesce(prior_suspension,false);
      state_revision := coalesce(state_revision,0);
      IF next_suspension IS NULL THEN denied := 'invalid_request'; EXIT change_account; END IF;
      IF state_revision::text IS DISTINCT FROM payload->>'expectedRevision' THEN
        denied := 'user_state_changed'; EXIT change_account;
      END IF;
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

CREATE FUNCTION gateway.admin_begin_user_invite(actor uuid,event_id uuid,operation_id uuid,recipient text,recipient_digest bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  entry gateway.admin_user_invites%ROWTYPE;
  denied text;
  actor_role text;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(961020034);
  actor_role := gateway.admin_role_for(actor);
  <<authorize_invite>>
  BEGIN
    IF actor_role IS NULL OR actor_role NOT IN ('system_admin','operator') THEN denied := 'user_forbidden'; EXIT authorize_invite; END IF;
    IF recipient IS NULL OR length(recipient)>254 OR position('@' IN recipient)<2 OR octet_length(recipient_digest) IS DISTINCT FROM 32 THEN
      denied := 'invalid_request'; EXIT authorize_invite;
    END IF;
    SELECT * INTO entry FROM gateway.admin_user_invites WHERE id=operation_id;
    IF entry.id IS NOT NULL AND (entry.actor_user_id<>actor OR entry.email_digest<>recipient_digest) THEN
      denied := 'invite_conflict'; EXIT authorize_invite;
    END IF;
    IF entry.id IS NULL THEN
      SELECT * INTO entry FROM gateway.admin_user_invites WHERE email_digest=recipient_digest AND status<>'failed';
    END IF;
    IF entry.id IS NULL THEN
      IF EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email)=recipient) THEN denied := 'invite_account_exists'; EXIT authorize_invite; END IF;
      INSERT INTO gateway.admin_user_invites(id,actor_user_id,email_digest,status) VALUES (operation_id,actor,recipient_digest,'pending')
        ON CONFLICT DO NOTHING;
      IF FOUND THEN EXIT authorize_invite; END IF;
      SELECT * INTO entry FROM gateway.admin_user_invites WHERE id=operation_id OR (email_digest=recipient_digest AND status<>'failed')
        ORDER BY (id=operation_id) DESC LIMIT 1;
    END IF;
    denied := CASE
      WHEN entry.id IS NULL OR entry.email_digest<>recipient_digest OR (entry.id=operation_id AND entry.actor_user_id<>actor) THEN 'invite_conflict'
      WHEN entry.status='issued' THEN 'invite_already_issued'
      WHEN entry.status='failed' THEN 'invite_failed'
      WHEN entry.status='pending' AND entry.started_at>clock_timestamp()-interval '30 seconds' THEN 'invite_pending'
      ELSE 'invite_unknown' END;
  END authorize_invite;

  INSERT INTO gateway.admin_audit_events(request_id,action,outcome,reason,actor_user_id,details)
    VALUES (event_id,'user.invite_started',CASE WHEN denied IS NULL THEN 'success' ELSE 'denied' END,
      coalesce(denied,'started'),actor,jsonb_build_object('operationId',operation_id));
  IF actor_role='operator' AND (denied='invite_account_exists' OR
    (entry.actor_user_id<>actor AND denied IN ('invite_already_issued','invite_pending','invite_unknown'))) THEN
    RETURN 'invite_recipient_unavailable';
  END IF;
  RETURN denied;
END $$;

CREATE FUNCTION gateway.admin_finish_user_invite(actor uuid,event_id uuid,operation_id uuid,result text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  actor_role text;
BEGIN
  IF result IS NULL OR result NOT IN ('issued','failed','unknown') THEN RAISE EXCEPTION 'Invalid invitation outcome'; END IF;
  PERFORM pg_advisory_xact_lock_shared(961020034);
  UPDATE gateway.admin_user_invites SET status=result,finished_at=clock_timestamp()
    WHERE id=operation_id AND actor_user_id=actor AND status='pending';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO gateway.admin_audit_events(request_id,action,outcome,reason,actor_user_id,details)
    VALUES (event_id,'user.invite_finished',CASE WHEN result='issued' THEN 'success' ELSE 'denied' END,
      result,actor,jsonb_build_object('operationId',operation_id));
  actor_role := gateway.admin_role_for(actor);
  RETURN coalesce(actor_role IN ('system_admin','operator'),false);
END $$;

CREATE FUNCTION gateway.reconcile_user_invite(operation_id uuid,recipient text,recipient_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  entry gateway.admin_user_invites%ROWTYPE;
  event_id uuid := gen_random_uuid();
  denied text;
  reconciled_status text;
BEGIN
  SELECT * INTO entry FROM gateway.admin_user_invites WHERE id=operation_id FOR UPDATE;
  IF entry.id IS NULL OR entry.email_digest IS DISTINCT FROM recipient_digest THEN
    denied := 'invite_recipient_mismatch';
  ELSIF entry.status NOT IN ('pending','unknown') THEN
    denied := 'invite_already_resolved';
  ELSIF entry.started_at>clock_timestamp()-interval '2 minutes' THEN
    denied := 'invite_still_waiting';
  ELSE
    reconciled_status := CASE WHEN EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email)=recipient)
      THEN 'issued' ELSE 'failed' END;
    UPDATE gateway.admin_user_invites SET status=reconciled_status,finished_at=clock_timestamp() WHERE id=operation_id;
  END IF;
  INSERT INTO gateway.admin_audit_events(request_id,action,outcome,reason,actor_db_role,details)
    VALUES (event_id,'user.invite_reconciled',CASE WHEN denied IS NULL THEN 'success' ELSE 'denied' END,
      coalesce(denied,CASE WHEN reconciled_status='issued' THEN 'auth_account_found' ELSE 'auth_account_absent' END),
      session_user,jsonb_build_object('operationId',operation_id,'before',entry.status,'after',reconciled_status));
  RETURN jsonb_build_object('denied',denied,'status',reconciled_status,'requestId',event_id);
END $$;

REVOKE ALL ON gateway.account_states,gateway.admin_user_invites FROM PUBLIC,opentoken_app;
REVOKE ALL ON FUNCTION gateway.account_access(uuid),gateway.admin_list_users(uuid,text,text,uuid,integer),
  gateway.admin_write_user(uuid,uuid,uuid,text,jsonb,boolean),gateway.admin_begin_user_invite(uuid,uuid,uuid,text,bytea),
  gateway.admin_finish_user_invite(uuid,uuid,uuid,text),gateway.reconcile_user_invite(uuid,text,bytea) FROM PUBLIC,opentoken_app;
GRANT EXECUTE ON FUNCTION gateway.account_access(uuid),gateway.admin_list_users(uuid,text,text,uuid,integer),
  gateway.admin_write_user(uuid,uuid,uuid,text,jsonb,boolean),gateway.admin_begin_user_invite(uuid,uuid,uuid,text,bytea),
  gateway.admin_finish_user_invite(uuid,uuid,uuid,text) TO opentoken_app;
