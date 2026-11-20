import { NextRequest, NextResponse } from 'next/server';
import * as z from 'zod';
import { ensureWallet } from './data';
import { catalog, complete, createKey, Fault, listKeys, models, streamCompletion, updateKey } from './gateway';
import { dashboard, usage } from './reports';
import { appOrigin, endSession, loginSession, sessionCookie, sessionUser, setSession } from './session';
import { redeemCredit, walletEntries } from './wallet';

const date = z.iso.datetime({ offset:true });
const usageFilter = z.object({
  key_id:z.uuid().optional(), request_id:z.uuid().optional(), cursor:z.uuid().optional(),
  status:z.enum(['reserved','dispatched','review','settled','released']).optional(),
  from:date.optional(), to:date.optional(),
}).refine(f => !f.from || !f.to || new Date(f.from) < new Date(f.to));
const keyInput = z.object({
  name:z.string().trim().min(1).max(80), groupId:z.uuid(), rpm:z.int().min(1).max(600),
  capMicros:z.string().regex(/^[1-9]\d{0,14}$/).nullish(),
});
const ledgerFilter = z.object({kind:z.enum(['redemption','usage']).optional(),cursor:z.uuid().optional()});
const redemptionInput = z.strictObject({code:z.string().trim().min(1).max(128)});
const callInput = z.strictObject({
  model:z.string().min(1).max(64), stream:z.boolean().default(false),
  stream_options:z.strictObject({include_usage:z.boolean().optional()}).optional(),
  messages:z.array(z.strictObject({ role:z.enum(['system','user','assistant']), content:z.string().min(1).max(3000) })).min(1).max(12),
  max_completion_tokens:z.int().min(1).max(128).default(128),
}).refine(request => request.stream || !request.stream_options);

function json(data: unknown, status = 200) {
  return NextResponse.json(data,{status,headers:{'cache-control':'no-store'}});
}
function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new Fault(400,'invalid_request','请检查输入字段及其格式。');
  return result.data;
}
async function body(req: NextRequest) {
  if (!req.headers.get('content-type')?.startsWith('application/json') || !req.body) {
    throw new Fault(400,'invalid_body','请发送 JSON 请求。');
  }
  const reader = req.body.getReader();
  const decoder = new TextDecoder('utf-8',{fatal:true});
  let value = '', length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length>16_384) throw new Fault(413,'body_too_large','请求体超过 16 KB。');
      value += decoder.decode(chunk.value,{stream:true});
    }
    return JSON.parse(value+decoder.decode());
  } catch (error) {
    if (error instanceof Fault) { await reader.cancel().catch(() => {}); throw error; }
    throw new Fault(400,'invalid_json','请求体不是有效的 JSON。');
  } finally {
    reader.releaseLock();
  }
}

export async function handle(req: NextRequest) {
  try {
    const origin = appOrigin(req);
    if (!origin) throw new Fault(403,'invalid_host','请使用配置的应用地址访问。');
    const path = req.nextUrl.pathname, method = req.method;
    const route = method + ' ' + path;
    const bearer = req.headers.get('authorization');
    if (route === 'GET /v1/models') return json(await models(bearer));
    if (route === 'POST /v1/chat/completions') {
      const requestBody = parse(callInput,await body(req));
      const retry = req.headers.get('idempotency-key');
      if (retry !== null && !/^[!-~]{1,128}$/.test(retry)) throw new Fault(400,'bad_idempotency_key','幂等键须为 1 至 128 个可见 ASCII 字符。');
      if (Buffer.byteLength(requestBody.messages.map(m => m.content).join(''),'utf8')>3000) {
        throw new Fault(400,'input_too_long','首发接口限 3,000 字节文本输入。');
      }
      if (requestBody.stream) return await streamCompletion(bearer,requestBody,retry,requestBody.stream_options?.include_usage);
      const result = await complete(bearer,requestBody,retry);
      const response = json(result);
      response.headers.set('x-request-id',result.id);
      return response;
    }
    if (method !== 'GET' && req.headers.get('origin') !== origin) {
      throw new Fault(403,'invalid_origin','请从当前控制台发起操作。');
    }
    if (route === 'POST /api/session/login') {
      const input = parse(z.object({email:z.email().max(254),password:z.string().min(1).max(256)}),await body(req));
      const {data,error} = await loginSession(input.email,input.password);
      if (error?.status===429) throw new Fault(429,'login_rate_limit','尝试次数较多，请稍后再登录。');
      if (error && (!error.status || error.status>=500)) throw new Fault(503,'auth_unavailable','身份服务暂时无法使用。');
      if (!data.session || !data.user) throw new Fault(401,'invalid_login','邮箱或密码有误，或账号尚未验证。');
      await ensureWallet(data.user.id);
      const response = json({ok:true});
      setSession(response,origin,data.session.access_token,data.session.expires_in);
      return response;
    }
    const token = req.cookies.get(sessionCookie)?.value;
    if (route === 'POST /api/session/logout') {
      await endSession(token).catch(() => console.error('Supabase session revoke failed'));
      const response = new NextResponse(null,{status:204,headers:{'cache-control':'no-store'}});
      setSession(response,origin);
      return response;
    }
    const user = await sessionUser(token);
    if (!user) throw new Fault(401,'session_required','请先登录。');
    if (route === 'POST /api/redeem') {
      const {code} = parse(redemptionInput,await body(req));
      const result = await redeemCredit(user,code);
      if (result.status==='ok') return json({receipt:result.receipt,wallet:result.wallet,replayed:result.replayed});
      if (result.status==='rate_limited') {
        const response = json({error:{code:'redeem_rate_limit',message:'尝试次数过多，请稍后再试。'}},429);
        response.headers.set('Retry-After',String(result.retryAfter));
        return response;
      }
      if (result.status==='balance_limit') throw new Fault(409,'balance_limit','本次补额会超出钱包余额上限。');
      throw new Fault(404,'redeem_unavailable','兑换码不可用，请检查输入或联系试点运营。');
    }
    if (route === 'GET /api/wallet/entries') {
      return json(await walletEntries(user,parse(ledgerFilter,Object.fromEntries(req.nextUrl.searchParams))));
    }
    if (route === 'GET /api/catalog') return json({rates:await catalog()});
    if (route === 'GET /api/keys') return json({items:await listKeys(user)});
    if (route === 'POST /api/keys') {
      const input = parse(keyInput,await body(req));
      return json(await createKey(user,input.name,input.groupId,input.rpm,input.capMicros ?? null),201);
    }
    if (path.startsWith('/api/keys/') && (method === 'PATCH' || method === 'DELETE')) {
      const id = parse(z.uuid(),path.slice('/api/keys/'.length));
      const status = method === 'DELETE' ? 'revoked' :
        parse(z.object({status:z.enum(['active','disabled'])}),await body(req)).status;
      await updateKey(user,id,status);
      return json({ok:true});
    }
    if (route === 'GET /api/dashboard') {
      const tz = req.nextUrl.searchParams.get('tz') || 'UTC';
      if (/^[+-]/.test(tz)) throw new Fault(400,'invalid_timezone','请使用 IANA 时区。');
      try { new Intl.DateTimeFormat('en',{timeZone:tz}); }
      catch { throw new Fault(400,'invalid_timezone','时区无效。'); }
      return json(await dashboard(user,tz));
    }
    if (route === 'GET /api/usage') return json(await usage(user,parse(usageFilter,Object.fromEntries(req.nextUrl.searchParams))));
    throw new Fault(404,'not_found','该接口不在本次实现范围内。');
  } catch (error) {
    if (!(error instanceof Fault)) console.error('Local gateway operation failed',error instanceof Error ? error.name : 'unknown');
    const fault = error instanceof Fault ? error : new Fault(500,'internal_error','操作暂时失败，请重试。');
    const response = json({error:{message:fault.message,code:fault.code,request_id:fault.requestId}},fault.status);
    if (fault.requestId) response.headers.set('x-request-id',fault.requestId);
    return response;
  }
}
