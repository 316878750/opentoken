import { randomBytes } from 'node:crypto';
import { after } from 'next/server';
import { digest, lockAccount, store, transaction } from './data';
import { channelCredentials, channelRoutingLock, type ChannelCredential } from './channel-credentials';
import { mockCompletion, mockModel, openAiCompletion, openAiStream, UpstreamError, type CompletionInput, type TextDelta } from './upstream';
import { resolveLiveUpstreams, type LiveUpstream } from './upstream-config.mjs';

export class Fault extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) { super(message); }
}

type Rate = {
  rate_id: string; model_id: string; group_id: string; model: string; upstream_model: string;
  max_context_tokens: number; max_output_tokens: number; input_rate: string; cache_rate: string;
  output_rate: string; multiplier: number; group_name: string; in_sync:boolean;
  route_mode:'official'|'compatible'|null; streaming:boolean; channel_version_id:string|null; credential_ref:string|null;
  response_model:string|null; token_field:LiveUpstream['tokenField']|null;
};

const inSync = `(managed.version_id IS NOT NULL OR route.mode IS DISTINCT FROM 'compatible' OR (
    m.max_context_tokens=route.max_context AND m.max_output_tokens=route.max_output
    AND r.input_micros_per_mtok=route.input_rate AND r.cached_input_micros_per_mtok=route.cache_rate
    AND r.output_micros_per_mtok=route.output_rate AND r.multiplier_bps=route.multiplier
  ))`;
const rateQuery = `SELECT r.id AS rate_id, m.id AS model_id, g.id AS group_id, m.code AS model,
  coalesce(managed.upstream_model,m.upstream_model) AS upstream_model,
  m.max_context_tokens, m.max_output_tokens, g.name AS group_name, ${inSync} AS in_sync,
  coalesce(managed.adapter,route.mode) AS route_mode,
  coalesce(managed.streaming AND ($1::jsonb->>'managedStreaming')='true',route.streaming,false) AS streaming,
  managed.version_id AS channel_version_id,managed.credential_ref,managed.response_model,managed.token_field,
  r.input_micros_per_mtok::text AS input_rate, r.cached_input_micros_per_mtok::text AS cache_rate,
  r.output_micros_per_mtok::text AS output_rate, r.multiplier_bps AS multiplier
  FROM gateway.model_rates r JOIN gateway.models m ON m.id=r.model_id JOIN gateway.pricing_groups g ON g.id=r.group_id
  LEFT JOIN gateway.channel_runtime_routes managed ON managed.model_id=m.id AND managed.group_id=g.id
  LEFT JOIN jsonb_to_recordset($1::jsonb->'legacy') AS route(alias text, model text, group_code text, mode text,
    max_context integer, max_output integer, input_rate bigint, cache_rate bigint, output_rate bigint, multiplier integer,streaming boolean)
    ON route.alias=m.code AND route.model=m.upstream_model AND route.group_code=g.code
  WHERE r.closed_at IS NULL AND m.enabled AND g.enabled
    AND ((m.code='${mockModel}' AND m.upstream_model='${mockModel}') OR
      (NOT EXISTS (SELECT 1 FROM gateway.stripe_sandbox WHERE enabled) AND CASE WHEN managed.version_id IS NULL
        THEN NOT m.admin_managed AND route.alias IS NOT NULL
        ELSE managed.effective AND ($1::jsonb->'credentials')->>managed.credential_ref=managed.credential_fingerprint END))`;
const availableRateQuery = `${rateQuery} AND ${inSync}`;

function routeParameters(providers=resolveLiveUpstreams(),credentials=channelCredentials()) {
  const legacy = providers.flatMap(provider=>provider.groups.map(group=>({
    alias:provider.alias,model:provider.model,mode:provider.mode,group_code:group.code,
    max_context:provider.maxContextTokens,max_output:provider.maxOutputTokens,
    input_rate:provider.inputMicros,cache_rate:provider.cacheMicros,output_rate:provider.outputMicros,multiplier:group.multiplierBps,
    streaming:provider.streaming,
  })));
  const approved = process.env.ENABLE_OPENAI==='1' ? credentials : [];
  return JSON.stringify({legacy,managedStreaming:process.env.ENABLE_UPSTREAM_STREAMING==='1',
    credentials:Object.fromEntries(approved.map(entry=>[entry.ref,entry.fingerprint]))});
}

function managedUpstream(rate:Rate,credentials:ChannelCredential[]):LiveUpstream {
  const credential = credentials.find(entry=>entry.ref===rate.credential_ref);
  if (!credential || !rate.response_model || !rate.token_field) throw new Error('Invalid managed route');
  return {mode:credential.type,alias:rate.model,model:rate.upstream_model,responseModel:rate.response_model,
    endpoint:credential.endpoint,apiKey:credential.apiKey,tokenField:rate.token_field,maxContextTokens:rate.max_context_tokens,
    maxOutputTokens:rate.max_output_tokens,streaming:rate.streaming,inputMicros:rate.input_rate,
    cacheMicros:rate.cache_rate,outputMicros:rate.output_rate,groups:[]};
}

export async function catalog() {
  const { db } = await store();
  const { rows } = await db.query<Rate>(availableRateQuery,[routeParameters()]);
  return rows.map(r => ({groupId:r.group_id,groupName:r.group_name,model:r.model,inputMicros:r.input_rate,
      cacheMicros:r.cache_rate,outputMicros:r.output_rate,multiplierBps:r.multiplier,
      maxContextTokens:r.max_context_tokens,maxOutputTokens:r.max_output_tokens,
      upstream:r.model===mockModel ? 'mock' : r.route_mode==='compatible' ? 'compatible' : 'openai',
      streaming:r.model===mockModel || r.streaming}));
}

export async function createKey(user: string, name: string, groupId: string, rpm: number, cap: string | null) {
  const secret = 'mg_' + randomBytes(32).toString('base64url');
  const prefix = secret.slice(0, 12);
  const {rows}=await transaction(async tx=>{
    await lockAccount(tx,user);
    const wallet = await tx.query(`SELECT 1 FROM gateway.wallets WHERE user_id=$1
      AND gateway.account_access(user_id) IS NOT NULL FOR UPDATE`,[user]);
    if (!wallet.rowCount) throw new Fault(401,'session_required','请重新登录。');
    await requireKeySlot(tx,user);
    return tx.query<{id:string}>(`INSERT INTO gateway.api_keys (user_id,group_id,name,public_prefix,secret_digest,rpm_limit,spend_cap_micros)
      SELECT $2,group_id,$3,$4,$5,$6,$7 FROM (${availableRateQuery} AND g.id=$8 LIMIT 1) available RETURNING id`,
      [routeParameters(),user,name,prefix,await digest('api-key',secret),rpm,cap,groupId]);
  });
  if (!rows[0]) throw new Fault(400,'invalid_group','请选择可用分组。');
  return { id:rows[0].id, name, prefix, secret };
}

const keyListQuery = `SELECT k.id,k.name,k.public_prefix AS prefix,k.status,g.id AS "groupId",g.name AS "groupName",
    k.rpm_limit AS rpm,k.spend_cap_micros::text AS "capMicros",k.spent_micros::text AS "spentMicros",k.held_micros::text AS "heldMicros"
    FROM gateway.api_keys k JOIN gateway.pricing_groups g ON g.id=k.group_id
    WHERE k.user_id=$1`;
const keyOrder = ' ORDER BY k.created_at DESC,k.id DESC';

export async function listKeys(user: string) {
  const { db } = await store();
  const { rows } = await db.query(keyListQuery+keyOrder,[user]);
  return rows;
}

export async function keyOptions(user:string) {
  const {db} = await store();
  const active = await db.query(`SELECT k.id,k.name,k.public_prefix AS prefix,g.id AS "groupId",g.name AS "groupName"
    FROM gateway.api_keys k JOIN gateway.pricing_groups g ON g.id=k.group_id WHERE k.user_id=$1 AND k.status='active'`+keyOrder,[user]);
  const groups = await db.query(`SELECT DISTINCT g.id,g.name FROM gateway.pricing_groups g
    JOIN gateway.api_keys k ON k.group_id=g.id WHERE k.user_id=$1 ORDER BY g.name,g.id`,[user]);
  return {active:active.rows,groups:groups.rows};
}

export async function keyPage(user:string,filter:{q?:string;status?:string;groupId?:string;cursor?:string;limit:number}) {
  const {db} = await store();
  const {rows} = await db.query(keyListQuery+`
    AND ($2::text IS NULL OR strpos(lower(k.name),lower($2))>0 OR strpos(lower(k.public_prefix),lower($2))=1)
    AND ($3::text IS NULL OR k.status=$3) AND ($4::uuid IS NULL OR k.group_id=$4)
    AND ($5::uuid IS NULL OR (k.created_at,k.id)<(SELECT created_at,id FROM gateway.api_keys WHERE user_id=$1 AND id=$5))`
    +keyOrder+' LIMIT $6',[user,filter.q,filter.status,filter.groupId,filter.cursor,filter.limit+1]);
  const items = rows.slice(0,filter.limit);
  return {items,nextCursor:rows.length>filter.limit ? items[items.length-1].id : null};
}

export async function editKey(user:string,id:string,edit:{name?:string;rpm?:number;capMicros?:string|null}) {
  await transaction(async tx=>{
    const {rows:[key]} = await tx.query<{minimum:string}>(`SELECT (spent_micros+held_micros)::text AS minimum
      FROM gateway.api_keys WHERE user_id=$1 AND id=$2 AND status<>'revoked' FOR UPDATE`,[user,id]);
    if (!key) throw new Fault(404,'key_not_found','找不到可操作的密钥。');
    if (edit.capMicros!=null && BigInt(edit.capMicros)<BigInt(key.minimum)) {
      throw new Fault(409,'key_cap_too_low','累计额度不能低于已消费金额与在途预占之和。');
    }
    await tx.query(`UPDATE gateway.api_keys SET name=coalesce($3,name),rpm_limit=coalesce($4,rpm_limit),
      spend_cap_micros=CASE WHEN $5 THEN $6::bigint ELSE spend_cap_micros END,updated_at=now()
      WHERE user_id=$1 AND id=$2`,[user,id,edit.name,edit.rpm,edit.capMicros!==undefined,edit.capMicros]);
  });
}

export async function updateKey(user: string, id: string, status: 'active' | 'disabled' | 'revoked') {
  const {rows}=await transaction(async tx=>{
    await tx.query('SELECT 1 FROM gateway.wallets WHERE user_id=$1 FOR UPDATE',[user]);
    if (status==='active') {
      const {rows:[key]}=await tx.query<{status:string}>("SELECT status FROM gateway.api_keys WHERE user_id=$1 AND id=$2",[user,id]);
      if (key?.status==='disabled') await requireKeySlot(tx,user);
    }
    return tx.query(`UPDATE gateway.api_keys SET status=$3,updated_at=now()
      WHERE user_id=$1 AND id=$2 AND (status<>'revoked' OR $3='revoked') RETURNING id`,[user,id,status]);
  });
  if (!rows.length) throw new Fault(404,'key_not_found','找不到可操作的密钥。');
}

async function requireKeySlot(tx:import('pg').PoolClient,user:string) {
  const {rows:[limit]}=await tx.query<{full:boolean}>(`SELECT active_keys<=(
    SELECT count(*) FROM gateway.api_keys WHERE user_id=$1 AND status='active') AS full
    FROM gateway.sandbox_billing_limits($1)`,[user]);
  if (limit?.full) throw new Fault(409,'plan_key_limit','已达到套餐的可用密钥上限。');
}

type Key = { id: string; user_id: string; group_id: string; status: string; rpm_limit: number;
  spend_cap_micros: string | null; spent_micros: string; held_micros: string };
const keyFields = 'id,user_id,group_id,status,rpm_limit,spend_cap_micros::text,spent_micros::text,held_micros::text';

async function findKey(header: string | null) {
  const token = /^Bearer (mg_[a-zA-Z0-9_-]{43})$/.exec(header || '')?.[1];
  if (token) {
    const { db } = await store();
    const { rows } = await db.query<Key>(`SELECT ${keyFields} FROM gateway.api_keys
      WHERE secret_digest=$1 AND gateway.account_access(user_id) IS NOT NULL`,
      [await digest('api-key',token)]);
    if (rows[0]?.status === 'active') return rows[0];
  }
  throw new Fault(401,'invalid_api_key','API 密钥无效或已停用。');
}

export async function models(header: string | null) {
  const key = await findKey(header);
  const { db } = await store();
  const { rows } = await db.query<Rate>(availableRateQuery + ' AND g.id=$2',[routeParameters(),key.group_id]);
  return { object:'list', data:rows.map(r => ({ id:r.model, object:'model', created:0,
    owned_by:r.model===mockModel ? 'opentoken-mock' : r.route_mode==='compatible' ? 'compatible' : 'openai' })) };
}

function price(rate: Rate, input: number, cache: number, output: number, multiplier: number) {
  const weighted = BigInt(input-cache)*BigInt(rate.input_rate) + BigInt(cache)*BigInt(rate.cache_rate) +
    BigInt(output)*BigInt(rate.output_rate);
  const denominator = 10_000_000_000n;
  return (weighted*BigInt(multiplier) + denominator-1n)/denominator;
}

async function prepareCompletion(header:string|null,body:CompletionInput,retry:string|null,streaming = false) {
  const key = await findKey(header);
  const { db } = await store();
  const fingerprint = retry ? (await digest('request-body',JSON.stringify(body))).toString('hex') : null;
  const providers = resolveLiveUpstreams();
  const credentials = channelCredentials();
  const started = Date.now();
  const { id, rate, hold, live } = await transaction(async tx => {
    await lockAccount(tx,key.user_id);
    if (body.model!==mockModel) await tx.query('SELECT pg_advisory_xact_lock_shared(961020032)');
    await tx.query('SELECT pg_advisory_xact_lock_shared($1)',[channelRoutingLock]);
    const { rows:[wallet] } = await tx.query<{available: string}>(`SELECT (balance_micros-held_micros-refund_held_micros)::text AS available
      FROM gateway.wallets WHERE user_id=$1 FOR UPDATE`,[key.user_id]);
    const { rows:[lockedKey] } = await tx.query<Key>(`SELECT ${keyFields} FROM gateway.api_keys
      WHERE id=$1 AND gateway.account_access(user_id) IS NOT NULL FOR UPDATE`,[key.id]);
    if (lockedKey?.status !== 'active') throw new Fault(401,'invalid_api_key','API 密钥已停用。');
    if (retry) {
      const { rows:[existing] } = await tx.query<{id:string;status:string;fingerprint:string}>(`SELECT id,status,encode(request_fingerprint,'hex') AS fingerprint
        FROM gateway.usage_requests WHERE key_id=$1 AND idempotency_key=$2`,[key.id,retry]);
      if (existing) throw new Fault(409,existing.fingerprint === fingerprint ? 'duplicate_request' : 'idempotency_conflict',
        existing.fingerprint === fingerprint ? `请求已受理（${existing.status}），请查看使用记录。` : '该幂等键已用于其他请求。',existing.id);
    }
    const { rows:[quote] } = await tx.query<Rate>(rateQuery + ' AND g.id=$2 AND m.code=$3',[routeParameters(providers,credentials),key.group_id,body.model]);
    if (!quote || body.max_completion_tokens > quote.max_output_tokens) {
      throw new Fault(400,'unsupported_model_or_limit','请选择可用模型，并将输出上限设为 1 至 128。');
    }
    const live = quote.channel_version_id ? managedUpstream(quote,credentials) : providers.find(provider=>provider.alias===body.model);
    if (streaming && quote.model!==mockModel && !live?.streaming) {
      throw new Fault(400,'stream_not_supported','当前模型只支持非流式调用。');
    }
    if (!quote.in_sync) throw new Fault(503,'seed_config_mismatch','兼容模型与种子费率不一致，请同步后再调用。');
    const assumedCached = BigInt(quote.cache_rate)>BigInt(quote.input_rate) ? quote.max_context_tokens : 0;
    const reserve = price(quote,quote.max_context_tokens,assumedCached,body.max_completion_tokens,quote.multiplier);
    if (BigInt(wallet.available) < reserve) throw new Fault(402,'insufficient_balance','可用余额不足以预留本次费用。');
    if (lockedKey.spend_cap_micros && BigInt(lockedKey.spent_micros)+BigInt(lockedKey.held_micros)+reserve > BigInt(lockedKey.spend_cap_micros)) {
      throw new Fault(402,'key_budget_exceeded','本次预占超过密钥的累计额度。');
    }
    const { rows:[recent] } = await tx.query<{count:number}>(`SELECT count(*)::int AS count FROM gateway.usage_requests
      WHERE key_id=$1 AND created_at>=now()-interval '60 seconds'`, [key.id]);
    if (recent.count >= lockedKey.rpm_limit) throw new Fault(429,'rate_limit','已达到该密钥每分钟请求上限。');
    const {rows:[tier]}=await tx.query<{full:boolean;key_allowed:boolean}>(`SELECT rpm<=(
      SELECT count(*) FROM gateway.usage_requests WHERE user_id=$1 AND created_at>=now()-interval '60 seconds') AS full,
      active_keys>(SELECT count(*) FROM gateway.api_keys k
        WHERE k.user_id=$1 AND k.status='active' AND (k.created_at,k.id)<(
          SELECT created_at,id FROM gateway.api_keys WHERE id=$2)) AS key_allowed
      FROM gateway.sandbox_billing_limits($1)`,[key.user_id,key.id]);
    if (tier && !tier.key_allowed) throw new Fault(403,'plan_key_limit','此密钥已超过当前套餐的可用密钥范围。');
    if (tier?.full) throw new Fault(429,'account_rate_limit','已达到账号每分钟请求上限。');
    const { rows:[entry] } = await tx.query<{id:string}>(`INSERT INTO gateway.usage_requests
      (user_id,key_id,group_id,model_id,rate_id,upstream_model_snapshot,idempotency_key,request_fingerprint,reserved_micros,status,updated_at,channel_version_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,decode($8,'hex'),$9,'dispatched',clock_timestamp(),$10) RETURNING id`,
      [key.user_id,key.id,key.group_id,quote.model_id,quote.rate_id,quote.upstream_model,retry,fingerprint,reserve.toString(),quote.channel_version_id]);
    await tx.query('UPDATE gateway.wallets SET held_micros=held_micros+$2,updated_at=now() WHERE user_id=$1',[key.user_id,reserve.toString()]);
    await tx.query('UPDATE gateway.api_keys SET held_micros=held_micros+$2,updated_at=now() WHERE id=$1',[key.id,reserve.toString()]);
    return { id:entry.id, rate:quote, hold:reserve, live };
  });

  return {key,db,live,started,id,rate,hold};
}

async function finishCompletion(
  {key,db,live,started,id,rate,hold}: Awaited<ReturnType<typeof prepareCompletion>>,
  body: CompletionInput,
  onDelta?: (delta:TextDelta) => void,
) {
  async function markReview(providerId: string | null, reason: string) {
    try {
      await db.query(`UPDATE gateway.usage_requests SET status='review',terminal_reason=$2,
        upstream_request_id=coalesce($3,upstream_request_id),updated_at=clock_timestamp()
        WHERE id=$1 AND (status='dispatched' OR (status='review' AND terminal_reason='dispatch_interrupted'))`,[id,reason,providerId]);
    } catch { console.error('Unable to record pending reconciliation',id); }
  }

  async function release(providerId: string | null) {
    await transaction(async tx => {
      await tx.query('SELECT 1 FROM gateway.wallets WHERE user_id=$1 FOR UPDATE',[key.user_id]);
      await tx.query('SELECT 1 FROM gateway.api_keys WHERE id=$1 FOR UPDATE',[key.id]);
      const { rowCount } = await tx.query(`UPDATE gateway.usage_requests SET status='released',terminal_reason='upstream_rejected',
        upstream_request_id=$2,finalized_at=now(),updated_at=now()
        WHERE id=$1 AND (status='dispatched' OR (status='review' AND terminal_reason='dispatch_interrupted'))
          AND NOT EXISTS (SELECT 1 FROM gateway.wallet_entries WHERE request_id=$1)`,[id,providerId]);
      if (!rowCount) throw new Error('Request was already resolved');
      await tx.query('UPDATE gateway.wallets SET held_micros=held_micros-$2,updated_at=now() WHERE user_id=$1',[key.user_id,hold.toString()]);
      await tx.query('UPDATE gateway.api_keys SET held_micros=held_micros-$2,updated_at=now() WHERE id=$1',[key.id,hold.toString()]);
    });
  }

  let result: Awaited<ReturnType<typeof openAiCompletion>>;
  try {
    if (rate.model===mockModel) {
      result = await mockCompletion(body,onDelta && (content => onDelta({content})));
    } else {
      result = onDelta ? await openAiStream(body,live!,onDelta) : await openAiCompletion(body,live!);
    }
  } catch (error) {
    const providerId = error instanceof UpstreamError ? error.requestId : null;
    if (error instanceof UpstreamError && error.disposition==='release') {
      try { await release(providerId); }
      catch {
        await markReview(providerId,'release_uncertain');
        throw new Fault(503,'billing_review','费用待核对，请按请求编号查看记录。',id);
      }
      throw new Fault(502,'upstream_rejected',error.message,id);
    }
    await markReview(providerId,'upstream_uncertain');
    throw new Fault(503,'billing_review','费用待核对，请按请求编号查看记录。',id);
  }
  const {input,cached,output} = result.tokens;
  const standard = price(rate,input,cached,output,10_000);
  const charged = price(rate,input,cached,output,rate.multiplier);
  if (charged>hold || input>rate.max_context_tokens || output>body.max_completion_tokens) {
    await markReview(result.requestId,'usage_outside_quote');
    throw new Fault(503,'billing_review','费用待核对，请按请求编号查看记录。',id);
  }
  try {
    await transaction(async tx => {
      await tx.query('SELECT 1 FROM gateway.wallets WHERE user_id=$1 FOR UPDATE',[key.user_id]);
      await tx.query('SELECT 1 FROM gateway.api_keys WHERE id=$1 FOR UPDATE',[key.id]);
      const { rowCount } = await tx.query(`UPDATE gateway.usage_requests SET status='settled',input_tokens=$2,cached_input_tokens=$3,output_tokens=$4,
        standard_micros=$5,charged_micros=$6,duration_ms=$7,upstream_request_id=$8,terminal_reason=NULL,finalized_at=now(),updated_at=now()
        WHERE id=$1 AND (status='dispatched' OR (status='review' AND terminal_reason='dispatch_interrupted'))`,
        [id,input,cached,output,standard.toString(),charged.toString(),Date.now()-started,result.requestId]);
      if (!rowCount) throw new Error('Request cannot be settled from its current status');
      await tx.query("INSERT INTO gateway.wallet_entries (user_id,request_id,kind,delta_micros) VALUES ($1,$2,'usage',$3)",
        [key.user_id,id,(-charged).toString()]);
      await tx.query('UPDATE gateway.wallets SET balance_micros=balance_micros-$2,held_micros=held_micros-$3,updated_at=now() WHERE user_id=$1',
        [key.user_id,charged.toString(),hold.toString()]);
      await tx.query('UPDATE gateway.api_keys SET spent_micros=spent_micros+$2,held_micros=held_micros-$3,updated_at=now() WHERE id=$1',
        [key.id,charged.toString(),hold.toString()]);
    });
  } catch {
    await markReview(result.requestId,'settlement_uncertain');
    throw new Fault(503,'billing_review','费用待核对，请按请求编号查看记录。',id);
  }
  return {
    id, object:'chat.completion', created:Math.floor(started/1000), model:body.model,
    choices:result.choices,
    usage:{ prompt_tokens:input, completion_tokens:output, total_tokens:input+output, prompt_tokens_details:{cached_tokens:cached} },
  };
}

export async function complete(header:string|null,body:CompletionInput,retry:string|null) {
  return finishCompletion(await prepareCompletion(header,body,retry),body);
}

export async function streamCompletion(header:string|null,body:CompletionInput,retry:string|null,includeUsage = false) {
  const prepared = await prepareCompletion(header,body,retry,true);
  const id = prepared.id;
  const metadata = {id,object:'chat.completion.chunk',created:Math.floor(prepared.started/1000),model:body.model};
  const encoder = new TextEncoder();
  let disconnected = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      function send(data: unknown) {
        if (disconnected) return;
        const payload = data==='[DONE]' ? data : JSON.stringify(data);
        controller.enqueue(encoder.encode('data: '+payload+'\n\n'));
      }
      function sendChoice(delta: TextDelta & {role?:'assistant'}, finishReason: string|null = null) {
        send({...metadata,choices:[{index:0,delta,finish_reason:finishReason}],...(includeUsage ? {usage:null} : {})});
      }
      // Transport cancellation detaches the client while the gateway finishes accounting.
      after((async () => {
        try {
          sendChoice({role:'assistant'});
          const result = await finishCompletion(prepared,body,delta => sendChoice(delta));
          sendChoice({},result.choices[0].finish_reason);
          if (includeUsage) send({...metadata,choices:[],usage:result.usage});
          send('[DONE]');
        } catch (error) {
          send({error:{code:error instanceof Fault ? error.code : 'billing_review',
            message:error instanceof Fault ? error.message : '费用待核对，请按请求编号查看记录。',request_id:id}});
        } finally {
          if (!disconnected) controller.close();
        }
      })());
    },
    cancel() { disconnected = true; },
  });
  return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8',
    'Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no','X-Request-Id':id}});
}
