import { createClient } from '@supabase/supabase-js';
import type { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { digest, store } from './data';

export const sessionCookie = 'opentoken_session';
const sessionPattern = /^([\w-]+\.[\w-]+\.[\w-]+)(?:~([a-f0-9]{64}))?$/;

export async function accountRevision(userId:string) {
  const {rows:[row]} = await store().db.query<{revision:string|null}>(
    'SELECT gateway.account_access($1)::text AS revision',[userId]);
  return row.revision;
}

function sessionProof(token:string,revision:string) {
  return digest('session-revision',revision+'\0'+token);
}

export function sealSession(token:string,revision:string) {
  return token+'~'+sessionProof(token,revision).toString('hex');
}

export function createAuthClient() {
  const { SUPABASE_URL:base, SUPABASE_PUBLISHABLE_KEY:key } = process.env;
  if (!base || !key) throw new Error('Supabase Auth is not configured');
  const url = new URL(base);
  if (url.protocol!=='https:' && (url.protocol!=='http:' || url.hostname!=='127.0.0.1')) {
    throw new Error('Supabase Auth requires HTTPS');
  }
  return createClient(url.origin,key,{auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false},
    global:{fetch:(input,init) => fetch(input,{...init,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)})}});
}

export async function loginSession(email: string,password: string) {
  return createAuthClient().auth.signInWithPassword({email,password});
}

export async function sessionUser(cookie: string | undefined) {
  const parsed = sessionPattern.exec(cookie ?? '');
  if (!parsed) return null;
  const [,token,proof] = parsed;
  const {data,error} = await createAuthClient().auth.getUser(token);
  if (error && (!error.status || error.status>=500)) throw new Error('Supabase Auth is temporarily unavailable');
  const userId = data.user?.id;
  if (!userId) return null;
  const revision = await accountRevision(userId);
  if (revision===null) return null;
  // Cookies issued before this migration remain valid for never-suspended accounts.
  if (!proof) return revision==='0' ? userId : null;
  return timingSafeEqual(Buffer.from(proof,'hex'),sessionProof(token,revision)) ? userId : null;
}

export async function endSession(cookie: string | undefined) {
  const token = sessionPattern.exec(cookie ?? '')?.[1];
  if (token) {
    const {error} = await createAuthClient().auth.admin.signOut(token,'local');
    if (error && (!error.status || error.status>=500)) console.error('Supabase session revoke temporarily unavailable');
  }
}

export function appOrigin(req: NextRequest) {
  const host = req.headers.get('host') || '';
  if (process.env.APP_ORIGIN) {
    const configured = new URL(process.env.APP_ORIGIN);
    return configured.host===host && (configured.protocol==='https:' || configured.hostname==='127.0.0.1')
      ? configured.origin : null;
  }
  return /^127\.0\.0\.1(?::\d{1,5})?$/.test(host) ? 'http://'+host : null;
}

export function setSession(response: NextResponse,origin: string,token = '',maxAge = 0) {
  response.cookies.set(sessionCookie,token,{path:'/',httpOnly:true,sameSite:'strict',secure:origin.startsWith('https:'),maxAge});
}
