ALTER TABLE gateway.wallets
  ADD COLUMN refund_held_micros bigint NOT NULL DEFAULT 0
  CHECK (refund_held_micros BETWEEN 0 AND balance_micros-held_micros);
ALTER TABLE gateway.stripe_orders ADD COLUMN paid_at timestamptz;
UPDATE gateway.stripe_orders o SET paid_at=e.created_at
FROM gateway.wallet_entries e WHERE e.redeem_code_id=o.redeemed_code_id;

CREATE TABLE gateway.stripe_refunds (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES gateway.stripe_orders(id),
  user_id uuid NOT NULL REFERENCES gateway.wallets(user_id),
  amount_cents integer NOT NULL CHECK (amount_cents>0),
  approver text NOT NULL CHECK (length(btrim(approver)) BETWEEN 1 AND 100),
  stripe_id text UNIQUE CHECK (stripe_id ~ '^re_[A-Za-z0-9_]+$'),
  state text NOT NULL DEFAULT 'approved' CHECK (state IN ('approved','pending','succeeded','failed','canceled')),
  last_submitted_at timestamptz,
  cancellation_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,user_id)
);
CREATE INDEX stripe_refunds_order_idx ON gateway.stripe_refunds(order_id,created_at,id);

ALTER TABLE gateway.wallet_entries
  DROP CONSTRAINT wallet_entries_kind_check, DROP CONSTRAINT wallet_entries_check,
  ADD COLUMN refund_id uuid,
  ADD FOREIGN KEY (refund_id,user_id) REFERENCES gateway.stripe_refunds(id,user_id),
  ADD UNIQUE (refund_id,kind),
  ADD CHECK (
    (kind='usage' AND request_id IS NOT NULL AND redeem_code_id IS NULL AND refund_id IS NULL AND delta_micros<=0)
    OR (kind='redemption' AND request_id IS NULL AND redeem_code_id IS NOT NULL AND refund_id IS NULL AND delta_micros>0)
    OR (request_id IS NULL AND redeem_code_id IS NULL AND refund_id IS NOT NULL AND (
      (kind='stripe_refund' AND delta_micros<0) OR (kind='stripe_refund_reversal' AND delta_micros>0)
    ))
  );

CREATE TABLE gateway.wallet_credit_lots (
  entry_id uuid PRIMARY KEY REFERENCES gateway.wallet_entries(id),
  user_id uuid NOT NULL REFERENCES gateway.wallets(user_id),
  stripe_order_id uuid UNIQUE REFERENCES gateway.stripe_orders(id),
  credited_at timestamptz NOT NULL,
  remaining_micros bigint NOT NULL CHECK (remaining_micros>=0),
  refund_held_micros bigint NOT NULL DEFAULT 0 CHECK (refund_held_micros BETWEEN 0 AND remaining_micros)
);
CREATE INDEX wallet_credit_lots_spend_idx ON gateway.wallet_credit_lots
  (user_id,(stripe_order_id IS NOT NULL),credited_at,entry_id) WHERE remaining_micros>0;

CREATE FUNCTION gateway.allocate_wallet_usage(account_id uuid, amount bigint)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE lot record; take bigint;
BEGIN
  IF amount=0 THEN RETURN; END IF;
  FOR lot IN SELECT entry_id,remaining_micros-refund_held_micros AS available
    FROM gateway.wallet_credit_lots WHERE user_id=account_id AND remaining_micros>refund_held_micros
    ORDER BY stripe_order_id IS NOT NULL,credited_at,entry_id FOR UPDATE
  LOOP
    take := least(amount,lot.available);
    UPDATE gateway.wallet_credit_lots SET remaining_micros=remaining_micros-take WHERE entry_id=lot.entry_id;
    amount := amount-take;
    EXIT WHEN amount=0;
  END LOOP;
  IF amount<>0 THEN RAISE EXCEPTION 'Wallet credit history does not cover the debit'; END IF;
END $$;

-- Backfill from the immutable ledger, in the same order used when reporting it.
DO $$
DECLARE entry record;
BEGIN
  FOR entry IN SELECT e.*,o.id AS order_id FROM gateway.wallet_entries e
    LEFT JOIN gateway.stripe_orders o ON o.redeemed_code_id=e.redeem_code_id
    ORDER BY e.created_at,e.id
  LOOP
    IF entry.kind='redemption' THEN
      INSERT INTO gateway.wallet_credit_lots(entry_id,user_id,stripe_order_id,credited_at,remaining_micros)
      VALUES (entry.id,entry.user_id,entry.order_id,entry.created_at,entry.delta_micros);
    ELSE
      PERFORM gateway.allocate_wallet_usage(entry.user_id,-entry.delta_micros);
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION gateway.track_wallet_credit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.kind='redemption' THEN
    INSERT INTO gateway.wallet_credit_lots(entry_id,user_id,credited_at,remaining_micros)
    VALUES (NEW.id,NEW.user_id,NEW.created_at,NEW.delta_micros);
  ELSIF NEW.kind='usage' THEN
    PERFORM gateway.allocate_wallet_usage(NEW.user_id,-NEW.delta_micros);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER track_wallet_credit AFTER INSERT ON gateway.wallet_entries
  FOR EACH ROW EXECUTE FUNCTION gateway.track_wallet_credit();

CREATE FUNCTION gateway.link_stripe_credit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE gateway.wallet_credit_lots l SET stripe_order_id=NEW.id FROM gateway.wallet_entries e
  WHERE l.entry_id=e.id AND l.user_id=NEW.user_id AND e.redeem_code_id=NEW.redeemed_code_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stripe credit has no matching wallet lot'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER link_stripe_credit AFTER UPDATE OF redeemed_code_id ON gateway.stripe_orders
  FOR EACH ROW WHEN (NEW.redeemed_code_id IS NOT NULL AND OLD.redeemed_code_id IS DISTINCT FROM NEW.redeemed_code_id)
  EXECUTE FUNCTION gateway.link_stripe_credit();

CREATE FUNCTION gateway.approve_stripe_refund(refund_id uuid, target_id uuid, cents integer, actor text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  target gateway.stripe_orders%ROWTYPE; request gateway.stripe_refunds%ROWTYPE;
  lot gateway.wallet_credit_lots%ROWTYPE; wallet gateway.wallets%ROWTYPE;
  earlier bigint; amount bigint := cents::bigint*10000;
BEGIN
  IF cents IS NULL OR cents<=0 OR actor IS NULL OR length(btrim(actor)) NOT BETWEEN 1 AND 100 OR
    NOT EXISTS(SELECT 1 FROM gateway.stripe_sandbox WHERE enabled) THEN
    RAISE EXCEPTION 'A valid sandbox refund approval is required';
  END IF;
  SELECT * INTO STRICT target FROM gateway.stripe_orders WHERE id=target_id;
  SELECT * INTO STRICT wallet FROM gateway.wallets WHERE user_id=target.user_id FOR UPDATE;
  SELECT * INTO request FROM gateway.stripe_refunds WHERE id=refund_id;
  IF FOUND THEN
    IF request.order_id<>target_id OR request.amount_cents<>cents OR request.approver<>actor THEN
      RAISE EXCEPTION 'Refund retry does not match the approved request';
    END IF;
    RETURN request.state;
  END IF;
  IF target.kind<>'credit' OR target.state<>'paid' OR target.payment_id IS NULL THEN
    RAISE EXCEPTION 'Order is outside the refundable recharge window';
  END IF;
  SELECT * INTO STRICT lot FROM gateway.wallet_credit_lots WHERE stripe_order_id=target_id;
  IF coalesce(target.paid_at,lot.credited_at)+interval '30 days'<now() THEN
    RAISE EXCEPTION 'Order is outside the refundable recharge window';
  END IF;
  SELECT coalesce(sum(remaining_micros-refund_held_micros),0) INTO earlier
  FROM gateway.wallet_credit_lots WHERE user_id=target.user_id AND
    (stripe_order_id IS NULL OR (credited_at,entry_id)<(lot.credited_at,lot.entry_id));
  IF amount>lot.remaining_micros-lot.refund_held_micros-greatest(wallet.held_micros-earlier,0)
    OR amount>wallet.balance_micros-wallet.held_micros-wallet.refund_held_micros THEN
    RAISE EXCEPTION 'Requested amount exceeds the refundable credit';
  END IF;
  INSERT INTO gateway.stripe_refunds(id,order_id,user_id,amount_cents,approver)
    VALUES (refund_id,target_id,target.user_id,cents,actor);
  UPDATE gateway.wallet_credit_lots SET refund_held_micros=refund_held_micros+amount WHERE entry_id=lot.entry_id;
  UPDATE gateway.wallets SET refund_held_micros=refund_held_micros+amount,updated_at=now() WHERE user_id=target.user_id;
  RETURN 'approved';
END $$;

CREATE FUNCTION gateway.apply_stripe_refund(local_id uuid, remote_id text, payment text, cents integer, next_state text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  request gateway.stripe_refunds%ROWTYPE;
  payment_id text; amount bigint := cents::bigint*10000;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM gateway.stripe_sandbox WHERE enabled) THEN
    RAISE EXCEPTION 'Stripe sandbox is disabled for this database';
  END IF;
  SELECT * INTO STRICT request FROM gateway.stripe_refunds WHERE id=local_id;
  PERFORM 1 FROM gateway.wallets WHERE user_id=request.user_id FOR UPDATE;
  SELECT * INTO STRICT request FROM gateway.stripe_refunds WHERE id=local_id FOR UPDATE;
  SELECT o.payment_id INTO STRICT payment_id FROM gateway.stripe_orders o WHERE o.id=request.order_id;
  IF remote_id IS NULL OR remote_id !~ '^re_[A-Za-z0-9_]+$' OR
    (request.stripe_id IS NOT NULL AND request.stripe_id<>remote_id) OR payment_id IS DISTINCT FROM payment OR
    cents IS DISTINCT FROM request.amount_cents OR next_state IS NULL OR
    next_state NOT IN ('pending','succeeded','failed','canceled') THEN
    RAISE EXCEPTION 'Stripe refund does not match its approval';
  END IF;
  IF request.state IN ('failed','canceled') OR request.state=next_state OR
    (request.state='succeeded' AND next_state='pending') THEN RETURN; END IF;
  IF next_state='succeeded' THEN
    UPDATE gateway.wallet_credit_lots
    SET remaining_micros=remaining_micros-amount,refund_held_micros=refund_held_micros-amount
    WHERE stripe_order_id=request.order_id;
    INSERT INTO gateway.wallet_entries(user_id,refund_id,kind,delta_micros)
      VALUES(request.user_id,local_id,'stripe_refund',-amount);
    UPDATE gateway.wallets SET balance_micros=balance_micros-amount,
      refund_held_micros=refund_held_micros-amount,updated_at=now() WHERE user_id=request.user_id;
  ELSIF next_state IN ('failed','canceled') THEN
    IF request.state='succeeded' THEN
      UPDATE gateway.wallet_credit_lots SET remaining_micros=remaining_micros+amount WHERE stripe_order_id=request.order_id;
      INSERT INTO gateway.wallet_entries(user_id,refund_id,kind,delta_micros)
        VALUES(request.user_id,local_id,'stripe_refund_reversal',amount);
      UPDATE gateway.wallets SET balance_micros=balance_micros+amount,updated_at=now() WHERE user_id=request.user_id;
    ELSE
      UPDATE gateway.wallet_credit_lots SET refund_held_micros=refund_held_micros-amount WHERE stripe_order_id=request.order_id;
      UPDATE gateway.wallets SET refund_held_micros=refund_held_micros-amount,updated_at=now() WHERE user_id=request.user_id;
    END IF;
  END IF;
  UPDATE gateway.stripe_refunds SET stripe_id=remote_id,state=next_state,updated_at=now() WHERE id=local_id;
END $$;

CREATE FUNCTION gateway.release_unsent_stripe_refund(local_id uuid, review_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE request gateway.stripe_refunds%ROWTYPE; amount bigint;
BEGIN
  IF review_note IS NULL OR length(btrim(review_note)) NOT BETWEEN 1 AND 160 OR
    NOT EXISTS(SELECT 1 FROM gateway.stripe_sandbox WHERE enabled) THEN
    RAISE EXCEPTION 'Record the sandbox refund review reason';
  END IF;
  SELECT * INTO STRICT request FROM gateway.stripe_refunds WHERE id=local_id;
  PERFORM 1 FROM gateway.wallets WHERE user_id=request.user_id FOR UPDATE;
  SELECT * INTO STRICT request FROM gateway.stripe_refunds WHERE id=local_id FOR UPDATE;
  IF request.state='canceled' AND request.stripe_id IS NULL THEN RETURN; END IF;
  IF request.state<>'approved' OR request.stripe_id IS NOT NULL OR
    request.last_submitted_at>now()-interval '15 minutes' THEN
    RAISE EXCEPTION 'Only a confirmed unsubmitted approval can be released';
  END IF;
  amount:=request.amount_cents::bigint*10000;
  UPDATE gateway.wallet_credit_lots SET refund_held_micros=refund_held_micros-amount WHERE stripe_order_id=request.order_id;
  UPDATE gateway.wallets SET refund_held_micros=refund_held_micros-amount,updated_at=now() WHERE user_id=request.user_id;
  UPDATE gateway.stripe_refunds SET state='canceled',cancellation_note=review_note,updated_at=now() WHERE id=local_id;
END $$;

CREATE TABLE gateway.stripe_invoices (
  stripe_id text PRIMARY KEY CHECK (stripe_id ~ '^in_[A-Za-z0-9_]+$'),
  order_id uuid NOT NULL REFERENCES gateway.stripe_orders(id),
  amount_cents integer NOT NULL CHECK (amount_cents>0),
  reason text NOT NULL CHECK (reason IN ('subscription_create','subscription_cycle')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end>period_start),
  UNIQUE (order_id,period_end)
);
CREATE FUNCTION gateway.sandbox_billing_limits(account_id uuid)
RETURNS TABLE (rpm integer, active_keys integer) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN pro THEN 60 ELSE 10 END,CASE WHEN pro THEN 20 ELSE 5 END FROM (
    SELECT EXISTS (
      SELECT 1 FROM gateway.stripe_orders o JOIN gateway.stripe_invoices i ON i.order_id=o.id
      WHERE o.user_id=account_id AND o.kind='subscription' AND o.subscription_status NOT IN ('incomplete','incomplete_expired')
        AND i.period_start<=now() AND i.period_end>now()
    ) AS pro
  ) tier WHERE EXISTS (SELECT 1 FROM gateway.stripe_sandbox WHERE enabled);
$$;

REVOKE ALL ON gateway.stripe_refunds,gateway.wallet_credit_lots,gateway.stripe_invoices FROM PUBLIC,opentoken_app;
GRANT SELECT ON gateway.stripe_refunds TO opentoken_app;
GRANT SELECT,INSERT ON gateway.stripe_invoices TO opentoken_app;
REVOKE ALL ON FUNCTION gateway.allocate_wallet_usage(uuid,bigint),gateway.track_wallet_credit(),gateway.link_stripe_credit(),
  gateway.approve_stripe_refund(uuid,uuid,integer,text),gateway.apply_stripe_refund(uuid,text,text,integer,text),
  gateway.release_unsent_stripe_refund(uuid,text),gateway.sandbox_billing_limits(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gateway.apply_stripe_refund(uuid,text,text,integer,text),gateway.sandbox_billing_limits(uuid) TO opentoken_app;
