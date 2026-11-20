CREATE TABLE gateway.redeem_attempts (
    user_id uuid PRIMARY KEY REFERENCES gateway.wallets(user_id) ON DELETE CASCADE,
    window_started_at timestamptz NOT NULL,
    invalid_attempts integer NOT NULL CHECK (invalid_attempts BETWEEN 1 AND 5)
);

CREATE FUNCTION gateway.redeem_trial_credit(account_id uuid, code_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    balance bigint;
    held bigint;
    code gateway.redeem_codes%ROWTYPE;
    receipt gateway.wallet_entries%ROWTYPE;
    window_start timestamptz;
    attempts integer;
    checked_at timestamptz;
    replayed boolean;
BEGIN
    -- Other accounting operations lock this wallet before locking dependent rows.
    SELECT balance_micros, held_micros INTO STRICT balance, held
    FROM gateway.wallets WHERE user_id = account_id FOR UPDATE;
    SELECT * INTO code FROM gateway.redeem_codes WHERE secret_digest = code_digest FOR UPDATE;
    IF code.id IS NOT NULL THEN
        SELECT * INTO receipt FROM gateway.wallet_entries WHERE redeem_code_id = code.id;
    END IF;
    replayed := receipt.id IS NOT NULL AND receipt.user_id = account_id;
    IF NOT replayed THEN
        checked_at := clock_timestamp();
        SELECT window_started_at, invalid_attempts INTO window_start, attempts
        FROM gateway.redeem_attempts WHERE user_id = account_id;
        IF window_start IS NULL OR window_start + interval '1 minute' <= checked_at THEN
            window_start := checked_at;
            attempts := 0;
        END IF;
        IF attempts >= 5 THEN
            RETURN jsonb_build_object('status', 'rate_limited',
                'retryAfter', greatest(1, ceil(extract(epoch FROM window_start + interval '1 minute' - checked_at))));
        END IF;
        IF code.id IS NULL OR receipt.id IS NOT NULL OR code.voided_at IS NOT NULL OR code.expires_at <= checked_at THEN
            INSERT INTO gateway.redeem_attempts (user_id, window_started_at, invalid_attempts)
            VALUES (account_id, window_start, attempts + 1)
            ON CONFLICT (user_id) DO UPDATE SET
                window_started_at = EXCLUDED.window_started_at,
                invalid_attempts = EXCLUDED.invalid_attempts;
            RETURN jsonb_build_object('status', 'unavailable');
        END IF;
        IF code.amount_micros > 9223372036854775807 - balance THEN
            RETURN jsonb_build_object('status', 'balance_limit');
        END IF;
        INSERT INTO gateway.wallet_entries (user_id, redeem_code_id, kind, delta_micros, created_at, updated_at)
        VALUES (account_id, code.id, 'redemption', code.amount_micros, checked_at, checked_at)
        RETURNING * INTO receipt;
        UPDATE gateway.wallets SET balance_micros = balance_micros + code.amount_micros, updated_at = checked_at
        WHERE user_id = account_id RETURNING balance_micros INTO balance;
    END IF;
    RETURN jsonb_build_object('status', 'ok', 'replayed', replayed,
        'receipt', jsonb_build_object('id', receipt.id, 'amountMicros', receipt.delta_micros::text, 'createdAt', receipt.created_at),
        'wallet', jsonb_build_object('balanceMicros', balance::text, 'heldMicros', held::text,
            'availableMicros', (balance - held)::text));
END;
$$;

REVOKE ALL ON gateway.redeem_codes, gateway.redeem_attempts FROM PUBLIC, opentoken_app;
REVOKE ALL ON FUNCTION gateway.redeem_trial_credit(uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gateway.redeem_trial_credit(uuid,bytea) TO opentoken_app;
