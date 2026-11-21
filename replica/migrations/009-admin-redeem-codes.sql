ALTER TABLE gateway.redeem_codes ADD COLUMN issued_by uuid, ADD COLUMN issue_operation_id uuid,
  ADD CHECK ((issued_by IS NULL) = (issue_operation_id IS NULL));

CREATE UNIQUE INDEX redeem_codes_issue_operation ON gateway.redeem_codes(issued_by,issue_operation_id)
  WHERE issued_by IS NOT NULL;
CREATE INDEX redeem_codes_issuer_time ON gateway.redeem_codes(issued_by,created_at DESC,id DESC)
  WHERE issued_by IS NOT NULL;
CREATE INDEX redeem_codes_admin_time ON gateway.redeem_codes(created_at DESC,id DESC) WHERE issued_by IS NOT NULL;

CREATE FUNCTION gateway.admin_redeem_status(expires_at timestamptz,voided_at timestamptz,redeemed boolean)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN redeemed THEN 'redeemed' WHEN voided_at IS NOT NULL THEN 'voided'
    WHEN expires_at<=statement_timestamp() THEN 'expired' ELSE 'active' END;
$$;

CREATE FUNCTION gateway.audit_redeem_admin(actor uuid,event_action text,event_outcome text,event_reason text,event_details jsonb)
RETURNS uuid LANGUAGE sql SET search_path = pg_catalog AS $$
  INSERT INTO gateway.admin_audit_events(request_id,action,outcome,reason,actor_user_id,details)
    VALUES (gen_random_uuid(),event_action,event_outcome,event_reason,actor,event_details) RETURNING request_id;
$$;

CREATE FUNCTION gateway.admin_issue_redeem(account_id uuid,operation_id uuid,code_digest bytea,amount bigint,
  expiry timestamptz,single_limit bigint,daily_limit bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor_role text;
  denied text;
  code gateway.redeem_codes%ROWTYPE;
  now_at timestamptz;
  utc_day timestamptz;
  audit_id uuid;
BEGIN
  -- The same actor's daily quota and operation id are checked under one transaction lock.
  PERFORM pg_advisory_xact_lock(961020035,hashtext(account_id::text));
  actor_role := gateway.admin_role_for(account_id);
  IF actor_role IS NULL OR actor_role NOT IN ('system_admin','operator') THEN
    denied := 'forbidden';
  ELSE
    SELECT * INTO code FROM gateway.redeem_codes WHERE issued_by=account_id AND issue_operation_id=operation_id;
    IF FOUND THEN
      IF code.amount_micros=amount AND code.expires_at=expiry THEN
        RETURN jsonb_build_object('result','replayed','id',code.id,'amountMicros',code.amount_micros::text,
          'expiresAt',code.expires_at,'status',gateway.admin_redeem_status(code.expires_at,code.voided_at,
            EXISTS (SELECT 1 FROM gateway.wallet_entries WHERE redeem_code_id=code.id)));
      END IF;
      denied := 'issue_conflict';
    ELSE
      now_at := clock_timestamp();
      utc_day := date_trunc('day',now_at,'UTC');
      IF expiry<=now_at THEN
        denied := 'invalid_expiry';
      ELSIF actor_role='operator' AND amount>coalesce(single_limit,0) THEN
        denied := 'operator_single_limit';
      ELSIF actor_role='operator' AND amount+(SELECT coalesce(sum(amount_micros),0) FROM gateway.redeem_codes
          WHERE issued_by=account_id AND created_at>=utc_day AND created_at<utc_day+interval '24 hours')>coalesce(daily_limit,0) THEN
        denied := 'operator_daily_limit';
      END IF;
    END IF;
  END IF;
  IF denied IS NOT NULL THEN
    audit_id := gateway.audit_redeem_admin(account_id,'redeem.issue','denied',denied,
      jsonb_build_object('operationId',operation_id,'amountMicros',amount::text));
    RETURN jsonb_build_object('result',denied,'requestId',audit_id);
  END IF;

  INSERT INTO gateway.redeem_codes(secret_digest,amount_micros,expires_at,issued_by,issue_operation_id,created_at,updated_at)
    VALUES (code_digest,amount,expiry,account_id,operation_id,now_at,now_at) RETURNING * INTO code;
  audit_id := gateway.audit_redeem_admin(account_id,'redeem.issue','success','issued',
    jsonb_build_object('codeId',code.id,'operationId',operation_id,'amountMicros',amount::text,'expiresAt',expiry));
  RETURN jsonb_build_object('result','issued','id',code.id,'amountMicros',code.amount_micros::text,
    'expiresAt',code.expires_at,'status','active','requestId',audit_id);
END $$;

CREATE FUNCTION gateway.admin_void_redeem(account_id uuid,code_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor_role text := gateway.admin_role_for(account_id);
  denied text;
  code gateway.redeem_codes%ROWTYPE;
  now_at timestamptz;
  audit_id uuid;
BEGIN
  IF actor_role IS NULL OR actor_role NOT IN ('system_admin','operator') THEN
    denied := 'forbidden';
  ELSE
    -- Redemption locks this same row before checking for a receipt or adding credit.
    SELECT * INTO code FROM gateway.redeem_codes WHERE id=code_id AND issued_by IS NOT NULL FOR UPDATE;
    IF code.id IS NULL THEN
      denied := 'code_not_found';
    ELSIF actor_role='operator' AND code.issued_by<>account_id THEN
      denied := 'forbidden';
    ELSIF EXISTS (SELECT 1 FROM gateway.wallet_entries WHERE redeem_code_id=code_id) THEN
      denied := 'code_redeemed';
    ELSIF code.voided_at IS NOT NULL THEN
      RETURN jsonb_build_object('result','voided','id',code.id,'voidedAt',code.voided_at);
    ELSIF code.expires_at<=clock_timestamp() THEN
      denied := 'code_expired';
    END IF;
  END IF;
  IF denied IS NOT NULL THEN
    audit_id := gateway.audit_redeem_admin(account_id,'redeem.void','denied',denied,jsonb_build_object('codeId',code_id));
    RETURN jsonb_build_object('result',denied,'requestId',audit_id);
  END IF;

  now_at := clock_timestamp();
  UPDATE gateway.redeem_codes SET voided_at=now_at,updated_at=now_at WHERE id=code_id;
  audit_id := gateway.audit_redeem_admin(account_id,'redeem.void','success','voided',
    jsonb_build_object('codeId',code_id,'amountMicros',code.amount_micros::text,'before','active','after','voided'));
  RETURN jsonb_build_object('result','voided','id',code_id,'voidedAt',now_at,'requestId',audit_id);
END $$;

CREATE FUNCTION gateway.admin_list_redeem(account_id uuid,filter_status text,cursor_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor_role text := gateway.admin_role_for(account_id);
BEGIN
  IF actor_role IS NULL THEN RETURN NULL; END IF;
  RETURN (
    WITH page AS (
      SELECT c.id,c.created_at AS "createdAt",c.expires_at AS "expiresAt",c.voided_at AS "voidedAt",
        c.amount_micros::text AS "amountMicros",e.id AS "receiptId", e.created_at AS "redeemedAt",
        CASE WHEN actor_role<>'auditor' THEN c.issued_by END AS "issuedBy",
        CASE WHEN actor_role<>'auditor' THEN e.user_id END AS "redeemedBy",
        gateway.admin_redeem_status(c.expires_at,c.voided_at,e.id IS NOT NULL) AS status
      FROM gateway.redeem_codes c LEFT JOIN gateway.wallet_entries e ON e.redeem_code_id=c.id
      WHERE c.issued_by IS NOT NULL AND (actor_role<>'operator' OR c.issued_by=account_id)
        AND (filter_status IS NULL OR gateway.admin_redeem_status(c.expires_at,c.voided_at,e.id IS NOT NULL)=filter_status)
        AND (cursor_id IS NULL OR (c.created_at,c.id)<(SELECT k.created_at,k.id FROM gateway.redeem_codes k
          WHERE k.id=cursor_id AND k.issued_by IS NOT NULL AND (actor_role<>'operator' OR k.issued_by=account_id)))
      ORDER BY c.created_at DESC,c.id DESC LIMIT 21
    ), items AS (SELECT * FROM page ORDER BY "createdAt" DESC,id DESC LIMIT 20)
    SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(i ORDER BY "createdAt" DESC,id DESC) FROM items i),'[]'::jsonb),
      'nextCursor',CASE WHEN (SELECT count(*) FROM page)>20 THEN
        (SELECT id FROM items ORDER BY "createdAt",id LIMIT 1) END)
  );
END $$;

-- Keep the existing wallet transaction and attach one audit event to a newly credited managed code.
ALTER FUNCTION gateway.redeem_trial_credit(uuid,bytea) RENAME TO redeem_trial_credit_base;
REVOKE ALL ON FUNCTION gateway.redeem_trial_credit_base(uuid,bytea) FROM PUBLIC,opentoken_app;
CREATE FUNCTION gateway.redeem_trial_credit(account_id uuid,code_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  credit jsonb := gateway.redeem_trial_credit_base(account_id,code_digest);
  code_id uuid;
BEGIN
  IF credit->>'status'='ok' AND credit->>'replayed'='false' THEN
    SELECT id INTO code_id FROM gateway.redeem_codes WHERE secret_digest=code_digest AND issued_by IS NOT NULL;
    IF FOUND THEN
      PERFORM gateway.audit_redeem_admin(account_id,'redeem.credit','success','credited',
        jsonb_build_object('codeId',code_id,'receiptId',credit->'receipt'->>'id','amountMicros',credit->'receipt'->>'amountMicros'));
    END IF;
  END IF;
  RETURN credit;
END $$;

REVOKE ALL ON FUNCTION gateway.admin_redeem_status(timestamptz,timestamptz,boolean),
  gateway.audit_redeem_admin(uuid,text,text,text,jsonb),gateway.redeem_trial_credit(uuid,bytea),
  gateway.admin_issue_redeem(uuid,uuid,bytea,bigint,timestamptz,bigint,bigint),
  gateway.admin_void_redeem(uuid,uuid),gateway.admin_list_redeem(uuid,text,uuid) FROM PUBLIC,opentoken_app;
GRANT EXECUTE ON FUNCTION gateway.admin_issue_redeem(uuid,uuid,bytea,bigint,timestamptz,bigint,bigint),
  gateway.admin_void_redeem(uuid,uuid),gateway.admin_list_redeem(uuid,text,uuid),
  gateway.redeem_trial_credit(uuid,bytea) TO opentoken_app;
