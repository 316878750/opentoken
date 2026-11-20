CREATE TABLE gateway.billing_resolutions (
    request_id uuid PRIMARY KEY REFERENCES gateway.usage_requests(id) ON DELETE RESTRICT,
    action text NOT NULL CHECK (action IN ('settle', 'release', 'expire')),
    operator_id text NOT NULL CHECK (char_length(operator_id) BETWEEN 1 AND 80),
    database_actor name NOT NULL DEFAULT session_user,
    evidence_reference text NOT NULL CHECK (char_length(evidence_reference) BETWEEN 1 AND 300),
    previous_reason text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gateway.billing_alerts (
    kind text NOT NULL,
    entity_id uuid NOT NULL,
    expected numeric,
    actual numeric,
    opened_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    resolved_at timestamptz,
    PRIMARY KEY (kind, entity_id)
);

CREATE FUNCTION gateway.resolve_billing_request(
    request_uuid uuid, decision text, operator_name text, evidence text,
    input_count integer, cache_count integer, output_count integer
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    target gateway.usage_requests%ROWTYPE;
    recorded gateway.billing_resolutions%ROWTYPE;
    rate gateway.model_rates%ROWTYPE;
    weighted numeric;
    standard_fee bigint;
    charge bigint;
BEGIN
    IF decision IS NULL OR decision NOT IN ('settle', 'release', 'expire') THEN
        RAISE EXCEPTION 'Invalid billing decision';
    END IF;
    IF operator_name IS NULL OR char_length(btrim(operator_name)) NOT BETWEEN 1 AND 80
        OR operator_name ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'An operator identifier is required';
    END IF;
    IF evidence IS NULL OR char_length(btrim(evidence)) NOT BETWEEN 1 AND 300
        OR evidence ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'An evidence reference is required';
    END IF;
    IF decision = 'settle' THEN
        IF input_count IS NULL OR cache_count IS NULL OR output_count IS NULL
            OR input_count < 0 OR cache_count NOT BETWEEN 0 AND input_count OR output_count < 0 THEN
            RAISE EXCEPTION 'Supply valid input, cached and output token counts';
        END IF;
    ELSIF num_nonnulls(input_count, cache_count, output_count) <> 0 THEN
        RAISE EXCEPTION 'Release and expiry do not accept token counts';
    END IF;

    SELECT * INTO target FROM gateway.usage_requests WHERE id = request_uuid;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Billing request not found';
    END IF;
    -- Match the gateway's wallet → key → request lock order.
    PERFORM 1 FROM gateway.wallets WHERE user_id = target.user_id FOR UPDATE;
    PERFORM 1 FROM gateway.api_keys WHERE id = target.key_id FOR UPDATE;
    SELECT * INTO STRICT target FROM gateway.usage_requests WHERE id = request_uuid FOR UPDATE;

    IF decision = 'expire' AND (target.status <> 'reserved'
        OR target.updated_at >= clock_timestamp() - interval '2 minutes') THEN
        RETURN NULL;
    ELSIF target.status IN ('settled', 'released') THEN
        SELECT * INTO recorded FROM gateway.billing_resolutions WHERE request_id = request_uuid;
        IF FOUND AND recorded.action = decision AND recorded.operator_id = btrim(operator_name)
            AND recorded.evidence_reference = btrim(evidence)
            AND target.input_tokens IS NOT DISTINCT FROM input_count
            AND target.cached_input_tokens IS NOT DISTINCT FROM cache_count
            AND target.output_tokens IS NOT DISTINCT FROM output_count THEN
            RETURN jsonb_build_object('status', target.status, 'replayed', true,
                'chargedMicros', coalesce(target.charged_micros, 0)::text,
                'releasedMicros', (target.reserved_micros - coalesce(target.charged_micros, 0))::text);
        END IF;
        RAISE EXCEPTION 'Billing request already resolved with a different decision';
    ELSIF decision <> 'expire' AND target.status <> 'review' THEN
        RAISE EXCEPTION 'Billing request is not awaiting review';
    END IF;

    IF decision = 'settle' THEN
        SELECT * INTO STRICT rate FROM gateway.model_rates WHERE id = target.rate_id;
        weighted := (input_count - cache_count)::numeric * rate.input_micros_per_mtok
            + cache_count::numeric * rate.cached_input_micros_per_mtok
            + output_count::numeric * rate.output_micros_per_mtok;
        IF div(weighted * rate.multiplier_bps + 9999999999, 10000000000) > target.reserved_micros THEN
            RAISE EXCEPTION 'Verified fee exceeds the original reservation';
        END IF;
        standard_fee := div(weighted + 999999, 1000000);
        charge := div(weighted * rate.multiplier_bps + 9999999999, 10000000000);
        INSERT INTO gateway.wallet_entries (user_id, request_id, kind, delta_micros)
        VALUES (target.user_id, target.id, 'usage', -charge);
    END IF;

    UPDATE gateway.usage_requests SET
        status = CASE WHEN decision = 'settle' THEN 'settled' ELSE 'released' END,
        input_tokens = input_count, cached_input_tokens = cache_count, output_tokens = output_count,
        standard_micros = standard_fee, charged_micros = charge,
        terminal_reason = CASE decision WHEN 'settle' THEN 'operator_settled'
            WHEN 'release' THEN 'operator_released' ELSE 'reservation_expired' END,
        finalized_at = now(), updated_at = now()
    WHERE id = target.id;
    UPDATE gateway.wallets SET balance_micros = balance_micros - coalesce(charge, 0),
        held_micros = held_micros - target.reserved_micros, updated_at = now()
    WHERE user_id = target.user_id;
    UPDATE gateway.api_keys SET spent_micros = spent_micros + coalesce(charge, 0),
        held_micros = held_micros - target.reserved_micros, updated_at = now()
    WHERE id = target.key_id;
    INSERT INTO gateway.billing_resolutions (request_id, action, operator_id, evidence_reference, previous_reason)
    VALUES (target.id, decision, btrim(operator_name), btrim(evidence), target.terminal_reason);
    RETURN jsonb_build_object('status', CASE WHEN decision = 'settle' THEN 'settled' ELSE 'released' END,
        'replayed', false, 'chargedMicros', coalesce(charge, 0)::text,
        'releasedMicros', (target.reserved_micros - coalesce(charge, 0))::text);
END;
$$;

CREATE FUNCTION gateway.run_billing_maintenance()
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    scan_time timestamptz := clock_timestamp();
    request_uuid uuid;
    expired_count integer := 0;
    review_count integer;
    alert_count integer;
BEGIN
    IF NOT pg_try_advisory_xact_lock(961020032) THEN
        RETURN jsonb_build_object('skipped', 'maintenance_in_progress');
    END IF;
    FOR request_uuid IN
        SELECT id FROM gateway.usage_requests
        WHERE status = 'reserved' AND updated_at < scan_time - interval '2 minutes'
        ORDER BY updated_at, id LIMIT 50
    LOOP
        IF gateway.resolve_billing_request(request_uuid, 'expire', 'billing-maintenance',
            'reservation expired before dispatch', NULL, NULL, NULL) IS NOT NULL THEN
            expired_count := expired_count + 1;
        END IF;
    END LOOP;

    WITH stale AS (
        SELECT id FROM gateway.usage_requests
        WHERE status = 'dispatched' AND updated_at < scan_time - interval '2 minutes'
        ORDER BY updated_at, id LIMIT 500 FOR UPDATE SKIP LOCKED
    )
    UPDATE gateway.usage_requests u SET status = 'review', terminal_reason = 'dispatch_interrupted', updated_at = scan_time
    FROM stale WHERE u.id = stale.id;
    GET DIAGNOSTICS review_count = ROW_COUNT;

    WITH ledger AS (
        SELECT user_id, sum(delta_micros) AS balance FROM gateway.wallet_entries GROUP BY user_id
    ), wallet_holds AS (
        SELECT user_id, sum(reserved_micros) AS held FROM gateway.usage_requests
        WHERE status IN ('reserved', 'dispatched', 'review') GROUP BY user_id
    ), key_totals AS (
        SELECT key_id,
            sum(reserved_micros) FILTER (WHERE status IN ('reserved', 'dispatched', 'review')) AS held,
            sum(charged_micros) FILTER (WHERE status = 'settled') AS spent
        FROM gateway.usage_requests GROUP BY key_id
    ), issues(kind, entity_id, expected, actual) AS MATERIALIZED (
        SELECT 'wallet_balance', w.user_id, coalesce(l.balance, 0), w.balance_micros
        FROM gateway.wallets w LEFT JOIN ledger l USING (user_id) WHERE w.balance_micros <> coalesce(l.balance, 0)
        UNION ALL
        SELECT 'wallet_hold', w.user_id, coalesce(h.held, 0), w.held_micros
        FROM gateway.wallets w LEFT JOIN wallet_holds h USING (user_id) WHERE w.held_micros <> coalesce(h.held, 0)
        UNION ALL
        SELECT 'key_hold', k.id, coalesce(t.held, 0), k.held_micros
        FROM gateway.api_keys k LEFT JOIN key_totals t ON t.key_id = k.id WHERE k.held_micros <> coalesce(t.held, 0)
        UNION ALL
        SELECT 'key_spent', k.id, coalesce(t.spent, 0), k.spent_micros
        FROM gateway.api_keys k LEFT JOIN key_totals t ON t.key_id = k.id WHERE k.spent_micros <> coalesce(t.spent, 0)
        UNION ALL
        SELECT 'request_ledger', u.id, -u.charged_micros, e.delta_micros
        FROM gateway.usage_requests u LEFT JOIN gateway.wallet_entries e ON e.request_id = u.id
        WHERE (u.status = 'settled' AND (e.id IS NULL OR e.delta_micros <> -u.charged_micros))
            OR (u.status <> 'settled' AND e.id IS NOT NULL)
        UNION ALL
        SELECT 'review_stale', id, 900, floor(extract(epoch FROM scan_time - updated_at))
        FROM gateway.usage_requests WHERE status = 'review' AND updated_at < scan_time - interval '15 minutes'
    ), opened AS (
        INSERT INTO gateway.billing_alerts AS a (kind, entity_id, expected, actual, opened_at, last_seen_at)
        SELECT kind, entity_id, expected, actual, scan_time, scan_time FROM issues
        ON CONFLICT (kind, entity_id) DO UPDATE SET expected = EXCLUDED.expected, actual = EXCLUDED.actual,
            opened_at = CASE WHEN a.resolved_at IS NULL THEN a.opened_at ELSE EXCLUDED.opened_at END,
            last_seen_at = EXCLUDED.last_seen_at, resolved_at = NULL
        RETURNING kind
    ), closed AS (
        UPDATE gateway.billing_alerts a SET resolved_at = scan_time
        WHERE a.resolved_at IS NULL AND NOT EXISTS
            (SELECT 1 FROM issues i WHERE i.kind = a.kind AND i.entity_id = a.entity_id)
    )
    SELECT count(*)::integer INTO alert_count FROM opened;

    IF alert_count > 0 THEN
        RAISE WARNING 'OpenToken billing has % open alert(s); inspect gateway.billing_alerts', alert_count;
    END IF;
    RETURN jsonb_build_object('expired', expired_count, 'movedToReview', review_count, 'openAlerts', alert_count);
END;
$$;

REVOKE ALL ON gateway.billing_resolutions, gateway.billing_alerts FROM PUBLIC, opentoken_app;
REVOKE ALL ON FUNCTION gateway.resolve_billing_request(uuid,text,text,text,integer,integer,integer) FROM PUBLIC, opentoken_app;
REVOKE ALL ON FUNCTION gateway.run_billing_maintenance() FROM PUBLIC, opentoken_app;
