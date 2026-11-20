import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const localInviteSetupCookie = 'opentoken_invite_setup';
export const inviteSetupCookie = '__Host-'+localInviteSetupCookie;
const setupLifetimeMs = 10 * 60 * 1000;
const maxBodyBytes = 1024;
const inviteInput = z.strictObject({
  token_hash:z.string().regex(/^[a-f0-9]{56}$/).optional(),
  password:z.string().min(12).max(72).refine(value =>
    Array.from(value).length>=12 && new TextEncoder().encode(value).length<=72 &&
    !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)),
});
const tooLarge = Symbol('oversized invitation body');
const setupInput = z.object({expiresAt:z.int(),refreshToken:z.string().min(1).max(2048)});
type InviteSetup = z.infer<typeof setupInput>;

function setupKey(secret: string) {
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('GATEWAY_SECRET must be 32 bytes in hex');
  return createHmac('sha256',Buffer.from(secret,'hex')).update('opentoken/invite-setup/v1').digest();
}

function cookieName(origin: string) {
  return origin.startsWith('https:') ? inviteSetupCookie : localInviteSetupCookie;
}

function setupCookie(req: Request,origin: string) {
  const prefix = cookieName(origin)+'=';
  return req.headers.get('cookie')?.split(';').map(item => item.trim()).find(item => item.startsWith(prefix))?.slice(prefix.length);
}

function unsealSetup(value: string,key: Buffer,origin: string) {
  if (!/^[A-Za-z0-9_-]{39,3500}$/.test(value)) return null;
  const packed = Buffer.from(value,'base64url');
  if (packed.toString('base64url')!==value) return null;
  try {
    const cipher = createDecipheriv('aes-256-gcm',key,packed.subarray(0,12),{authTagLength:16});
    cipher.setAAD(Buffer.from(origin));
    cipher.setAuthTag(packed.subarray(12,28));
    const plaintext = Buffer.concat([cipher.update(packed.subarray(28)),cipher.final()]);
    const result = setupInput.safeParse(JSON.parse(plaintext.toString('utf8')));
    return result.success && result.data.expiresAt>Date.now() ? result.data : null;
  } catch {
    return null;
  }
}

function setSetup(response: Response,origin: string,key: Buffer,setup?: InviteSetup) {
  let value = '',maxAge = 0;
  if (setup && setup.expiresAt>Date.now()) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm',key,nonce,{authTagLength:16});
    cipher.setAAD(Buffer.from(origin));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(setup),'utf8'),cipher.final()]);
    value = Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]).toString('base64url');
    maxAge = Math.max(0,Math.ceil((setup.expiresAt-Date.now())/1000));
  }
  response.headers.set('set-cookie',`${cookieName(origin)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${origin.startsWith('https:') ? '; Secure' : ''}`);
  return response;
}

function json(value: object,status = 200) {
  return Response.json(value,{status,headers:{'cache-control':'no-store','referrer-policy':'no-referrer'}});
}

function failure(status: number,code: string,message: string) {
  return json({error:{code,message}},status);
}

async function readBody(req: Request) {
  if (!req.body || req.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json') return null;
  const reader = req.body.getReader();
  const decoder = new TextDecoder('utf-8',{fatal:true});
  let raw = '',bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return JSON.parse(raw+decoder.decode()) as unknown;
      bytes += chunk.value.byteLength;
      if (bytes>maxBodyBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge;
      }
      raw += decoder.decode(chunk.value,{stream:true});
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function completeInvite(req: Request,origin: string|null,createAuth: () => SupabaseClient['auth'],secret = process.env.GATEWAY_SECRET || '') {
  if (req.method!=='POST') return failure(405,'method_not_allowed','请从邀请页面提交密码。');
  if (!origin || req.headers.get('origin')!==origin) return failure(403,'invalid_origin','请从当前邀请页面发起操作。');
  const body = await readBody(req);
  if (body===tooLarge) return failure(413,'body_too_large','请求内容超过大小限制。');
  const input = inviteInput.safeParse(body);
  if (!input.success) return failure(400,'invalid_invite_request','请检查邀请链接，并使用至少 12 个字符且不超过 72 字节的密码。');

  const unavailable = () => failure(503,'auth_unavailable','身份服务暂时无法使用，请稍后重试。');
  const invalidInvite = () => failure(401,'invalid_invite','邀请链接无效、已使用或已过期。请登录或联系试点运营。');
  const {token_hash,password} = input.data;
  const cookie = setupCookie(req,origin);
  if (!token_hash && !cookie) return invalidInvite();
  try {
    const key = setupKey(secret);
    const previous = !token_hash && cookie ? unsealSetup(cookie,key,origin) : null;
    if (!token_hash && !previous) return setSetup(invalidInvite(),origin,key);
    const auth = createAuth();
    const {data,error} = previous
      ? await auth.refreshSession({refresh_token:previous.refreshToken})
      : await auth.verifyOtp({type:'invite',token_hash:token_hash!});
    if (error?.status===429) return failure(429,'invite_rate_limit','尝试次数较多，请稍后再试。');
    if (error && (!error.status || error.status>=500)) return unavailable();
    if (!data.session) return previous ? setSetup(invalidInvite(),origin,key) : invalidInvite();

    const {access_token,refresh_token} = data.session;
    const expiresAt = previous?.expiresAt ?? Date.now()+setupLifetimeMs;
    const revoke = () => auth.admin.signOut(access_token,'local').catch(() => {});
    // Supabase signup and invite verification share the confirmation token type.
    if (!data.user?.invited_at || expiresAt<=Date.now()) {
      await revoke();
      return previous ? setSetup(invalidInvite(),origin,key) : invalidInvite();
    }
    let updatedPassword = false;
    try {
      let updated = await auth.updateUser({password});
      if (updated.error && (!updated.error.status || updated.error.status>=500)) {
        updated = await auth.updateUser({password});
      }
      updatedPassword = Boolean(updated.data.user || updated.error?.code==='same_password');
    } catch {
      // The invite was consumed. Preserve the verified session so this update can be retried.
    }
    if (updatedPassword) {
      await revoke();
      return cookie ? setSetup(json({ok:true}),origin,key) : json({ok:true});
    }
    const setup = {expiresAt,refreshToken:refresh_token};
    if (setup.expiresAt<=Date.now() || !setupInput.safeParse(setup).success) {
      await revoke();
      return setSetup(invalidInvite(),origin,key);
    }
    return setSetup(failure(409,'invite_password_setup_failed','密码暂未设置成功。请更换密码或稍后重试，邀请验证自首次通过起保留 10 分钟。'),origin,key,setup);
  } catch {
    return unavailable();
  }
}
