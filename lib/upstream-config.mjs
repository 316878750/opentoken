import { z } from 'zod';

export const upstreamModel = 'gpt-5.4-mini-2026-03-17';
export const openAiAlias = 'openai-mini';
export const compatibleAlias = 'compatible-chat';

/** @typedef {{code:string,name:string,multiplierBps:number}} PricingGroup */
const pilotGroup = {code:'pilot',name:'试点分组',multiplierBps:10000};

/** @typedef {{
 * mode: 'official'|'compatible', alias: string, model: string, responseModel: string, endpoint: string, apiKey: string,
 * tokenField: 'max_tokens'|'max_completion_tokens', maxContextTokens: number, maxOutputTokens: number, streaming: boolean,
 * inputMicros: string, cacheMicros: string, outputMicros: string, groups: PricingGroup[]
 * }} LiveUpstream
 */

/** @param {NodeJS.ProcessEnv} env @param {string} name */
function micros(env,name) {
  const value = (env[name] || '').trim();
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(value)) throw new Error(name+' must be an explicit USD price with up to six decimals');
  const [whole, fraction=''] = value.split('.');
  return (BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0'))).toString();
}

/** @param {NodeJS.ProcessEnv} [env] @returns {LiveUpstream|null} */
export function resolveLiveUpstream(env=process.env) {
  if (env.ENABLE_OPENAI!=='1') return null;
  const mode = env.UPSTREAM_MODE?.trim();
  if (mode!=='official' && mode!=='compatible') throw new Error('UPSTREAM_MODE must be explicitly set to official or compatible');
  const keyName = mode==='compatible' ? 'COMPATIBLE_API_KEY' : 'OPENAI_API_KEY';
  const apiKey = env[keyName]?.trim();
  if (!apiKey) throw new Error(keyName+' is required');
  const streaming = env.ENABLE_UPSTREAM_STREAMING==='1';
  if (mode==='official') {
    if (env.OPENAI_BASE_URL?.trim()) throw new Error('Use compatible mode for OPENAI_BASE_URL');
    return {mode,alias:openAiAlias,model:upstreamModel,responseModel:upstreamModel,apiKey,streaming,groups:[pilotGroup],
      endpoint:'https://api.openai.com/v1/chat/completions',tokenField:'max_completion_tokens',
      maxContextTokens:400_000,maxOutputTokens:128,inputMicros:'750000',cacheMicros:'75000',outputMicros:'4500000'};
  }
  let endpoint;
  try { endpoint = new URL((env.OPENAI_BASE_URL || '').trim()); }
  catch { throw new Error('OPENAI_BASE_URL must be the configured provider HTTPS URL'); }
  if (endpoint.protocol!=='https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    endpoint.hostname.replace(/\.$/,'')==='api.openai.com' || endpoint.hostname==='localhost') {
    throw new Error('OPENAI_BASE_URL requires a third-party HTTPS address without credentials, query or fragment');
  }
  const basePath = endpoint.pathname.replace(/\/+$/,'');
  endpoint.pathname = basePath.endsWith('/chat/completions') ? basePath : basePath + '/chat/completions';
  const model = env.OPENAI_MODEL?.trim() || '';
  const responseModel = env.OPENAI_RESPONSE_MODEL?.trim() || model;
  if (![model,responseModel].every(value=>/^[A-Za-z0-9][\w./:@-]{0,127}$/.test(value))) throw new Error('OPENAI_MODEL or OPENAI_RESPONSE_MODEL is invalid');
  const tokenField = env.UPSTREAM_MAX_TOKENS_FIELD?.trim() || 'max_tokens';
  if (tokenField!=='max_tokens' && tokenField!=='max_completion_tokens') throw new Error('UPSTREAM_MAX_TOKENS_FIELD is invalid');
  const contextValue = env.UPSTREAM_MAX_CONTEXT_TOKENS?.trim() || '8192';
  const maxContextTokens = Number(contextValue);
  if (!/^\d+$/.test(contextValue) || !Number.isInteger(maxContextTokens) || maxContextTokens<128 || maxContextTokens>5_000_000) {
    throw new Error('UPSTREAM_MAX_CONTEXT_TOKENS must be an integer from 128 to 5000000');
  }
  const inputMicros = micros(env,'UPSTREAM_INPUT_USD_PER_MTOK');
  const cacheMicros = micros(env,'UPSTREAM_CACHED_USD_PER_MTOK');
  const outputMicros = micros(env,'UPSTREAM_OUTPUT_USD_PER_MTOK');
  if (inputMicros==='0' && outputMicros==='0') throw new Error('Configure a priced model for live billing verification');
  return {mode,alias:compatibleAlias,model,responseModel,endpoint:endpoint.href,apiKey,tokenField,streaming,
    maxContextTokens,maxOutputTokens:128,inputMicros,cacheMicros,outputMicros,groups:[pilotGroup]};
}

const groupSchema = z.strictObject({
  code:z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),name:z.string().trim().min(1).max(80),
  multiplierBps:z.int().min(1).max(100_000),
});
const modelSchema = z.strictObject({
  alias:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  model:z.string().min(1).max(128),responseModel:z.string().min(1).max(128).optional(),
  inputUsdPerMtok:z.string(),cachedUsdPerMtok:z.string(),outputUsdPerMtok:z.string(),
  maxContextTokens:z.int().min(128).max(5_000_000).optional(),
  tokenField:z.enum(['max_tokens','max_completion_tokens']).optional(),
  streaming:z.boolean().optional(),groups:z.array(groupSchema).min(1).max(20).optional(),
});

/** @param {NodeJS.ProcessEnv} [env] @returns {LiveUpstream[]} */
export function resolveLiveUpstreams(env=process.env) {
  const primary = resolveLiveUpstream(env);
  if (!primary) return [];
  const publishPrimary = primary.mode!=='compatible' || env.UPSTREAM_PUBLISH_PRIMARY!=='0';
  const source = env.UPSTREAM_ADDITIONAL_MODELS_JSON?.trim();
  if (!source) return publishPrimary ? [primary] : [];
  if (primary.mode!=='compatible') throw new Error('Additional models require a configured compatible provider');
  let value;
  try { value = JSON.parse(source); }
  catch { throw new Error('UPSTREAM_ADDITIONAL_MODELS_JSON must be valid JSON'); }
  const parsed = z.array(modelSchema).max(20).safeParse(value);
  if (!parsed.success) throw new Error('Invalid additional model or pricing group configuration');
  const aliases = new Set(['mock-text',openAiAlias,primary.alias]);
  const groupNames = new Map([[pilotGroup.code,pilotGroup.name]]);
  const additional = parsed.data.map(entry => {
    if (aliases.has(entry.alias)) throw new Error('Duplicate or reserved model alias');
    aliases.add(entry.alias);
    const groups = entry.groups ?? [pilotGroup];
    const groupCodes = new Set();
    for (const group of groups) {
      const knownName = groupNames.get(group.code);
      if (groupCodes.has(group.code) || (knownName && knownName!==group.name)) throw new Error('Duplicate or inconsistent pricing group');
      groupCodes.add(group.code);
      groupNames.set(group.code,group.name);
    }
    const provider = resolveLiveUpstream({...env,OPENAI_MODEL:entry.model,OPENAI_RESPONSE_MODEL:entry.responseModel ?? '',
      UPSTREAM_INPUT_USD_PER_MTOK:entry.inputUsdPerMtok,UPSTREAM_CACHED_USD_PER_MTOK:entry.cachedUsdPerMtok,
      UPSTREAM_OUTPUT_USD_PER_MTOK:entry.outputUsdPerMtok,UPSTREAM_MAX_CONTEXT_TOKENS:String(entry.maxContextTokens ?? primary.maxContextTokens),
      UPSTREAM_MAX_TOKENS_FIELD:entry.tokenField ?? primary.tokenField,ENABLE_UPSTREAM_STREAMING:entry.streaming && primary.streaming ? '1' : '0'});
    if (!provider) throw new Error('Additional model requires a configured compatible provider');
    return {...provider,alias:entry.alias,groups};
  });
  return publishPrimary ? [primary,...additional] : additional;
}
