import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { adminRole } from './admin';
import { channelCredentials, type ChannelCredential } from './channel-credentials';
import { store } from './data';
import { Fault } from './gateway';
import { resolveLiveUpstreams } from './upstream-config.mjs';

const modelCode = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const groupCode = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const name = z.string().trim().min(1).max(80);
const reason = z.string().trim().min(3).max(160);
const usd = z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).transform(value=>{
  const [whole,fraction=''] = value.split('.');
  return String(BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0')));
});

export const modelAdminInput = z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),payload:z.strictObject({code:modelCode,
    maxContextTokens:z.int().min(128).max(5_000_000),maxOutputTokens:z.int().min(1).max(128)})}),
  z.object({action:z.literal('state'),payload:z.strictObject({code:modelCode,enabled:z.boolean(),reason})}),
  z.object({action:z.literal('group-create'),payload:z.strictObject({code:groupCode,name})}),
  z.object({action:z.literal('group-rename'),payload:z.strictObject({code:groupCode,name})}),
  z.object({action:z.literal('group-state'),payload:z.strictObject({code:groupCode,enabled:z.boolean(),reason})}),
  z.object({action:z.literal('rate-publish'),payload:z.strictObject({model:modelCode,group:groupCode,
    inputUsd:usd,cachedUsd:usd,outputUsd:usd,multiplierBps:z.int().min(1).max(100_000),
    expectedRateId:z.uuid().nullable(),reason}).transform(({inputUsd,cachedUsd,outputUsd,...fields})=>({
      ...fields,inputMicros:inputUsd,cacheMicros:cachedUsd,outputMicros:outputUsd,
    }))}),
]);

type ModelAdminAction = z.infer<typeof modelAdminInput>;
type ModelRate = {id:string;group:string;inputMicros:string;cacheMicros:string;outputMicros:string;
  multiplierBps:number;createdAt:string;closedAt:string|null;canPublish:boolean};
type CatalogModel = {code:string;enabled:boolean;maxContextTokens:number;maxOutputTokens:number;
  canManageState:boolean;rates:ModelRate[];bindings:{group:string;upstreamModel:string;effective:boolean;streaming:boolean}[]};
type ModelGroup = {code:string;name:string;enabled:boolean};
export type AdminModelCatalog = {canWrite:boolean;models:CatalogModel[];groups:ModelGroup[]};

export async function listAdminModels(userId:string):Promise<AdminModelCatalog> {
  const role = await adminRole(userId);
  if (role!=='system_admin' && role!=='operator') throw new Fault(403,'model_forbidden','当前账号没有模型查看权限。');
  const {rows:[catalog]} = await store().db.query<Pick<AdminModelCatalog,'models'|'groups'>>(`
    SELECT coalesce((SELECT jsonb_agg(item ORDER BY item.code) FROM (
      SELECT m.code,m.enabled,m.max_context_tokens AS "maxContextTokens",
        m.max_output_tokens AS "maxOutputTokens",
        gateway.can_manage_model(m.id) AS "canManageState",
        coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'group',g.code,'inputMicros',r.input_micros_per_mtok::text,
          'cacheMicros',r.cached_input_micros_per_mtok::text,'outputMicros',r.output_micros_per_mtok::text,
          'multiplierBps',r.multiplier_bps,'createdAt',r.created_at,'closedAt',r.closed_at,
          'canPublish',m.code<>'mock-text' AND (m.admin_managed OR cr.group_id IS NOT NULL))
          ORDER BY r.created_at DESC,r.id DESC)
          FROM gateway.model_rates r JOIN gateway.pricing_groups g ON g.id=r.group_id
          LEFT JOIN gateway.channel_routes cr ON cr.model_id=r.model_id AND cr.group_id=r.group_id
          WHERE r.model_id=m.id),'[]'::jsonb) AS rates,
        coalesce((SELECT jsonb_agg(jsonb_build_object('group',g.code,'upstreamModel',cr.upstream_model,'streaming',cr.streaming,
          'effective',cr.effective AND coalesce($1::jsonb->>cr.credential_ref=cr.credential_fingerprint,false)
            AND NOT EXISTS (SELECT 1 FROM gateway.stripe_sandbox WHERE enabled)) ORDER BY g.code)
          FROM gateway.channel_runtime_routes cr JOIN gateway.pricing_groups g ON g.id=cr.group_id
          WHERE cr.model_id=m.id AND cr.current_binding),'[]'::jsonb) AS bindings
      FROM gateway.models m
    ) item),'[]'::jsonb) AS models,
      coalesce((SELECT jsonb_agg(jsonb_build_object('code',g.code,'name',g.name,'enabled',g.enabled) ORDER BY g.code)
        FROM gateway.pricing_groups g),'[]'::jsonb) AS groups`,[JSON.stringify(availableCredentials())]);
  return {...catalog,canWrite:role==='system_admin'};
}

function availableCredentials(registry:ChannelCredential[]=channelCredentials()) {
  if (process.env.ENABLE_OPENAI!=='1') return {};
  return Object.fromEntries(registry.filter(item=>item.fingerprint).map(item=>[item.ref,item.fingerprint]));
}

const errors:Record<string,[number,string]> = {
  model_forbidden:[403,'当前账号没有模型管理权限。'],
  admin_recent_auth_required:[403,'请重新登录后再上架、启用分组或发布费率。'],
  model_duplicate:[409,'该模型代号已使用或由环境配置保留。'],
  model_not_found:[404,'模型不存在。'],
  model_group_duplicate:[409,'该分组代号已使用。'],
  model_group_not_found:[404,'分组不存在。'],
  legacy_model_managed:[409,'请先在渠道管理中接管此模型的所有已定价分组。'],
  legacy_rate_managed:[409,'请先在渠道管理中接管此模型和分组，模拟费率由系统管理。'],
  model_route_required:[409,'上架前至少需要一条可用渠道、有效费率和已启用的分组。'],
  model_rate_changed:[409,'当前费率已变更，请刷新费率并核对后重试。'],
  model_cache_probe_required:[409,'请先在渠道管理重新测试此绑定，确认上游返回可核对的缓存 Token 用量。'],
  invalid_request:[400,'请检查输入。模型输入价和输出价至少有一项大于零。'],
};

export async function writeAdminModel(userId:string,{action,payload}:ModelAdminAction,recent:boolean) {
  const requestId = randomUUID();
  const registry = channelCredentials();
  const providers = resolveLiveUpstreams();
  const configured = [...registry,...providers];
  if (configured.some(item=>item.apiKey && Object.values(payload).some(value=>typeof value==='string' && value.includes(item.apiKey)))) {
    throw new Fault(400,'model_secret_in_text','请勿在模型信息或变更原因中填入密钥。');
  }
  const submitted = action==='create' ? {...payload,reserved:providers.some(item=>item.alias===payload.code)} : payload;
  const {rows:[{result}]} = await store().db.query<{result:{id:string|null;denied:string|null}}>(
    'SELECT gateway.admin_write_model($1,$2,$3,$4,$5,$6) AS result',
    [userId,requestId,action,JSON.stringify(submitted),recent,JSON.stringify(availableCredentials(registry))]);
  if (result.denied) {
    const [status,message] = errors[result.denied] ?? [409,'模型变更未能完成。'];
    throw new Fault(status,result.denied,message,requestId);
  }
  return {id:result.id,requestId,status:['create','group-create','rate-publish'].includes(action) ? 201 : 200};
}
