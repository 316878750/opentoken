import { NextResponse, type NextRequest } from 'next/server';
import { digest, store } from '@/lib/data';
import { appOrigin } from '@/lib/session';
import { resolveLiveUpstreams } from '@/lib/upstream-config.mjs';

export const dynamic = 'force-dynamic';

let probe: {expiresAt:number; result:Promise<boolean>} | undefined;

async function checkDatabase() {
  const {rows:[row]} = await store().db.query<{ready:boolean}>(`SELECT
    to_regclass('gateway.stripe_sandbox') IS NOT NULL AND
    has_table_privilege(to_regclass('gateway.wallets'),'SELECT') AND
    has_function_privilege(to_regprocedure('gateway.redeem_trial_credit(uuid,bytea)'),'EXECUTE') AS ready`);
  if (!row.ready) throw new Error('Gateway schema is unavailable');
}

async function checkAuth() {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!key || !process.env.SUPABASE_URL) throw new Error('Auth is unavailable');
  const endpoint = new URL('/auth/v1/settings',process.env.SUPABASE_URL);
  const local = endpoint.protocol==='http:' && endpoint.hostname==='127.0.0.1';
  if ((!local && endpoint.protocol!=='https:') || endpoint.username || endpoint.password) throw new Error('Invalid Auth origin');
  const response = await fetch(endpoint,{headers:{apikey:key},redirect:'error',cache:'no-store',
    signal:AbortSignal.timeout(4000)});
  if (response.ok && process.env.APP_ORIGIN?.startsWith('https://')) {
    const settings = await response.json();
    if (settings?.disable_signup!==true) throw new Error('Hosted pilot requires disabled public signup');
  } else {
    await response.body?.cancel().catch(()=>{});
    if (!response.ok) throw new Error('Auth is unavailable');
  }
}

async function checkRuntime() {
  digest('health','readiness');
  resolveLiveUpstreams();
}

function ready() {
  const now = Date.now();
  if (!probe || now>=probe.expiresAt) {
    const result = Promise.allSettled([checkDatabase(),checkAuth(),checkRuntime()]).then(([database,auth,runtime])=>{
      const healthy = [database,auth,runtime].every(check=>check.status==='fulfilled');
      if (!healthy) console.error('OpenToken readiness failed',{database:database.status,auth:auth.status,runtime:runtime.status});
      return healthy;
    });
    probe = {result,expiresAt:now+15_000};
  }
  return probe.result;
}

export async function GET(request:NextRequest) {
  const headers = {'Cache-Control':'no-store'};
  if (!appOrigin(request)) return NextResponse.json({status:'unavailable'},{status:403,headers});
  const ok = await ready();
  return NextResponse.json({status:ok?'ok':'unavailable'},{status:ok?200:503,headers});
}
