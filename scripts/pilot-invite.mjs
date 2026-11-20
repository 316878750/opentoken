import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

function checkedOrigin(value,name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Set ${name} to an HTTPS origin`); }
  const secure = url.protocol==='https:' || (url.protocol==='http:' && url.hostname==='127.0.0.1');
  if (!secure || url.href!==`${url.origin}/`) throw new Error(`Set ${name} to an HTTPS origin`);
  return url.origin;
}

export async function generatePilotInvite(email,env = process.env) {
  if (!z.email().max(254).safeParse(email).success) throw new Error('Provide one valid recipient email address');
  const {APP_ORIGIN,SUPABASE_URL,SUPABASE_SECRET_KEY} = env;
  const origin = checkedOrigin(APP_ORIGIN,'APP_ORIGIN');
  const authOrigin = checkedOrigin(SUPABASE_URL,'SUPABASE_URL');
  if (!SUPABASE_SECRET_KEY || !/^sb_secret_[A-Za-z0-9_-]+$/.test(SUPABASE_SECRET_KEY)) {
    throw new Error('Set a Supabase sb_secret_ key in the operator process as SUPABASE_SECRET_KEY');
  }
  const auth = createClient(authOrigin,SUPABASE_SECRET_KEY,{
    auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false},
    global:{fetch:(input,init) => fetch(input,{...init,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)})},
  }).auth;
  const {data,error} = await auth.admin.generateLink({type:'invite',email,options:{redirectTo:`${origin}/invite`}});
  const properties = data.properties;
  if (error || properties?.verification_type!=='invite' || !/^[a-f0-9]{56}$/.test(properties.hashed_token)) {
    throw new Error('Supabase could not generate an invitation. Check the project settings and recipient account.');
  }
  return `${origin}/invite#token_hash=${properties.hashed_token}`;
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length!==3) throw new Error('Usage: node scripts/pilot-invite.mjs <email>');
    console.log(await generatePilotInvite(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
