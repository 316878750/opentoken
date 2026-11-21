CREATE TABLE gateway.admin_roles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('system_admin','operator','auditor'))
);

CREATE TABLE gateway.login_events (
  request_id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id uuid,
  identifier_digest bytea NOT NULL CHECK (octet_length(identifier_digest)=32),
  outcome text NOT NULL CHECK (outcome IN ('success','failure','rate_limited','unavailable')),
  CHECK ((outcome='success') = (user_id IS NOT NULL))
);

CREATE TABLE gateway.admin_audit_events (
  request_id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success','denied')),
  reason text NOT NULL,
  actor_user_id uuid,
  actor_db_role text,
  target_user_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((actor_user_id IS NULL) <> (actor_db_role IS NULL))
);

CREATE INDEX login_events_time_idx ON gateway.login_events(occurred_at DESC,request_id);
CREATE INDEX admin_audit_events_time_idx ON gateway.admin_audit_events(occurred_at DESC,request_id);

CREATE VIEW gateway.admin_eligible_accounts AS
  SELECT id FROM auth.users WHERE email_confirmed_at IS NOT NULL AND deleted_at IS NULL
    AND (banned_until IS NULL OR banned_until<=statement_timestamp());

CREATE FUNCTION gateway.admin_role_for(account_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT r.role FROM gateway.admin_roles r JOIN gateway.admin_eligible_accounts u ON u.id=r.user_id
    WHERE r.user_id=account_id;
$$;

CREATE FUNCTION gateway.authorize_admin(account_id uuid, event_id uuid, entry_point text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  assigned_role text;
BEGIN
  IF entry_point IS NULL OR entry_point NOT IN ('admin.page','admin.session') THEN
    RAISE EXCEPTION 'Unknown administrator entry point';
  END IF;
  assigned_role := gateway.admin_role_for(account_id);
  INSERT INTO gateway.admin_audit_events(request_id,action,outcome,reason,actor_user_id)
    VALUES (event_id,entry_point,
      CASE WHEN assigned_role IS NULL THEN 'denied' ELSE 'success' END,
      CASE WHEN assigned_role IS NULL THEN 'role_required' ELSE 'granted' END,account_id);
  RETURN assigned_role;
END $$;

CREATE FUNCTION gateway.set_admin_role(account_id uuid, new_role text, change_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  old_role text;
  other_admin_exists boolean;
  denied_reason text;
  event_id uuid := gen_random_uuid();
BEGIN
  IF account_id IS NULL OR (new_role IS NOT NULL AND new_role NOT IN ('system_admin','operator','auditor')) OR
    change_reason IS NULL OR change_reason NOT IN ('initial_setup','staff_change','role_review','incident_response') THEN
    RAISE EXCEPTION 'Invalid administrator role change';
  END IF;
  -- Serialize privileged role changes so concurrent revocations cannot remove every admin.
  PERFORM pg_advisory_xact_lock(961020034);
  SELECT r.role INTO old_role FROM gateway.admin_roles r WHERE r.user_id=account_id;
  SELECT EXISTS (
    SELECT 1 FROM gateway.admin_roles r JOIN gateway.admin_eligible_accounts u ON u.id=r.user_id
    WHERE r.role='system_admin' AND r.user_id<>account_id
  ) INTO other_admin_exists;
  IF new_role IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gateway.admin_eligible_accounts u WHERE u.id=account_id) THEN
    denied_reason := 'account_ineligible';
  ELSIF old_role IS NOT DISTINCT FROM new_role THEN
    RETURN jsonb_build_object('role',old_role);
  ELSIF NOT other_admin_exists AND old_role='system_admin' THEN
    denied_reason := 'last_admin';
  ELSIF NOT other_admin_exists AND new_role IS NOT NULL AND new_role<>'system_admin' THEN
    denied_reason := 'first_admin_required';
  END IF;
  IF denied_reason IS NOT NULL THEN
    INSERT INTO gateway.admin_audit_events(request_id,action,outcome,reason,actor_db_role,target_user_id,details)
      VALUES (event_id,'admin.role_change','denied',denied_reason,session_user,account_id,
        jsonb_build_object('before',old_role,'requestedRole',new_role,'requestedReason',change_reason));
    RETURN jsonb_build_object('role',old_role,'denied',denied_reason,'requestId',event_id);
  END IF;

  IF new_role IS NULL THEN
    DELETE FROM gateway.admin_roles WHERE user_id=account_id;
  ELSE
    INSERT INTO gateway.admin_roles(user_id,role) VALUES (account_id,new_role)
      ON CONFLICT (user_id) DO UPDATE SET role=excluded.role;
  END IF;
  INSERT INTO gateway.admin_audit_events(request_id,action,outcome,reason,actor_db_role,target_user_id,details)
    VALUES (event_id,'admin.role_change','success',
      CASE WHEN new_role IS NULL THEN 'revoked'
        WHEN old_role IS NULL AND NOT other_admin_exists THEN 'bootstrap' ELSE 'assigned' END,
      session_user,account_id,jsonb_build_object('before',old_role,'after',new_role,'requestedReason',change_reason));
  RETURN jsonb_build_object('role',new_role,'requestId',event_id);
END $$;

REVOKE ALL ON gateway.admin_roles,gateway.login_events,gateway.admin_audit_events,gateway.admin_eligible_accounts FROM PUBLIC,opentoken_app;
REVOKE ALL ON FUNCTION gateway.admin_role_for(uuid),gateway.authorize_admin(uuid,uuid,text),
  gateway.set_admin_role(uuid,text,text) FROM PUBLIC,opentoken_app;
GRANT INSERT (request_id,user_id,identifier_digest,outcome) ON gateway.login_events TO opentoken_app;
GRANT EXECUTE ON FUNCTION gateway.admin_role_for(uuid),gateway.authorize_admin(uuid,uuid,text) TO opentoken_app;
