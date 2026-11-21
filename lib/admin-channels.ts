import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import * as z from 'zod';
import { adminRole } from './admin';
import { channelCredentials, channelRoutingLock, type ChannelCredential } from './channel-credentials';
import { store, transaction } from './data';
import { Fault } from './gateway';
import { openAiCompletion, openAiStream, UpstreamError, mockModel } from './upstream';
import { resolveLiveUpstreams, type LiveUpstream } from './upstream-config.mjs';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const upstreamId = z.string().regex(/^[A-Za-z0-9][\w./:@-]{0,127}$/);
const probeModel = z.strictObject({upstreamModel:upstreamId,responseModel:upstreamId.optional(),streaming:z.boolean(),
  tokenField:z.enum(['max_tokens','max_completion_tokens'])});
const binding = probeModel.extend({model:slug,group:slug});
const policy = z.strictObject({priority:z.int().min(0).max(1000),weight:z.int().min(1).max(100),automaticFailover:z.boolean(),
  standbyChannelId:z.uuid().optional(),failoverThreshold:z.int().min(1).max(20).optional(),
  failoverCooldownSeconds:z.int().min(10).max(3600).optional(),autoPublishModels:z.array(upstreamId).max(20),
  autoPublishGroup:slug.optional(),discoveryIntervalMinutes:z.int().min(5).max(1440).optional()});
export const channelDraftInput = z.strictObject({name:z.string().trim().min(1).max(80),
  credentialRef:z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),bindings:z.array(binding).max(20),testModel:probeModel.optional(),
  policy,notes:z.string().trim().max(300).optional()});
export const channelProbeInput = z.strictObject({versionId:z.uuid(),binding:z.int().min(-1).max(19)});
const reasonSchema = z.string().trim().min(3).max(160);
export const channelPublishInput = z.strictObject({versionId:z.uuid(),reason:reasonSchema});
export const channelDisableInput = z.strictObject({reason:reasonSchema});

type Draft = z.infer<typeof channelDraftInput>;
type Config = Omit<Draft,'name'|'credentialRef'>;
type Binding = z.infer<typeof binding>;
type Version = {id:string;channel_id:string;name:string;credential_ref:string;credential_fingerprint:string;
  adapter:ChannelCredential['type'];config:Config;published_at:string|null};
type Channel = {id:string;draft_version_id:string;active_version_id:string|null;enabled:boolean};
type Probe = {binding:number;status:string;elapsedMs:number|null};
type Action = 'create'|'edit'|'probe_started'|'probe_finished'|'enable'|'disable'|'rollback';
type PricedBinding = {model_id:string;group_id:string;idx:number;rate_id:string;input_rate:string;cache_rate:string;
  output_rate:string;max_output_tokens:number};

async function requireAdmin(tx:PoolClient,userId:string) {
  const {rows:[row]} = await tx.query<{allowed:boolean}>("SELECT gateway.admin_role_for($1)='system_admin' AS allowed",[userId]);
  if (!row.allowed) throw new Fault(403,'channel_forbidden','当前账号没有渠道管理权限。');
}

async function audit(tx:PoolClient,userId:string,requestId:string,action:Action,reason:string,details:object,outcome='success') {
  await tx.query('SELECT gateway.audit_channel($1,$2,$3,$4,$5,$6)',[userId,requestId,'channel.'+action,outcome,reason,JSON.stringify(details)]);
}

function effectiveCredential(version:Version) {
  const credential = channelCredentials().find(item=>item.ref===version.credential_ref && item.fingerprint===version.credential_fingerprint);
  if (!credential) throw new Fault(409,'channel_credential_changed','原密钥引用已缺失、撤销或变更，请建立新版本。');
  return credential;
}

async function getChannel(tx:PoolClient,id:string) {
  const {rows:[channel]} = await tx.query<Channel>('SELECT * FROM gateway.channels WHERE id=$1 FOR UPDATE',[id]);
  if (!channel) throw new Fault(404,'channel_not_found','渠道不存在。');
  return channel;
}

async function getVersion(tx:PoolClient,channelId:string,id:string) {
  const {rows:[version]} = await tx.query<Version>('SELECT * FROM gateway.channel_versions WHERE channel_id=$1 AND id=$2',[channelId,id]);
  if (!version) throw new Fault(404,'channel_version_not_found','渠道版本不存在。');
  return version;
}

const latestProbes = `SELECT DISTINCT ON (binding) binding,status,rate_id FROM gateway.channel_probes
  WHERE version_id=$1 ORDER BY binding,started_at DESC,id DESC`;

async function resolveBindings(tx:PoolClient,bindings:Binding[]) {
  const {rows} = await tx.query<PricedBinding>(`SELECT m.id AS model_id,g.id AS group_id,b.ordinality::int-1 AS idx,r.id AS rate_id,
    r.input_micros_per_mtok::text AS input_rate,r.cached_input_micros_per_mtok::text AS cache_rate,
    r.output_micros_per_mtok::text AS output_rate,m.max_output_tokens
    FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS b(value,ordinality)
    JOIN gateway.models m ON m.code=(b.value->>'model')
    JOIN gateway.pricing_groups g ON g.code=(b.value->>'group')
    JOIN gateway.model_rates r ON r.model_id=m.id AND r.group_id=g.id AND r.closed_at IS NULL
    ORDER BY b.ordinality`,[JSON.stringify(bindings)]);
  if (rows.length!==bindings.length) throw new Fault(409,'channel_binding_unpriced','请先配置模型、分组和对应费率。');
  return rows;
}

async function validatePolicy(tx:PoolClient,channelId:string,config:Config) {
  const {bindings,policy:spec} = config;
  if (spec.standbyChannelId===channelId || (spec.automaticFailover && !spec.standbyChannelId)) {
    throw new Fault(400,'channel_standby_required','请选择其他渠道作为自动切换的候选。');
  }
  if (spec.standbyChannelId) {
    const { rows:[standby] } = await tx.query<{config:Config}>(`SELECT v.config FROM gateway.channels c
      JOIN gateway.channel_versions v ON v.id=coalesce(CASE WHEN c.enabled THEN c.active_version_id END,c.draft_version_id)
      WHERE c.id=$1`,[spec.standbyChannelId]);
    if (!standby || (spec.automaticFailover && (!bindings.length || bindings.some(item=>!standby.config.bindings.some(
      candidate=>candidate.model===item.model && candidate.group===item.group && (!item.streaming || candidate.streaming)))))) {
      throw new Fault(409,'channel_standby_unmapped','候选渠道必须覆盖相同模型、分组和流式能力。');
    }
  }
  if (new Set(spec.autoPublishModels).size!==spec.autoPublishModels.length ||
      spec.autoPublishModels.some(model=>!bindings.some(item=>item.group===spec.autoPublishGroup && item.upstreamModel===model))) {
    throw new Fault(400,'channel_auto_publish_unmapped','自动上线清单只能包含指定分组内已手工绑定并定价的上游模型。');
  }
}

function rejectSecretText(text:string) {
  if (channelCredentials().some(key=>key.apiKey && text.includes(key.apiKey))) {
    throw new Fault(400,'channel_secret_in_text','请勿在渠道信息或变更原因填入密钥。');
  }
}

export async function saveChannel(userId:string,draft:Draft,id?:string) {
  const requestId = randomUUID();
  const channelId = id ?? randomUUID();
  const {name,credentialRef,...config} = draft;
  return transaction(async tx=>{
    await requireAdmin(tx,userId);
    rejectSecretText([name,config.notes??'',JSON.stringify(draft)].join('\n'));
    const credential = channelCredentials().find(entry=>entry.ref===credentialRef && entry.fingerprint);
    if (!credential) throw new Fault(400,'channel_credential_missing','请选择服务端已登记且可用的密钥引用。');
    if (config.bindings.some(item=>item.model===mockModel) || new Set(config.bindings.map(item=>item.model+' '+item.group)).size!==config.bindings.length) {
      throw new Fault(400,'channel_binding_duplicate','同一个模型与分组只能绑定一次，模拟模型由系统管理。');
    }
    // Lock ordering is consistent with enable/disable. Policy checks see committed drafts of other channels.
    await tx.query('SELECT pg_advisory_xact_lock($1)',[channelRoutingLock]);
    const previous = id ? await getChannel(tx,id) : null;
    await resolveBindings(tx,config.bindings);
    await validatePolicy(tx,channelId,config);
    if (!previous) await tx.query('INSERT INTO gateway.channels(id) VALUES ($1)',[channelId]);
    const {rows:[{id:versionId}]} = await tx.query<{id:string}>(`INSERT INTO gateway.channel_versions
      (channel_id,name,credential_ref,credential_fingerprint,adapter,config) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [channelId,name,credentialRef,credential.fingerprint,credential.type,JSON.stringify(config)]);
    await tx.query('UPDATE gateway.channels SET draft_version_id=$2 WHERE id=$1',[channelId,versionId]);
    await audit(tx,userId,requestId,id?'edit':'create','draft_saved',{channelId,versionId,previousDraft:previous?.draft_version_id??null});
    return {id:channelId,versionId,requestId};
  });
}

export async function listChannels(userId:string) {
  const role = await adminRole(userId);
  if (role!=='system_admin' && role!=='operator') throw new Fault(403,'channel_forbidden','当前账号没有渠道查看权限。');
  const canWrite = role==='system_admin';
  const {db} = await store();
  const registry = channelCredentials();
  const {rows} = await db.query<Channel & {versions:(Version & {probes:Probe[]})[]}>(`SELECT c.*,coalesce((SELECT jsonb_agg(v) FROM (
    SELECT v.*,coalesce((SELECT jsonb_agg(p) FROM (SELECT DISTINCT ON (binding) binding,status,elapsed_ms AS "elapsedMs"
      FROM gateway.channel_probes WHERE version_id=v.id ORDER BY binding,started_at DESC,id DESC) p),'[]'::jsonb) AS probes
    FROM gateway.channel_versions v WHERE v.channel_id=c.id AND (v.id=c.draft_version_id OR v.published_at IS NOT NULL)
    ORDER BY (v.id=c.draft_version_id OR v.id=c.active_version_id) DESC,v.created_at DESC LIMIT 21) v),'[]'::jsonb) AS versions
    FROM gateway.channels c ORDER BY c.created_at DESC,c.id DESC`);
  const summarize = (version:Version & {probes:Probe[]})=>{
    const common = {id:version.id,name:version.name,type:version.adapter,publishedAt:version.published_at,probes:version.probes};
    const credential = registry.find(item=>item.ref===version.credential_ref && item.fingerprint===version.credential_fingerprint);
    if (!canWrite) return {...common,bindings:version.config.bindings.map(({model,group})=>({model,group}))};
    return {...common,...version.config,credentialRef:version.credential_ref,credentialAvailable:!!credential,endpoint:credential?.endpoint??null};
  };
  const items = rows.map(channel=>{
    const versions = channel.versions.map(summarize);
    return {id:channel.id,enabled:channel.enabled,active:versions.find(version=>version.id===channel.active_version_id)??null,
      draft:versions.find(version=>version.id===channel.draft_version_id)??null,
      history:canWrite ? versions.filter(version=>version.publishedAt) : []};
  });
  if (!canWrite) return {items,canWrite};
  const {rows:pairs} = await db.query<{model:string;group:string;managed:boolean;upstreamModel:string;context:number;output:number;
    inputRate:string;cacheRate:string;outputRate:string;multiplier:number}>(`SELECT m.code AS model,g.code AS "group",
    managed.model_id IS NOT NULL AS managed,m.upstream_model AS "upstreamModel",m.max_context_tokens AS context,m.max_output_tokens AS output,
    r.input_micros_per_mtok::text AS "inputRate",r.cached_input_micros_per_mtok::text AS "cacheRate",
    r.output_micros_per_mtok::text AS "outputRate",r.multiplier_bps AS multiplier
    FROM gateway.model_rates r JOIN gateway.models m ON m.id=r.model_id JOIN gateway.pricing_groups g ON g.id=r.group_id
    LEFT JOIN gateway.channel_runtime_routes managed ON managed.model_id=m.id AND managed.group_id=g.id
    WHERE r.closed_at IS NULL AND m.code<>$1 ORDER BY m.code,g.code`,[mockModel]);
  const legacy = resolveLiveUpstreams().flatMap(provider=>provider.groups.map(group=>{
    const stored = pairs.find(pair=>pair.model===provider.alias && pair.group===group.code);
    const matches = stored && stored.upstreamModel===provider.model && stored.context===provider.maxContextTokens &&
      stored.output===provider.maxOutputTokens && stored.inputRate===provider.inputMicros && stored.cacheRate===provider.cacheMicros &&
      stored.outputRate===provider.outputMicros && stored.multiplier===group.multiplierBps;
    return {model:provider.alias,group:group.code,status:stored?.managed?'managed':matches?'ready':'mismatch',
      credentialRegistered:registry.some(entry=>entry.endpoint===provider.endpoint && entry.apiKey===provider.apiKey)};
  }));
  const options = pairs.map(({model,group})=>({model,group}));
  return {items,canWrite,options,credentials:registry.map(({ref,type,endpoint,fingerprint})=>({ref,type,endpoint,available:!!fingerprint})),
    legacy,policyExecution:'single_route'};
}

export async function probeChannel(userId:string,channelId:string,{versionId,binding:index}:z.infer<typeof channelProbeInput>) {
  const probeId = randomUUID();
  const {candidate,credential,price} = await transaction(async tx=>{
    await requireAdmin(tx,userId);
    await tx.query('SELECT pg_advisory_xact_lock_shared(961020032)');
    const sandbox = await tx.query('SELECT 1 FROM gateway.stripe_sandbox WHERE enabled');
    if (sandbox.rowCount || process.env.ENABLE_OPENAI!=='1') throw new Fault(409,'channel_probe_disabled','当前环境已关闭真实上游请求。');
    const version = await getVersion(tx,channelId,versionId);
    const credential = effectiveCredential(version);
    const candidate = index===-1 ? version.config.testModel : version.config.bindings[index];
    if (!candidate) throw new Fault(400,'channel_probe_model_missing','请选择该版本中的测试模型。');
    if (candidate.streaming && process.env.ENABLE_UPSTREAM_STREAMING!=='1') {
      throw new Fault(409,'channel_stream_disabled','当前环境已关闭流式上游请求。');
    }
    const [price] = index<0 ? [] : await resolveBindings(tx,[version.config.bindings[index]]);
    await tx.query(`UPDATE gateway.channel_probes SET status='unverified',finished_at=clock_timestamp()
      WHERE version_id=$1 AND binding=$2 AND status='pending' AND started_at<clock_timestamp()-interval '75 seconds'`,[versionId,index]);
    const {rowCount} = await tx.query(`INSERT INTO gateway.channel_probes(id,version_id,binding,rate_id,status)
      VALUES ($1,$2,$3,$4,'pending') ON CONFLICT DO NOTHING`,[probeId,versionId,index,price?.rate_id??null]);
    if (!rowCount) throw new Fault(409,'channel_probe_pending','该模型已有未完成的测试。');
    await audit(tx,userId,probeId,'probe_started','test_started',{channelId,versionId,probeId,binding:index});
    return {candidate,credential,price};
  });

  const maxTokens = Math.min(price?.max_output_tokens??8,8);
  const upstream:LiveUpstream = {mode:credential.type,endpoint:credential.endpoint,apiKey:credential.apiKey,
    model:candidate.upstreamModel,responseModel:candidate.responseModel??candidate.upstreamModel,tokenField:candidate.tokenField,
    streaming:candidate.streaming,alias:candidate.upstreamModel,groups:[],maxContextTokens:128,maxOutputTokens:maxTokens,
    inputMicros:price?.input_rate??'0',cacheMicros:price?.cache_rate??'0',outputMicros:price?.output_rate??'0'};
  const input = {model:candidate.upstreamModel,messages:[{role:'user',content:'Reply OK.'}],max_completion_tokens:maxTokens};
  const started = Date.now();
  let status = 'passed';
  let cacheVerified = false;
  try {
    const completion = await openAiCompletion(input,upstream);
    const streamed = candidate.streaming ? await openAiStream(input,upstream,()=>{}) : null;
    cacheVerified = completion.cacheReported && (!streamed || streamed.cacheReported);
  } catch (error) {
    status = error instanceof UpstreamError ? error.category : 'unverified';
  }
  const elapsedMs = Date.now()-started;
  const requestId = randomUUID();
  await transaction(async tx=>{
    const updated = await tx.query(`UPDATE gateway.channel_probes SET status=$2,elapsed_ms=$3,finished_at=clock_timestamp(),cache_usage_verified=$4
      WHERE id=$1 AND status='pending'`,[probeId,status,elapsedMs,cacheVerified]);
    if (!updated.rowCount) throw new Fault(409,'channel_probe_finished','测试结果已失效，请查询最新状态。');
    await audit(tx,userId,requestId,'probe_finished',status,{channelId,versionId,probeId,binding:index,elapsedMs},status==='passed'?'success':'denied');
  });
  return {probeId,status,elapsedMs,requestId};
}

export async function changeChannel(userId:string,channelId:string,action:'enable'|'disable'|'rollback',reason:string,
  versionId?:string,recent=false) {
  const requestId = randomUUID();
  return transaction(async tx=>{
    await requireAdmin(tx,userId);
    if (action!=='disable') {
      if (!recent) throw new Fault(403,'admin_recent_auth_required','请重新登录后再发布或回退渠道。');
      await tx.query('SELECT pg_advisory_xact_lock_shared(961020032)');
      const sandbox = await tx.query('SELECT 1 FROM gateway.stripe_sandbox WHERE enabled');
      if (sandbox.rowCount || process.env.ENABLE_OPENAI!=='1') throw new Fault(409,'channel_publish_disabled','当前环境已关闭真实上游请求。');
    }
    rejectSecretText(reason);
    await tx.query('SELECT pg_advisory_xact_lock($1)',[channelRoutingLock]);
    const channel = await getChannel(tx,channelId);
    if (action==='disable') {
      await tx.query('UPDATE gateway.channels SET enabled=false WHERE id=$1',[channelId]);
      await audit(tx,userId,requestId,action,reason,{channelId,versionId:channel.active_version_id,before:channel.enabled,after:false});
      return {id:channelId,enabled:false,requestId};
    }

    const version = await getVersion(tx,channelId,versionId!);
    if (action==='enable' && version.id!==channel.draft_version_id && (channel.enabled || version.id!==channel.active_version_id)) {
      throw new Fault(409,'channel_stale_draft','该草稿已被替换，请刷新后操作。');
    }
    if (action==='rollback' && (!channel.enabled || !version.published_at)) {
      throw new Fault(409,'channel_rollback_unavailable','仅能对启用的渠道回退到已发布版本。');
    }
    if (!version.config.bindings.length) throw new Fault(409,'channel_binding_required','至少绑定一个模型与分组。');
    effectiveCredential(version);
    await validatePolicy(tx,channelId,version.config);
    const resolved = await resolveBindings(tx,version.config.bindings);
    const {rows:probes} = await tx.query<{binding:number;status:string;rate_id:string|null}>(latestProbes,[version.id]);
    if (resolved.some((item,index)=>!probes.some(probe=>probe.binding===index && probe.status==='passed' && probe.rate_id===item.rate_id))) {
      throw new Fault(409,'channel_probe_required','请完成该版本所有模型绑定的连接测试。');
    }
    const routes = resolved.map(({model_id,group_id,idx})=>{
      const item = version.config.bindings[idx];
      return {model_id,group_id,upstream_model:item.upstreamModel,response_model:item.responseModel??item.upstreamModel,
        streaming:item.streaming,token_field:item.tokenField};
    });
    const records = `jsonb_to_recordset($1::jsonb) AS p(model_id uuid,group_id uuid,upstream_model text,
      response_model text,streaming boolean,token_field text)`;
    const input = JSON.stringify(routes);
    const {rowCount:conflicts} = await tx.query(`SELECT 1 FROM ${records}
      JOIN gateway.channel_runtime_routes r USING (model_id,group_id) WHERE r.effective AND r.channel_id<>$2 LIMIT 1`,[input,channelId]);
    if (conflicts) throw new Fault(409,'channel_route_conflict','已有其他启用渠道服务此模型和分组，请先停用原渠道。');
    await tx.query('UPDATE gateway.channel_routes SET current_binding=false WHERE channel_id=$1',[channelId]);
    await tx.query(`INSERT INTO gateway.channel_routes (model_id,group_id,channel_id,version_id,current_binding,upstream_model,response_model,streaming,token_field)
      SELECT p.model_id,p.group_id,$2,$3,true,p.upstream_model,p.response_model,p.streaming,p.token_field FROM ${records}
      ON CONFLICT (model_id,group_id) DO UPDATE SET channel_id=excluded.channel_id,version_id=excluded.version_id,
        current_binding=true,upstream_model=excluded.upstream_model,response_model=excluded.response_model,
        streaming=excluded.streaming,token_field=excluded.token_field`,[input,channelId,version.id]);
    await tx.query('UPDATE gateway.channel_versions SET published_at=coalesce(published_at,clock_timestamp()) WHERE id=$1',[version.id]);
    await tx.query('UPDATE gateway.channels SET enabled=true,active_version_id=$2 WHERE id=$1',[channelId,version.id]);
    await audit(tx,userId,requestId,action,reason,{channelId,versionId:version.id,previousVersion:channel.active_version_id,bindings:routes.length});
    return {id:channelId,versionId:version.id,enabled:true,requestId};
  }).catch(async (error:unknown)=>{
    if (!(error instanceof Fault)) throw error;
    await transaction(tx=>audit(tx,userId,requestId,action,error.code,{channelId,versionId:versionId??null},'denied'));
    throw new Fault(error.status,error.code,error.message,requestId);
  });
}
