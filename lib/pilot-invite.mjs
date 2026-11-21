import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';
import { z } from 'zod';

function checkedOrigin(value,name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Set ${name} to an HTTPS origin`); }
  const secure = url.protocol==='https:' || (url.protocol==='http:' && url.hostname==='127.0.0.1');
  if (!secure || url.href!==`${url.origin}/`) throw new Error(`Set ${name} to an HTTPS origin`);
  return url.origin;
}

export function pilotInvitesConfigured(env=process.env) {
  return /^sb_secret_[A-Za-z0-9_-]+$/.test(env.SUPABASE_SECRET_KEY ?? '');
}

export function inviteRecipientDigest(secret,email) {
  if (!/^[a-f0-9]{64}$/i.test(secret ?? '')) throw new Error('GATEWAY_SECRET must be 32 bytes in hex');
  return createHmac('sha256',Buffer.from(secret,'hex')).update('admin-invite-email\0'+email).digest();
}

export class PilotInviteError extends Error {
  constructor(definitive) {
    super('Supabase could not generate an invitation. Check the project settings and recipient account.');
    this.definitive = definitive;
  }
}

export async function generatePilotInvite(email,env=process.env) {
  if (!z.email().max(254).safeParse(email).success) throw new Error('Provide one valid recipient email address');
  const origin = checkedOrigin(env.APP_ORIGIN,'APP_ORIGIN');
  const authOrigin = checkedOrigin(env.SUPABASE_URL,'SUPABASE_URL');
  if (!pilotInvitesConfigured(env)) throw new Error('Set a Supabase sb_secret_ key in the operator process as SUPABASE_SECRET_KEY');
  const auth = createClient(authOrigin,env.SUPABASE_SECRET_KEY,{
    auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false},
    global:{fetch:(input,init) => fetch(input,{...init,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)})},
  }).auth;
  const {data,error} = await auth.admin.generateLink({type:'invite',email,options:{redirectTo:`${origin}/invite`}});
  if (error) throw new PilotInviteError([400,401,403,409,422,429].includes(error.status));
  const properties = data.properties;
  if (properties?.verification_type!=='invite' || !/^[a-f0-9]{56}$/.test(properties.hashed_token)) throw new PilotInviteError(false);
  return `${origin}/invite#token_hash=${properties.hashed_token}`;
}
