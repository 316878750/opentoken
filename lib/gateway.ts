import { randomBytes } from 'node:crypto';
import { after } from 'next/server';
import { digest, store, transaction } from './data';
import { mockCompletion, mockModel, openAiCompletion, UpstreamError, type CompletionInput } from './upstream';
import { resolveLiveUpstream } from './upstream-config.mjs';

export class Fault extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) { super(message); }
}

type Rate = {
  rate_id: string; model_id: string; group_id: string; model: string; upstream_model: string;
  max_context_tokens: number; max_output_tokens: number; input_rate: string; cache_rate: string;
  output_rate: string; multiplier: number; group_name: string;
};

const rateQuery = `SELECT r.id AS rate_id, m.id AS model_id, g.id AS group_id, m.code AS model,
  m.upstream_model, m.max_context_tokens, m.max_output_tokens, g.name AS group_name,
  r.input_micros_per_mtok::text AS input_rate, r.cached_input_micros_per_mtok::text AS cache_rate,
  r.output_micros_per_mtok::text AS output_rate, r.multiplier_bps AS multiplier
  FROM gateway.model_rates r JOIN gateway.models m ON m.id=r.model_id JOIN gateway.pricing_groups g ON g.id=r.group_id
  WHERE r.closed_at IS NULL AND m.enabled AND g.enabled
    AND ((m.code='${mockModel}' AND m.upstream_model='${mockModel}') OR (m.code=$1 AND m.upstream_model=$2))`;

export async function catalog() {
  const { db } = await store();
  const live = resolveLiveUpstream();
  const { rows } = await db.query<Rate>(rateQuery,[live?.alias ?? null,live?.model ?? null]);
  return rows.map(r => ({ groupId:r.group_id, groupName:r.group_name, model:r.model, inputMicros:r.input_rate,
    cacheMicros:r.cache_rate, outputMicros:r.output_rate, multiplierBps:r.multiplier,
    maxContextTokens:r.max_context_tokens,maxOutputTokens:r.max_output_tokens,
    upstream:r.model===mockModel ? 'mock' : live?.mode==='compatible' ? 'compatible' : 'openai' }));
}

export async function createKey(user: string, name: string, groupId: string, rpm: number, cap: string | null) {
  const { db } = await store();
  const secret = 'mg_' + randomBytes(32).toString('base64url');
  const prefix = secret.slice(0, 12);
  const { rows } = await db.query<{id: string}>(`INSERT INTO gateway.api_keys (user_id,group_id,name,public_prefix,secret_digest,rpm_limit,spend_cap_micros)
    SELECT $1,id,$2,$3,$4,$5,$6 FROM gateway.pricing_groups WHERE id=$7 AND enabled RETURNING id`,
    [user,name,prefix,await digest('api-key',secret),rpm,cap,groupId]);
  if (!rows[0]) throw new Fault(400,'invalid_group','请选择可用分组。');
  return { id:rows[0].id, name, prefix, secret };
}

export async function listKeys(user: string) {
  const { db } = await store();
  const { rows } = await db.query(`SELECT k.id,k.name,k.public_prefix AS prefix,k.status,g.name AS "groupName",
    k.rpm_limit AS rpm,k.spend_cap_micros::text AS "capMicros"
    FROM gateway.api_keys k JOIN gateway.pricing_groups g ON g.id=k.group_id
    WHERE k.user_id=$1 ORDER BY k.created_at DESC,k.id DESC`,[user]);
  return rows;
}

export async function updateKey(user: string, id: string, status: 'active' | 'disabled' | 'revoked') {
  const { db } = await store();
  const { rows } = await db.query(`UPDATE gateway.api_keys SET status=$3,updated_at=now()
    WHERE user_id=$1 AND id=$2 AND (status<>'revoked' OR $3='revoked') RETURNING id`,[user,id,status]);
  if (!rows.length) throw new Fault(404,'key_not_found','找不到可操作的密钥。');
}

type Key = { id: string; user_id: string; group_id: string; status: string; rpm_limit: number;
  spend_cap_micros: string | null; spent_micros: string; held_micros: string };
const keyFields = 'id,user_id,group_id,status,rpm_limit,spend_cap_micros::text,spent_micros::text,held_micros::text';

async function findKey(header: string | null) {
  const token = /^Bearer (mg_[a-zA-Z0-9_-]{43})$/.exec(header || '')?.[1];
  if (token) {
    const { db } = await store();
    const { rows } = await db.query<Key>(`SELECT ${keyFields} FROM gateway.api_keys WHERE secret_digest=$1`,
      [await digest('api-key',token)]);
    if (rows[0]?.status === 'active') return rows[0];
  }
  throw new Fault(401,'invalid_api_key','API 密钥无效或已停用。');
}

export async function models(header: string | null) {
  const key = await findKey(header);
  const { db } = await store();
  const live = resolveLiveUpstream();
  const { rows } = await db.query<Rate>(rateQuery + ' AND g.id=$3',[live?.alias ?? null,live?.model ?? null,key.group_id]);
  return { object:'list', data:rows.map(r => ({ id:r.model, object:'model', created:0,
    owned_by:r.model===mockModel ? 'opentoken-mock' : live?.mode==='compatible' ? 'compatible' : 'openai' })) };
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
  const live = resolveLiveUpstream();
  const started = Date.now();
  const { id, rate, hold } = await transaction(async tx => {
    const { rows:[wallet] } = await tx.query<{available: string}>(`SELECT (balance_micros-held_micros)::text AS available
      FROM gateway.wallets WHERE user_id=$1 FOR UPDATE`,[key.user_id]);
    const { rows:[lockedKey] } = await tx.query<Key>(`SELECT ${keyFields} FROM gateway.api_keys WHERE id=$1 FOR UPDATE`,[key.id]);
    if (lockedKey.status !== 'active') throw new Fault(401,'invalid_api_key','API 密钥已停用。');
    if (retry) {
      const { rows:[existing] } = await tx.query<{id:string;status:string;fingerprint:string}>(`SELECT id,status,encode(request_fingerprint,'hex') AS fingerprint
        FROM gateway.usage_requests WHERE key_id=$1 AND idempotency_key=$2`,[key.id,retry]);
      if (existing) throw new Fault(409,existing.fingerprint === fingerprint ? 'duplicate_request' : 'idempotency_conflict',
        existing.fingerprint === fingerprint ? `请求已受理（${existing.status}），请查看使用记录。` : '该幂等键已用于其他请求。',existing.id);
    }
    const { rows:[quote] } = await tx.query<Rate>(rateQuery + ' AND g.id=$3 AND m.code=$4',[live?.alias ?? null,live?.model ?? null,key.group_id,body.model]);
    if (!quote || body.max_completion_tokens > quote.max_output_tokens) {
      throw new Fault(400,'unsupported_model_or_limit','请选择可用模型，并将输出上限设为 1 至 128。');
    }
    if (streaming && quote.model!==mockModel) {
      throw new Fault(400,'stream_not_supported','当前模型只支持非流式调用。');
    }
    if (quote.model!==mockModel && live?.mode==='compatible' && (
      quote.max_context_tokens!==live.maxContextTokens || quote.max_output_tokens!==live.maxOutputTokens ||
      quote.input_rate!==live.inputMicros || quote.cache_rate!==live.cacheMicros || quote.output_rate!==live.outputMicros ||
      quote.multiplier!==10000
    )) throw new Fault(503,'seed_config_mismatch','兼容模型与种子费率不一致，请同步后再调用。');
    const assumedCached = BigInt(quote.cache_rate)>BigInt(quote.input_rate) ? quote.max_context_tokens : 0;
    const reserve = price(quote,quote.max_context_tokens,assumedCached,body.max_completion_tokens,quote.multiplier);
    if (BigInt(wallet.available) < reserve) throw new Fault(402,'insufficient_balance','可用余额不足以预留本次费用。');
    if (lockedKey.spend_cap_micros && BigInt(lockedKey.spent_micros)+BigInt(lockedKey.held_micros)+reserve > BigInt(lockedKey.spend_cap_micros)) {
      throw new Fault(402,'key_budget_exceeded','本次预占超过密钥的累计额度。');
    }
    const { rows:[recent] } = await tx.query<{count:number}>(`SELECT count(*)::int AS count FROM gateway.usage_requests
      WHERE key_id=$1 AND created_at>=now()-interval '60 seconds'`, [key.id]);
    if (recent.count >= lockedKey.rpm_limit) throw new Fault(429,'rate_limit','已达到该密钥每分钟请求上限。');
    const { rows:[entry] } = await tx.query<{id:string}>(`INSERT INTO gateway.usage_requests
      (user_id,key_id,group_id,model_id,rate_id,upstream_model_snapshot,idempotency_key,request_fingerprint,reserved_micros,status,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,decode($8,'hex'),$9,'dispatched',clock_timestamp()) RETURNING id`,
      [key.user_id,key.id,key.group_id,quote.model_id,quote.rate_id,quote.upstream_model,retry,fingerprint,reserve.toString()]);
    await tx.query('UPDATE gateway.wallets SET held_micros=held_micros+$2,updated_at=now() WHERE user_id=$1',[key.user_id,reserve.toString()]);
    await tx.query('UPDATE gateway.api_keys SET held_micros=held_micros+$2,updated_at=now() WHERE id=$1',[key.id,reserve.toString()]);
    return { id:entry.id, rate:quote, hold:reserve };
  });

  return {key,db,live,started,id,rate,hold};
}

async function finishCompletion(
  {key,db,live,started,id,rate,hold}: Awaited<ReturnType<typeof prepareCompletion>>,
  body: CompletionInput,
  onText?: (content:string) => void,
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
    result = rate.model===mockModel ? await mockCompletion(body,onText) : await openAiCompletion(body,live!);
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
      function sendChoice(delta: {role?:'assistant';content?:string}, finishReason: string|null = null) {
        send({...metadata,choices:[{index:0,delta,finish_reason:finishReason}],...(includeUsage ? {usage:null} : {})});
      }
      // Transport cancellation detaches the client while the gateway finishes accounting.
      after((async () => {
        try {
          sendChoice({role:'assistant'});
          const result = await finishCompletion(prepared,body,content => sendChoice({content}));
          sendChoice({},result.choices[0].finish_reason);
          if (includeUsage) send({...metadata,choices:[],usage:result.usage});
          send('[DONE]');
        } catch (error) {
          send({error:{code:error instanceof Fault ? error.code : 'billing_review',
            message:'费用待核对，请按请求编号查看记录。',request_id:id}});
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
