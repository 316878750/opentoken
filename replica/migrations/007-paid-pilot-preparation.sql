CREATE TABLE gateway.paid_pilot_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  checkout_enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE gateway.paid_pilot_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION gateway.guard_paid_pilot_separation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(961020032);
  IF TG_TABLE_NAME='stripe_sandbox' THEN
    IF EXISTS(SELECT 1 FROM gateway.paid_pilot_accounts) OR
      EXISTS(SELECT 1 FROM gateway.paid_pilot_settings) THEN
      RAISE EXCEPTION 'A paid pilot database cannot become a Stripe sandbox';
    END IF;
  ELSIF EXISTS(SELECT 1 FROM gateway.stripe_sandbox WHERE enabled) THEN
    RAISE EXCEPTION 'Paid pilot settings must be prepared outside the Stripe sandbox';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER paid_pilot_account_separation BEFORE INSERT ON gateway.paid_pilot_accounts
  FOR EACH ROW EXECUTE FUNCTION gateway.guard_paid_pilot_separation();
CREATE TRIGGER paid_pilot_checkout_separation BEFORE INSERT OR UPDATE ON gateway.paid_pilot_settings
  FOR EACH ROW EXECUTE FUNCTION gateway.guard_paid_pilot_separation();
CREATE TRIGGER stripe_sandbox_paid_pilot_separation BEFORE INSERT ON gateway.stripe_sandbox
  FOR EACH ROW EXECUTE FUNCTION gateway.guard_paid_pilot_separation();

CREATE FUNCTION gateway.paid_pilot_access(account_id uuid)
RETURNS TABLE (eligible boolean, checkout_allowed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT enrolled, enrolled AND EXISTS(SELECT 1 FROM gateway.paid_pilot_settings WHERE checkout_enabled)
  FROM (
    SELECT NOT EXISTS(SELECT 1 FROM gateway.stripe_sandbox WHERE enabled) AND EXISTS(
      SELECT 1 FROM gateway.paid_pilot_accounts p JOIN auth.users u ON u.id=p.user_id
      WHERE p.user_id=account_id AND u.email_confirmed_at IS NOT NULL
    ) AS enrolled
  ) access;
$$;

REVOKE ALL ON gateway.paid_pilot_settings,gateway.paid_pilot_accounts FROM PUBLIC,opentoken_app;
REVOKE ALL ON FUNCTION gateway.paid_pilot_access(uuid),gateway.guard_paid_pilot_separation() FROM PUBLIC,opentoken_app;
