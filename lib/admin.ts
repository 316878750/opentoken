import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { digest, store } from './data';
import { sessionUser } from './session';

export type AdminRole = 'system_admin' | 'operator' | 'auditor';
const recentCookie = 'opentoken_admin_recent';
const recentSeconds = 600;

export function setRecentAdminAuth(response:NextResponse,origin:string,token?:string) {
  const timestamp = String(Math.floor(Date.now()/1000));
  const proof = token ? timestamp+'.'+digest('admin-recent',timestamp+'\0'+token).toString('hex') : '';
  response.cookies.set(recentCookie,proof,{path:'/',httpOnly:true,sameSite:'strict',secure:origin.startsWith('https:'),
    maxAge:token ? recentSeconds : 0});
}

export function hasRecentAdminAuth(request:NextRequest,token:string|undefined) {
  const parsed = /^(\d{10})\.([a-f0-9]{64})$/.exec(request.cookies.get(recentCookie)?.value ?? '');
  if (!token || !parsed) return false;
  const age = Math.floor(Date.now()/1000)-Number(parsed[1]);
  return age>=0 && age<recentSeconds && timingSafeEqual(Buffer.from(parsed[2],'hex'),digest('admin-recent',parsed[1]+'\0'+token));
}
type LoginOutcome = 'success' | 'failure' | 'rate_limited' | 'unavailable';

export async function adminRole(userId: string) {
  const {rows:[row]} = await store().db.query<{role:AdminRole|null}>(
    'SELECT gateway.admin_role_for($1) AS role',[userId]);
  return row.role;
}

export async function adminAccess(token: string | undefined, entryPoint: 'admin.page' | 'admin.session') {
  const requestId = randomUUID();
  const userId = await sessionUser(token);
  if (!userId) return {userId,role:null,requestId};

  const {rows:[row]} = await store().db.query<{role:AdminRole|null}>(
    'SELECT gateway.authorize_admin($1,$2,$3) AS role',[userId,requestId,entryPoint]);
  return {userId,role:row.role,requestId};
}

export async function recordLoginEvent(requestId: string,email: string,outcome: LoginOutcome,userId: string | null = null) {
  const identifier = digest('login-event-email',email.trim().toLowerCase());
  await store().db.query(`INSERT INTO gateway.login_events(request_id,user_id,identifier_digest,outcome)
    VALUES ($1,$2,$3,$4)`,[requestId,userId,identifier,outcome]);
}
