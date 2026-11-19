import { NextRequest, NextResponse } from 'next/server';
import * as z from 'zod';
import { catalog, complete, createKey, Fault, listKeys, models, updateKey } from './gateway';
import { dashboard, usage } from './reports';
import { newSession, sessionCookie, sessionSeconds, sessionUser, validLogin } from './session';

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
const callInput = z.strictObject({
  model:z.string().min(1).max(64), stream:z.literal(false).default(false),
  messages:z.array(z.strictObject({ role:z.enum(['system','user','assistant']), content:z.string().min(1).max(3000) })).min(1).max(12),
  max_completion_tokens:z.int().min(1).max(128).default(128),
});

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
    const host = req.headers.get('host') || '';
    if (!/^127\.0\.0\.1(?::\d{1,5})?$/.test(host)) throw new Fault(403,'local_only','请使用本机回环地址访问。');
    const path = req.nextUrl.pathname, method = req.method;
    const route = method + ' ' + path;
    const bearer = req.headers.get('authorization');
    if (route === 'GET /v1/models') return json(await models(bearer));
    if (route === 'POST /v1/chat/completions') {
      const requestBody = parse(callInput,await body(req));
      const retry = req.headers.get('idempotency-key');
      if (retry !== null && !/^[!-~]{1,128}$/.test(retry)) throw new Fault(400,'bad_idempotency_key','幂等键须为 1 至 128 个可见 ASCII 字符。');
      if (Buffer.byteLength(requestBody.messages.map(m => m.content).join(''),'utf8')>3000) {
        throw new Fault(400,'input_too_long','模拟接口限 3,000 字节文本输入。');
      }
      const result = await complete(bearer,requestBody,retry);
      const response = json(result);
      response.headers.set('x-request-id',result.id);
      return response;
    }
    if (method !== 'GET' && req.headers.get('origin') !== 'http://' + host) {
      throw new Fault(403,'invalid_origin','请从本机控制台发起操作。');
    }
    if (route === 'POST /api/session/login') {
      const input = parse(z.object({email:z.email().max(254),password:z.string().min(1).max(256)}),await body(req));
      if (!validLogin(input.email,input.password)) throw new Fault(401,'invalid_login','邮箱或密码有误。');
      const response = json({ok:true});
      response.cookies.set(sessionCookie,await newSession(),{path:'/',httpOnly:true,sameSite:'strict',maxAge:sessionSeconds});
      return response;
    }
    const user = await sessionUser(req.cookies.get(sessionCookie)?.value);
    if (!user) throw new Fault(401,'session_required','请先登录。');
    if (route === 'POST /api/session/logout') {
      const response = new NextResponse(null,{status:204,headers:{'cache-control':'no-store'}});
      response.cookies.set(sessionCookie,'',{path:'/',httpOnly:true,sameSite:'strict',maxAge:0});
      return response;
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
