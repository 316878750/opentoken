import { store, transaction } from './data';
import type { Pool, PoolClient } from 'pg';

export async function dashboard(user: string, tz: string) {
  const { db } = await store();
  const { rows:[row] } = await db.query(`WITH boundary AS (
    SELECT date_trunc('day',now() AT TIME ZONE $2) AT TIME ZONE $2 AS today
  ), totals AS (
    SELECT count(*)::int AS requests,
      count(*) FILTER (WHERE created_at>=today)::int AS "todayRequests",
      coalesce(sum(input_tokens+output_tokens) FILTER (WHERE status='settled'),0)::text AS tokens,
      coalesce(sum(input_tokens+output_tokens) FILTER (WHERE status='settled' AND created_at>=today),0)::text AS "todayTokens",
      coalesce(sum(charged_micros) FILTER (WHERE status='settled'),0)::text AS "chargedMicros",
      coalesce(sum(standard_micros) FILTER (WHERE status='settled'),0)::text AS "standardMicros",
      coalesce(sum(charged_micros) FILTER (WHERE status='settled' AND created_at>=today),0)::text AS "todayChargedMicros",
      count(*) FILTER (WHERE status='review')::int AS "reviewCount"
    FROM gateway.usage_requests CROSS JOIN boundary WHERE user_id=$1
  )
  SELECT balance_micros::text AS "balanceMicros",held_micros::text AS "heldMicros",refund_held_micros::text AS "refundHeldMicros",
    (balance_micros-held_micros-refund_held_micros)::text AS "availableMicros",now() AS "asOf",
    (SELECT count(*)::int FROM gateway.api_keys WHERE user_id=$1 AND status='active') AS "activeKeys",totals.*
  FROM gateway.wallets CROSS JOIN totals WHERE user_id=$1`,[user,tz]);
  return row;
}

export type TrendDay = {date:string;requests:number;tokens:string;chargedMicros:string};

export async function usageTrend(user:string,tz:string,days:7|30) {
  const {db} = await store();
  const {rows} = await db.query<TrendDay>(`WITH calendar AS (
    SELECT (now() AT TIME ZONE $2)::date AS today
  ), bounds AS (
    SELECT today, today-($3::int-1) AS first_day FROM calendar
  ), totals AS (
    SELECT (created_at AT TIME ZONE $2)::date AS day, count(*)::int AS requests,
      coalesce(sum(input_tokens::bigint+output_tokens) FILTER (WHERE status='settled'),0)::text AS tokens,
      coalesce(sum(charged_micros) FILTER (WHERE status='settled'),0)::text AS charged
    FROM gateway.usage_requests CROSS JOIN bounds WHERE user_id=$1
      AND created_at >= (first_day::timestamp AT TIME ZONE $2)
      AND created_at < ((today+1)::timestamp AT TIME ZONE $2)
    GROUP BY 1
  )
  SELECT to_char(bounds.first_day+dates.day_offset,'YYYY-MM-DD') AS date,
    coalesce(totals.requests,0) AS requests, coalesce(totals.tokens,'0') AS tokens,
    coalesce(totals.charged,'0') AS "chargedMicros"
  FROM bounds CROSS JOIN generate_series(0,$3::int-1) AS dates(day_offset)
  LEFT JOIN totals ON totals.day=bounds.first_day+dates.day_offset
  ORDER BY dates.day_offset`,[user,tz,days]);
  return {items:rows};
}

export type UsageFilter = { key_id?:string; request_id?:string; model?:string; status?:string; from?:string; to?:string; fromDay?:string; throughDay?:string; cursor?:string; trend?:'1' };
export type UsageDay = TrendDay & {inputTokens:string;cachedTokens:string;outputTokens:string;heldMicros:string};

export async function usageModels(user:string) {
  const {rows} = await store().db.query<{model:string}>(`SELECT DISTINCT m.code AS model
    FROM gateway.usage_requests u JOIN gateway.models m ON m.id=u.model_id WHERE u.user_id=$1 ORDER BY model`,[user]);
  return rows.map(row=>row.model);
}

export async function usage(user: string, f: UsageFilter,tz:string) {
  const scope = `FROM gateway.usage_requests u JOIN gateway.models m ON m.id=u.model_id
    WHERE u.user_id=$1 AND ($2::uuid IS NULL OR u.key_id=$2) AND ($3::uuid IS NULL OR u.id=$3)
      AND ($4::text IS NULL OR u.status=$4) AND ($5::text IS NULL OR m.code=$5)
      AND ($6::timestamptz IS NULL OR u.created_at >= $6) AND ($7::timestamptz IS NULL OR u.created_at < $7)
      AND ($8::date IS NULL OR u.created_at >= ($8::date::timestamp AT TIME ZONE $10))
      AND ($9::date IS NULL OR u.created_at < (($9::date+1)::timestamp AT TIME ZONE $10))`;
  const args = [user,f.key_id,f.request_id,f.status,f.model,f.from,f.to,f.fromDay,f.throughDay,tz];
  async function page(db:Pool|PoolClient) {
    const {rows} = await db.query<{id:string}>(`WITH page AS (
      SELECT u.*,m.code AS model ${scope}
        AND ($11::uuid IS NULL OR (u.created_at,u.id)<(SELECT created_at,id FROM gateway.usage_requests WHERE id=$11 AND user_id=$1))
      ORDER BY u.created_at DESC,u.id DESC LIMIT 21
    ) SELECT u.id,u.key_id AS "keyId",k.public_prefix AS prefix,u.model,u.status,
    u.reserved_micros::text AS "reservedMicros",u.standard_micros::text AS "standardMicros",u.charged_micros::text AS "chargedMicros",
    (CASE WHEN u.status='settled' THEN u.reserved_micros-u.charged_micros
      WHEN u.status='released' THEN u.reserved_micros END)::text AS "releasedMicros",
    u.input_tokens AS "inputTokens",u.cached_input_tokens AS "cachedTokens",u.output_tokens AS "outputTokens",
    u.created_at AS "createdAt",u.updated_at AS "updatedAt",entry.delta_micros::text AS "ledgerDeltaMicros",
    u.upstream_request_id AS "upstreamRequestId"
  FROM page u JOIN gateway.api_keys k ON k.id=u.key_id
  LEFT JOIN gateway.wallet_entries entry ON entry.request_id=u.id AND entry.user_id=u.user_id
  ORDER BY u.created_at DESC,u.id DESC`,[...args,f.cursor]);
    return {items:rows.slice(0,20),nextCursor:rows.length>20 ? rows[19].id : null};
  }
  if (!f.trend) return page(store().db);
  return transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const records = await page(tx);
    const {rows:days} = await tx.query<UsageDay>(`SELECT to_char(u.created_at AT TIME ZONE $10,'YYYY-MM-DD') AS date,
      count(*)::int AS requests,
      coalesce(sum(u.input_tokens) FILTER (WHERE u.status='settled'),0)::text AS "inputTokens",
      coalesce(sum(u.cached_input_tokens) FILTER (WHERE u.status='settled'),0)::text AS "cachedTokens",
      coalesce(sum(u.output_tokens) FILTER (WHERE u.status='settled'),0)::text AS "outputTokens",
      coalesce(sum(u.input_tokens::bigint+u.output_tokens) FILTER (WHERE u.status='settled'),0)::text AS tokens,
      coalesce(sum(u.charged_micros) FILTER (WHERE u.status='settled'),0)::text AS "chargedMicros",
      coalesce(sum(u.reserved_micros) FILTER (WHERE u.status IN ('reserved','dispatched','review')),0)::text AS "heldMicros"
      ${scope} GROUP BY 1 ORDER BY 1`,args);
    return {...records,days};
  });
}
