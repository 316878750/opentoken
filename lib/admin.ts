import { randomUUID } from 'node:crypto';
import { digest, store } from './data';
import { sessionUser } from './session';

export type AdminRole = 'system_admin' | 'operator' | 'auditor';
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
