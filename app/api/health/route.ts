import { NextResponse, type NextRequest } from 'next/server';
import { digest, store } from '@/lib/data';
import { channelCredentials } from '@/lib/channel-credentials';
import { appOrigin } from '@/lib/session';
import { resolveLiveUpstreams } from '@/lib/upstream-config.mjs';

export const dynamic = 'force-dynamic';

let probe: {expiresAt:number; result:Promise<boolean>} | undefined;

async function checkDatabase() {
  const {rows:[row]} = await store().db.query<{ready:boolean}>(`SELECT
    to_regclass('gateway.stripe_sandbox') IS NOT NULL AND
    has_column_privilege(to_regclass('gateway.wallets'),'refund_held_micros','SELECT') AND
    has_function_privilege(to_regprocedure('gateway.sandbox_billing_limits(uuid)'),'EXECUTE') AND
    has_table_privilege(to_regclass('gateway.wallets'),'SELECT') AND
    has_function_privilege(to_regprocedure('gateway.redeem_trial_credit(uuid,bytea)'),'EXECUTE') AND
    has_column_privilege(to_regclass('gateway.login_events'),'request_id','INSERT') AND
    has_function_privilege(to_regprocedure('gateway.admin_role_for(uuid)'),'EXECUTE') AND
    has_function_privilege(to_regprocedure('gateway.authorize_admin(uuid,uuid,text)'),'EXECUTE') AND
    has_table_privilege(to_regclass('gateway.channel_runtime_routes'),'SELECT') AND
    has_column_privilege(to_regclass('gateway.models'),'admin_managed','SELECT') AND
    has_column_privilege(to_regclass('gateway.channel_probes'),'cache_usage_verified','UPDATE') AND
    has_function_privilege(to_regprocedure('gateway.can_manage_model(uuid)'),'EXECUTE') AND
    has_function_privilege(to_regprocedure('gateway.admin_write_model(uuid,uuid,text,jsonb,boolean,jsonb)'),'EXECUTE') AND
    has_function_privilege(to_regprocedure('gateway.account_access(uuid)'),'EXECUTE') AND
    has_function_privilege(to_regprocedure('gateway.admin_list_users(uuid,text,text,uuid,integer)'),'EXECUTE') AND
    has_function_privilege(to_regprocedure('gateway.admin_write_user(uuid,uuid,uuid,text,jsonb,boolean)'),'EXECUTE') AND
    has_function_privilege(to_regprocedure('gateway.admin_begin_user_invite(uuid,uuid,uuid,text,bytea)'),'EXECUTE') AND
    has_function_privilege(to_regprocedure('gateway.admin_finish_user_invite(uuid,uuid,uuid,text)'),'EXECUTE') AND
    has_function_privilege(to_regprocedure('gateway.admin_list_login_events(uuid,jsonb)'),'EXECUTE') AND
    has_function_privilege(to_regprocedure('gateway.site_display()'),'EXECUTE') AND
    has_function_privilege(to_regprocedure('gateway.write_settings(uuid,integer,integer,jsonb,text,boolean,bigint,bigint)'),'EXECUTE') AND
    has_function_privilege(to_regprocedure('gateway.admin_settings(uuid,bigint,bigint,integer)'),'EXECUTE') AND
    has_function_privilege(to_regprocedure('gateway.admin_list_operation_events(uuid,jsonb)'),'EXECUTE') AND
    EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass('gateway.account_states')
      AND attname='deleted_at' AND NOT attisdropped) AS ready`);
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
  channelCredentials();
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
