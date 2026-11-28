import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import * as z from 'zod';
import { readSettings, settingsChange, settingsPage, writeSettings, siteDisplay } from './admin-settings';
import { adminAccess, hasRecentAdminAuth, recordLoginEvent, setRecentAdminAuth } from './admin';
import { issueAdminRedeem, listAdminRedeem, voidAdminRedeem } from './admin-redeem';
import { channelDraftInput, channelProbeInput, channelDisableInput, channelPublishInput, changeChannel,
  listChannels, probeChannel, saveChannel } from './admin-channels';
import { listAdminModels, modelAdminInput, writeAdminModel } from './admin-models';
import { listAdminLogs, loginLogFilter, operationLogFilter } from './admin-logs';
import { inviteAdminUser, listAdminUsers, userChangeInput, userInviteInput, userListInput, writeAdminUser } from './admin-users';
import { ensureWallet } from './data';
import { catalog, complete, createKey, editKey, Fault, keyOptions, keyPage, listKeys, models, streamCompletion, updateKey } from './gateway';
import { billing, receiveStripeWebhook, startCheckout, startPortal } from './payments';
import { dashboard, usage, usageTrend } from './reports';
import { accountRevision, appOrigin, endSession, loginSession, sealSession, sessionCookie, sessionUser, setSession } from './session';
import { redeemCredit, walletEntries } from './wallet';

const date = z.iso.datetime({ offset:true });
const localDay = z.iso.date().refine(value=>!value.startsWith('0000-'));
const usageFilter = z.object({
  key_id:z.uuid().optional(), request_id:z.uuid().optional(), cursor:z.uuid().optional(),
  status:z.enum(['reserved','dispatched','review','settled','released']).optional(),
  from:date.optional(), to:date.optional(),fromDay:localDay.optional(),throughDay:localDay.optional(),
}).refine(f => !f.from || !f.to || new Date(f.from) < new Date(f.to))
  .refine(f=>!f.fromDay || !f.throughDay || f.fromDay<=f.throughDay);
const keyInput = z.object({
  name:z.string().trim().min(1).max(80), groupId:z.uuid(), rpm:z.int().min(1).max(600),
  capMicros:z.string().regex(/^[1-9]\d{0,14}$/).nullish(),
});
const keyFilter = z.strictObject({
  q:z.string().trim().max(80).optional(),status:z.enum(['active','disabled','revoked']).optional(),
  groupId:z.uuid().optional(),cursor:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(10),
});
const keyPatch = z.union([
  z.strictObject({status:z.enum(['active','disabled'])}),
  keyInput.omit({groupId:true}).partial().strict().refine(edit=>Object.keys(edit).length>0),
]);
const ledgerFilter = z.object({kind:z.enum(['redemption','usage','stripe_refund','stripe_refund_reversal']).optional(),cursor:z.uuid().optional()});
const trendRange = z.enum(['7','30']).default('7');
const checkoutInput = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('credit'),nonce:z.uuid(),amountCents:z.union([z.literal(500),z.literal(2000),z.literal(5000)]).optional()}),
  z.strictObject({kind:z.literal('subscription'),nonce:z.uuid()}),
]);
const redemptionInput = z.strictObject({code:z.string().trim().min(1).max(128)});
const adminRedeemIssueInput = z.strictObject({amountUsd:z.string().max(20),expiresAt:date,operationId:z.uuid()});
const adminRedeemFilter = z.strictObject({status:z.enum(['active','expired','voided','redeemed']).optional(),cursor:z.uuid().optional()});
const callInput = z.strictObject({
  model:z.string().min(1).max(64), stream:z.boolean().default(false),
  stream_options:z.strictObject({include_usage:z.boolean().optional()}).optional(),
  messages:z.array(z.strictObject({ role:z.enum(['system','user','assistant']), content:z.string().min(1).max(3000) })).min(1).max(12),
  max_completion_tokens:z.int().min(1).max(128).default(128),
}).refine(request => request.stream || !request.stream_options);

function json(data: unknown, status = 200, requestId?:string) {
  const headers:Record<string,string> = {'cache-control':'no-store'};
  if (requestId) headers['x-request-id'] = requestId;
  return NextResponse.json(data,{status,headers});
}
function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new Fault(400,'invalid_request','请检查输入字段及其格式。');
  return result.data;
}
async function jsonText(req: NextRequest,limit=16_384) {
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
      if (length>limit) throw new Fault(413,'body_too_large','请求体超过大小上限。');
      value += decoder.decode(chunk.value,{stream:true});
    }
    return value+decoder.decode();
  } catch (error) {
    if (error instanceof Fault) { await reader.cancel().catch(() => {}); throw error; }
    throw new Fault(400,'invalid_json','请求体不是有效的 JSON。');
  } finally {
    reader.releaseLock();
  }
}

async function body(req:NextRequest) {
  const text = await jsonText(req);
  try { return JSON.parse(text); }
  catch { throw new Fault(400,'invalid_json','请求体不是有效的 JSON。'); }
}

async function timeZone(query:URLSearchParams) {
  const tz = query.get('tz') || (await siteDisplay()).timeZone;
  if (/^[+-]/.test(tz)) throw new Fault(400,'invalid_timezone','请使用 IANA 时区。');
  try { new Intl.DateTimeFormat('en',{timeZone:tz}); }
  catch { throw new Fault(400,'invalid_timezone','时区无效。'); }
  return tz;
}

export async function handle(req: NextRequest) {
  try {
    const origin = appOrigin(req);
    if (!origin) throw new Fault(403,'invalid_host','请使用配置的应用地址访问。');
    const path = req.nextUrl.pathname, method = req.method;
    const route = method + ' ' + path;
    const bearer = req.headers.get('authorization');
    if (route === 'POST /api/stripe/webhook') {
      await receiveStripeWebhook(await jsonText(req,262_144),req.headers.get('stripe-signature'));
      return json({ok:true});
    }
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
      const requestId = randomUUID();
      const {data,error} = await loginSession(input.email,input.password);
      if (error?.status===429) {
        await recordLoginEvent(requestId,input.email,'rate_limited');
        throw new Fault(429,'login_rate_limit','尝试次数较多，请稍后再登录。',requestId);
      }
      if (error && (!error.status || error.status>=500)) {
        await recordLoginEvent(requestId,input.email,'unavailable');
        throw new Fault(503,'auth_unavailable','身份服务暂时无法使用。',requestId);
      }
      if (!data.session || !data.user) {
        await recordLoginEvent(requestId,input.email,'failure');
        throw new Fault(401,'invalid_login','邮箱或密码有误，或账号尚未验证。',requestId);
      }
      const revision = await accountRevision(data.user.id);
      if (revision===null) {
        await recordLoginEvent(requestId,input.email,'failure');
        await endSession(data.session.access_token).catch(()=>{});
        throw new Fault(403,'account_unavailable','账号当前不可用，请联系试点运营。',requestId);
      }
      await ensureWallet(data.user.id);
      await recordLoginEvent(requestId,input.email,'success',data.user.id);
      const response = json({ok:true});
      response.headers.set('x-request-id',requestId);
      const sealed = sealSession(data.session.access_token,revision);
      setSession(response,origin,sealed,data.session.expires_in);
      setRecentAdminAuth(response,origin,sealed);
      return response;
    }
    const token = req.cookies.get(sessionCookie)?.value;
    if (route === 'GET /api/admin/session') {
      const {userId,role,requestId} = await adminAccess(token,'admin.session');
      if (!userId) throw new Fault(401,'session_required','请先登录。',requestId);
      if (!role) throw new Fault(403,'admin_required','当前账号没有后台访问权限。',requestId);
      const response = json({role});
      response.headers.set('x-request-id',requestId);
      return response;
    }
    if (route === 'POST /api/session/logout') {
      await endSession(token).catch(() => console.error('Supabase session revoke failed'));
      const response = new NextResponse(null,{status:204,headers:{'cache-control':'no-store'}});
      setSession(response,origin);
      setRecentAdminAuth(response,origin);
      return response;
    }
    const user = await sessionUser(token);
    if (!user) throw new Fault(401,'session_required','请先登录。');
    if (route==='GET /api/admin/settings') {
      const {before} = parse(settingsPage,Object.fromEntries(req.nextUrl.searchParams));
      return json(await readSettings(user,before));
    }
    if (route==='POST /api/admin/settings') {
      const result = await writeSettings(user,parse(settingsChange,await body(req)),hasRecentAdminAuth(req,token));
      return json(result,200,result.requestId);
    }
    if (route==='GET /api/admin/login-logs') {
      return json(await listAdminLogs(user,{kind:'login',filters:parse(loginLogFilter,Object.fromEntries(req.nextUrl.searchParams))}));
    }
    if (route==='GET /api/admin/operation-logs') {
      return json(await listAdminLogs(user,{kind:'operation',filters:parse(operationLogFilter,Object.fromEntries(req.nextUrl.searchParams))}));
    }
    if (route==='GET /api/admin/users') {
      return json(await listAdminUsers(user,parse(userListInput,Object.fromEntries(req.nextUrl.searchParams))));
    }
    if (route==='POST /api/admin/users/invitations') {
      const invite = await inviteAdminUser(user,parse(userInviteInput,await body(req)),origin);
      return json(invite,201,invite.requestId);
    }
    const userAction = method==='POST' && /^\/api\/admin\/users\/([^/]+)\/(state|role|delete)$/.exec(path);
    if (userAction) {
      const change = parse(userChangeInput,{action:userAction[2],payload:await body(req)});
      const saved = await writeAdminUser(user,parse(z.uuid(),userAction[1]),change,hasRecentAdminAuth(req,token));
      return json(saved,200,saved.requestId);
    }
    if (route === 'GET /api/admin/models') return json(await listAdminModels(user));
    const modelAction = method==='POST' && /^\/api\/admin\/models\/(create|state|group-create|group-rename|group-state|rate-publish)$/.exec(path);
    if (modelAction) {
      const input = parse(modelAdminInput,{action:modelAction[1],payload:await body(req)});
      const {id,requestId,status} = await writeAdminModel(user,input,hasRecentAdminAuth(req,token));
      return json({id,requestId},status,requestId);
    }
    if (route === 'GET /api/admin/channels') return json(await listChannels(user));
    if (route === 'POST /api/admin/channels') {
      const saved = await saveChannel(user,parse(channelDraftInput,await body(req)));
      return json(saved,201,saved.requestId);
    }
    const channelAction = method==='POST' && /^\/api\/admin\/channels\/([^/]+)\/(versions|test|enable|disable|rollback)$/.exec(path);
    if (channelAction) {
      const id = parse(z.uuid(),channelAction[1]);
      const action = channelAction[2];
      if (action==='versions') {
        const saved = await saveChannel(user,parse(channelDraftInput,await body(req)),id);
        return json(saved,201,saved.requestId);
      }
      if (action==='test') {
        const tested = await probeChannel(user,id,parse(channelProbeInput,await body(req)));
        return json(tested,200,tested.requestId);
      }
      if (action==='disable') {
        const {reason} = parse(channelDisableInput,await body(req));
        const updated = await changeChannel(user,id,action,reason);
        return json(updated,200,updated.requestId);
      }
      const {versionId,reason} = parse(channelPublishInput,await body(req));
      const updated = await changeChannel(user,id,action==='rollback'?'rollback':'enable',reason,versionId,hasRecentAdminAuth(req,token));
      return json(updated,200,updated.requestId);
    }
    if (route === 'GET /api/admin/redeem-codes') {
      return json(await listAdminRedeem(user,parse(adminRedeemFilter,Object.fromEntries(req.nextUrl.searchParams))));
    }
    if (route === 'POST /api/admin/redeem-codes') {
      const issued = await issueAdminRedeem(user,parse(adminRedeemIssueInput,await body(req)));
      return json(issued.body,issued.status,issued.requestId);
    }
    const voidCode = method==='POST' && /^\/api\/admin\/redeem-codes\/([^/]+)\/void$/.exec(path);
    if (voidCode) {
      const voided = await voidAdminRedeem(user,parse(z.uuid(),voidCode[1]));
      return json(voided.body,200,voided.requestId);
    }
    if (route==='GET /api/billing') return json(await billing(user));
    if (route==='POST /api/billing/checkout') {
      const input = parse(checkoutInput,await body(req));
      return json(await startCheckout(user,input.kind,input.nonce,origin,input.kind==='credit' ? input.amountCents : undefined));
    }
    if (route==='POST /api/billing/portal') return json(await startPortal(user,origin));
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
      if (result.status==='account_unavailable') throw new Fault(401,'session_required','请重新登录。');
      throw new Fault(404,'redeem_unavailable','兑换码不可用，请检查输入或联系试点运营。');
    }
    if (route === 'GET /api/wallet/entries') {
      return json(await walletEntries(user,parse(ledgerFilter,Object.fromEntries(req.nextUrl.searchParams))));
    }
    if (route === 'GET /api/catalog') return json({rates:await catalog()});
    if (route === 'GET /api/keys/options') return json(await keyOptions(user));
    if (route === 'GET /api/keys') {
      const query = req.nextUrl.searchParams;
      return json(query.size ? await keyPage(user,parse(keyFilter,Object.fromEntries(query))) : {items:await listKeys(user)});
    }
    if (route === 'POST /api/keys') {
      const input = parse(keyInput,await body(req));
      return json(await createKey(user,input.name,input.groupId,input.rpm,input.capMicros ?? null),201);
    }
    if (path.startsWith('/api/keys/') && (method === 'PATCH' || method === 'DELETE')) {
      const id = parse(z.uuid(),path.slice('/api/keys/'.length));
      if (method==='DELETE') await updateKey(user,id,'revoked');
      else {
        const edit = parse(keyPatch,await body(req));
        if ('status' in edit) await updateKey(user,id,edit.status);
        else await editKey(user,id,edit);
      }
      return json({ok:true});
    }
    if (route === 'GET /api/dashboard') return json(await dashboard(user,await timeZone(req.nextUrl.searchParams)));
    if (route === 'GET /api/usage-trend') {
      const query = req.nextUrl.searchParams;
      const days = parse(trendRange,query.get('days') ?? undefined);
      return json(await usageTrend(user,await timeZone(query),days==='30' ? 30 : 7));
    }
    if (route === 'GET /api/usage') {
      const filters = parse(usageFilter,Object.fromEntries(req.nextUrl.searchParams));
      return json(await usage(user,filters,filters.fromDay || filters.throughDay ? await timeZone(req.nextUrl.searchParams) : 'UTC'));
    }
    throw new Fault(404,'not_found','该接口不在本次实现范围内。');
  } catch (error) {
    if (!(error instanceof Fault)) console.error('Local gateway operation failed',error instanceof Error ? error.name : 'unknown');
    const fault = error instanceof Fault ? error : new Fault(500,'internal_error','操作暂时失败，请重试。');
    const response = json({error:{message:fault.message,code:fault.code,request_id:fault.requestId}},fault.status);
    if (fault.requestId) response.headers.set('x-request-id',fault.requestId);
    return response;
  }
}
