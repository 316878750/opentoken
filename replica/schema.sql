-- ZeroCode-inspired MVP proposal. Apply to an empty Supabase project schema.
-- Supabase Auth owns auth.users. Application roles and transactions are defined
-- during implementation, before granting access to this private schema.
BEGIN;

CREATE SCHEMA gateway;
REVOKE ALL ON SCHEMA gateway FROM PUBLIC;

CREATE TABLE gateway.wallets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
    currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    balance_micros bigint NOT NULL DEFAULT 0 CHECK (balance_micros >= 0),
    held_micros bigint NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (held_micros <= balance_micros)
);

CREATE TABLE gateway.pricing_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gateway.models (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE,
    upstream_model text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    max_context_tokens integer NOT NULL CHECK (max_context_tokens > 0),
    max_output_tokens integer NOT NULL CHECK (max_output_tokens > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (max_output_tokens <= max_context_tokens)
);

CREATE TABLE gateway.model_rates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL REFERENCES gateway.pricing_groups(id) ON DELETE RESTRICT,
    model_id uuid NOT NULL REFERENCES gateway.models(id) ON DELETE RESTRICT,
    currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    input_micros_per_mtok bigint NOT NULL CHECK (input_micros_per_mtok >= 0),
    cached_input_micros_per_mtok bigint NOT NULL CHECK (cached_input_micros_per_mtok >= 0),
    output_micros_per_mtok bigint NOT NULL CHECK (output_micros_per_mtok >= 0),
    multiplier_bps integer NOT NULL CHECK (multiplier_bps > 0),
    closed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, group_id, model_id),
    CHECK (closed_at IS NULL OR closed_at >= created_at)
);
CREATE UNIQUE INDEX model_rates_current_idx
    ON gateway.model_rates (group_id, model_id) WHERE closed_at IS NULL;
CREATE INDEX model_rates_group_model_idx ON gateway.model_rates (group_id, model_id);
CREATE INDEX model_rates_model_idx ON gateway.model_rates (model_id);

CREATE TABLE gateway.api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES gateway.wallets(user_id) ON DELETE RESTRICT,
    group_id uuid NOT NULL REFERENCES gateway.pricing_groups(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
    public_prefix text NOT NULL,
    secret_digest bytea NOT NULL UNIQUE CHECK (octet_length(secret_digest) = 32),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
    spend_cap_micros bigint CHECK (spend_cap_micros > 0),
    spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
    held_micros bigint NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
    rpm_limit integer NOT NULL CHECK (rpm_limit > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id, group_id),
    CHECK (spend_cap_micros IS NULL OR spent_micros + held_micros <= spend_cap_micros)
);
CREATE INDEX api_keys_user_created_idx ON gateway.api_keys (user_id, created_at DESC, id DESC);
CREATE INDEX api_keys_group_idx ON gateway.api_keys (group_id);

CREATE TABLE gateway.usage_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES gateway.wallets(user_id) ON DELETE RESTRICT,
    key_id uuid NOT NULL,
    group_id uuid NOT NULL,
    model_id uuid NOT NULL,
    rate_id uuid NOT NULL,
    upstream_model_snapshot text NOT NULL,
    idempotency_key text CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
    request_fingerprint bytea CHECK (octet_length(request_fingerprint) = 32),
    upstream_request_id text,
    status text NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'dispatched', 'review', 'settled', 'released')),
    reserved_micros bigint NOT NULL CHECK (reserved_micros >= 0),
    input_tokens integer CHECK (input_tokens >= 0),
    cached_input_tokens integer CHECK (cached_input_tokens BETWEEN 0 AND input_tokens),
    output_tokens integer CHECK (output_tokens >= 0),
    standard_micros bigint CHECK (standard_micros >= 0),
    charged_micros bigint CHECK (charged_micros BETWEEN 0 AND reserved_micros),
    duration_ms integer CHECK (duration_ms >= 0),
    terminal_reason text,
    finalized_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id),
    FOREIGN KEY (key_id, user_id, group_id)
        REFERENCES gateway.api_keys(id, user_id, group_id) ON DELETE RESTRICT,
    FOREIGN KEY (rate_id, group_id, model_id)
        REFERENCES gateway.model_rates(id, group_id, model_id) ON DELETE RESTRICT,
    CHECK ((idempotency_key IS NULL) = (request_fingerprint IS NULL)),
    CHECK ((status IN ('settled', 'released')) = (finalized_at IS NOT NULL)),
    CHECK ((status = 'settled') = (charged_micros IS NOT NULL)),
    CHECK (status <> 'settled' OR (
        input_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL AND
        output_tokens IS NOT NULL AND standard_micros IS NOT NULL
    ))
);
CREATE UNIQUE INDEX usage_requests_idempotency_idx
    ON gateway.usage_requests (key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX usage_requests_user_time_idx
    ON gateway.usage_requests (user_id, created_at DESC, id DESC);
CREATE INDEX usage_requests_user_key_time_idx
    ON gateway.usage_requests (user_id, key_id, created_at DESC, id DESC);
CREATE INDEX usage_requests_key_time_idx
    ON gateway.usage_requests (key_id, created_at DESC);
CREATE INDEX usage_requests_rate_idx ON gateway.usage_requests (rate_id);
CREATE INDEX usage_requests_pending_idx ON gateway.usage_requests (status, updated_at)
    WHERE status IN ('reserved', 'dispatched', 'review');

CREATE TABLE gateway.redeem_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    secret_digest bytea NOT NULL UNIQUE CHECK (octet_length(secret_digest) = 32),
    currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    amount_micros bigint NOT NULL CHECK (amount_micros > 0),
    expires_at timestamptz NOT NULL,
    voided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);

CREATE TABLE gateway.wallet_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES gateway.wallets(user_id) ON DELETE RESTRICT,
    request_id uuid UNIQUE,
    redeem_code_id uuid UNIQUE REFERENCES gateway.redeem_codes(id) ON DELETE RESTRICT,
    currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    kind text NOT NULL CHECK (kind IN ('usage', 'redemption')),
    delta_micros bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (request_id, user_id)
        REFERENCES gateway.usage_requests(id, user_id) ON DELETE RESTRICT,
    CHECK (
        (kind = 'usage' AND request_id IS NOT NULL AND redeem_code_id IS NULL AND delta_micros <= 0)
        OR
        (kind = 'redemption' AND request_id IS NULL AND redeem_code_id IS NOT NULL AND delta_micros > 0)
    )
);
CREATE INDEX wallet_entries_user_time_idx ON gateway.wallet_entries (user_id, created_at DESC, id DESC);

REVOKE ALL ON ALL TABLES IN SCHEMA gateway FROM PUBLIC;

COMMIT;
