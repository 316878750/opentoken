import { createClient } from '@supabase/supabase-js';
import type { NextRequest, NextResponse } from 'next/server';

export const sessionCookie = 'opentoken_session';

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

export async function sessionUser(token: string | undefined) {
  if (!token || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
  const {data,error} = await createAuthClient().auth.getUser(token);
  if (error && (!error.status || error.status>=500)) throw new Error('Supabase Auth is temporarily unavailable');
  return data.user?.id ?? null;
}

export async function endSession(token: string | undefined) {
  if (token && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
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
