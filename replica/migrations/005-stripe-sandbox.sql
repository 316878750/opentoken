CREATE TABLE gateway.stripe_sandbox (
  enabled boolean PRIMARY KEY CHECK (enabled),
  enabled_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION gateway.guard_stripe_sandbox_dispatch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM gateway.models WHERE id=NEW.model_id AND code<>'mock-text') THEN
    PERFORM pg_advisory_xact_lock_shared(961020032);
    IF EXISTS (SELECT 1 FROM gateway.stripe_sandbox) THEN
      RAISE EXCEPTION 'Stripe sandbox prevents real upstream dispatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stripe_sandbox_dispatch_guard BEFORE INSERT OR UPDATE OF model_id ON gateway.usage_requests
  FOR EACH ROW EXECUTE FUNCTION gateway.guard_stripe_sandbox_dispatch();
REVOKE ALL ON FUNCTION gateway.guard_stripe_sandbox_dispatch() FROM PUBLIC;

CREATE TABLE gateway.stripe_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES gateway.wallets(user_id) ON DELETE RESTRICT,
  nonce uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('credit','subscription')),
  price_id text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','paid','expired')),
  checkout_id text UNIQUE,
  payment_id text UNIQUE,
  customer_id text,
  subscription_id text UNIQUE,
  subscription_status text,
  period_end timestamptz,
  redeemed_code_id uuid UNIQUE REFERENCES gateway.redeem_codes(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '45 minutes',
  UNIQUE (user_id,nonce),
  CHECK (redeemed_code_id IS NULL OR (kind='credit' AND state='paid' AND payment_id IS NOT NULL)),
  CHECK (kind='subscription' OR (subscription_id IS NULL AND subscription_status IS NULL AND period_end IS NULL))
);
CREATE INDEX stripe_orders_user_time_idx ON gateway.stripe_orders(user_id,created_at DESC,id DESC);

CREATE TABLE gateway.stripe_events (
  id text PRIMARY KEY,
  kind text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION gateway.credit_stripe_test_order(order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid;
  target gateway.stripe_orders%ROWTYPE;
  inserted_code uuid;
  credit_amount bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gateway.stripe_sandbox WHERE enabled) THEN
    RAISE EXCEPTION 'Stripe sandbox is disabled for this database';
  END IF;
  SELECT user_id INTO STRICT owner_id FROM gateway.stripe_orders WHERE id=order_id;
  PERFORM 1 FROM gateway.wallets WHERE user_id=owner_id FOR UPDATE;
  SELECT * INTO STRICT target FROM gateway.stripe_orders WHERE id=order_id FOR UPDATE;
  IF target.kind<>'credit' OR target.state<>'paid' OR target.payment_id IS NULL OR target.checkout_id IS NULL THEN
    RAISE EXCEPTION 'Checkout does not have a confirmed test payment';
  END IF;
  IF target.redeemed_code_id IS NOT NULL THEN RETURN; END IF;
  credit_amount := target.amount_cents::bigint*10000;
  INSERT INTO gateway.redeem_codes (secret_digest,amount_micros,expires_at)
    VALUES (sha256(convert_to('opentoken:stripe:test:'||target.id::text,'UTF8')),credit_amount,now()+interval '1 day')
    RETURNING id INTO inserted_code;
  INSERT INTO gateway.wallet_entries (user_id,redeem_code_id,kind,delta_micros)
    VALUES (owner_id,inserted_code,'redemption',credit_amount);
  UPDATE gateway.wallets SET balance_micros=balance_micros+credit_amount,updated_at=now() WHERE user_id=owner_id;
  UPDATE gateway.stripe_orders SET redeemed_code_id=inserted_code WHERE id=order_id;
END $$;

REVOKE ALL ON gateway.stripe_orders,gateway.stripe_events,gateway.stripe_sandbox FROM PUBLIC, opentoken_app;
GRANT SELECT ON gateway.stripe_sandbox TO opentoken_app;
GRANT SELECT,INSERT,UPDATE ON gateway.stripe_orders TO opentoken_app;
GRANT INSERT,SELECT ON gateway.stripe_events TO opentoken_app;
REVOKE ALL ON FUNCTION gateway.credit_stripe_test_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gateway.credit_stripe_test_order(uuid) TO opentoken_app;
