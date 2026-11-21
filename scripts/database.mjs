import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { postgresConnectionOptions } from '../lib/postgres-config.mjs';
import { resolveLiveUpstreams } from '../lib/upstream-config.mjs';
import { adminCommand } from './admin.mjs';
import { billingCommand, scanBilling } from './billing.mjs';
import { redeemCommand } from './redeem.mjs';
import { stripeCommand } from './stripe-ops.mjs';
import { paidPilotCommand } from './paid-pilot.mjs';

function connection(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  const config = postgresConnectionOptions(value,{application:name==='DATABASE_URL'});
  return new Client({...config,connectionTimeoutMillis:8000,statement_timeout:15000});
}

async function inTransaction(client,work) {
  await client.query('BEGIN');
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function migrate(client) {
  await inTransaction(client,async () => {
    await client.query('SELECT pg_advisory_xact_lock(961020031)');
    const { rows:[version] } = await client.query("SELECT to_regnamespace('gateway') AS schema,to_regclass('gateway.schema_migrations') AS table");
    if (!version.schema) {
      const source = await readFile(new URL('../replica/schema.sql',import.meta.url),'utf8');
      await client.query(source.replace(/^BEGIN;\r?$/m,'').replace(/^COMMIT;\r?$/m,''));
      await client.query('CREATE TABLE gateway.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      await client.query("INSERT INTO gateway.schema_migrations(version) VALUES ('001')");
    } else if (!version.table || !(await client.query("SELECT 1 FROM gateway.schema_migrations WHERE version='001'")).rowCount) {
      throw new Error('The existing gateway schema has no known migration marker');
    }
    const { rowCount } = await client.query(`SELECT 1 FROM pg_roles
      WHERE rolname='opentoken_app' AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolinherit AND NOT rolbypassrls`);
    if (!rowCount) throw new Error('Create a restricted opentoken_app login role before migrating');
    for (const [version,file] of [['002','002-billing-reconciliation.sql'],['003','003-billing-maintenance-recovery.sql'],
      ['004','004-trial-redemption.sql'],['005','005-stripe-sandbox.sql'],['006','006-stripe-reconciliation.sql'],
      ['007','007-paid-pilot-preparation.sql'],['008','008-admin-access.sql'],['009','009-admin-redeem-codes.sql'],
      ['010','010-managed-channels.sql'],['011','011-admin-models.sql'],['012','012-admin-users.sql']]) {
      if ((await client.query('SELECT 1 FROM gateway.schema_migrations WHERE version=$1',[version])).rowCount) continue;
      const source = await readFile(new URL('../replica/migrations/'+file,import.meta.url),'utf8');
      await client.query(source);
      await client.query('INSERT INTO gateway.schema_migrations(version) VALUES ($1)',[version]);
    }
    await client.query(`
      REVOKE ALL ON SCHEMA gateway FROM PUBLIC;
      GRANT USAGE ON SCHEMA gateway TO opentoken_app;
      GRANT SELECT ON gateway.pricing_groups,gateway.models,gateway.model_rates TO opentoken_app;
      GRANT SELECT,INSERT,UPDATE ON gateway.api_keys,gateway.usage_requests TO opentoken_app;
      REVOKE INSERT,UPDATE ON gateway.wallets FROM opentoken_app;
      GRANT SELECT ON gateway.wallets TO opentoken_app;
      GRANT INSERT (user_id),UPDATE (balance_micros,held_micros,updated_at) ON gateway.wallets TO opentoken_app;
      REVOKE INSERT ON gateway.wallet_entries FROM opentoken_app;
      GRANT SELECT ON gateway.wallet_entries TO opentoken_app;
      GRANT INSERT (user_id,request_id,kind,delta_micros) ON gateway.wallet_entries TO opentoken_app;
    `);
  });
}

export async function seed(client,email,providers=resolveLiveUpstreams()) {
  await inTransaction(client,async () => {
    await client.query('SELECT pg_advisory_xact_lock(961020031)');
    await client.query('SELECT pg_advisory_xact_lock(961020036)');
    const {rows:[{managed}]} = await client.query("SELECT to_regclass('gateway.channel_routes') IS NOT NULL AS managed");
    await client.query(`
      INSERT INTO gateway.pricing_groups (code,name) VALUES ('pilot','试点分组') ON CONFLICT DO NOTHING;
      INSERT INTO gateway.models (code,upstream_model,max_context_tokens,max_output_tokens) VALUES
        ('mock-text','mock-text',1000,128),
        ('openai-mini','gpt-5.4-mini-2026-03-17',400000,128)
      ON CONFLICT DO NOTHING;
      INSERT INTO gateway.model_rates (group_id,model_id,input_micros_per_mtok,cached_input_micros_per_mtok,output_micros_per_mtok,multiplier_bps)
        SELECT g.id,m.id,p.input,p.cached,p.output,10000
        FROM gateway.pricing_groups g CROSS JOIN
          (VALUES ('mock-text',1872000000,500000000,1000000000),('openai-mini',750000,75000,4500000))
            AS p(code,input,cached,output) JOIN gateway.models m ON m.code=p.code
        WHERE g.code='pilot' ON CONFLICT DO NOTHING;
    `);
    for (const live of providers.filter(provider=>provider.mode==='compatible')) {
      await client.query(`INSERT INTO gateway.models (code,upstream_model,max_context_tokens,max_output_tokens)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[live.alias,live.model,live.maxContextTokens,live.maxOutputTokens]);
      const {rows:[model]} = await client.query(`SELECT id,upstream_model,max_context_tokens,max_output_tokens,
        coalesce((to_jsonb(m)->>'admin_managed')::boolean,false) AS admin_managed
        FROM gateway.models m WHERE code=$1`,[live.alias]);
      if (model.admin_managed) continue;
      for (const group of live.groups) {
        if (managed && (await client.query(`SELECT 1 FROM gateway.channel_routes p JOIN gateway.pricing_groups g ON g.id=p.group_id
          WHERE p.model_id=$1 AND g.code=$2`,[model.id,group.code])).rowCount) continue;
        if (model.upstream_model!==live.model || model.max_context_tokens!==live.maxContextTokens ||
          model.max_output_tokens!==live.maxOutputTokens) throw new Error('The compatible alias already belongs to a different model or context limit');
        await client.query('INSERT INTO gateway.pricing_groups (code,name) VALUES ($1,$2) ON CONFLICT DO NOTHING',[group.code,group.name]);
        const {rows:[storedGroup]} = await client.query(`SELECT id,name,coalesce((to_jsonb(g)->>'admin_managed')::boolean,false) AS admin_managed
          FROM gateway.pricing_groups g WHERE code=$1`,[group.code]);
        if (!storedGroup.admin_managed && group.code!=='pilot' && storedGroup.name!==group.name) {
          throw new Error('The pricing group already uses a different name');
        }
        const {rows:[current]} = await client.query(`SELECT id,input_micros_per_mtok::text AS input,
          cached_input_micros_per_mtok::text AS cached,output_micros_per_mtok::text AS output,multiplier_bps
          FROM gateway.model_rates WHERE group_id=$1 AND model_id=$2 AND closed_at IS NULL`,[storedGroup.id,model.id]);
        if (current && current.input===live.inputMicros && current.cached===live.cacheMicros &&
          current.output===live.outputMicros && current.multiplier_bps===group.multiplierBps) continue;
        if (current) await client.query('UPDATE gateway.model_rates SET closed_at=now(),updated_at=now() WHERE id=$1',[current.id]);
        await client.query(`INSERT INTO gateway.model_rates
          (group_id,model_id,input_micros_per_mtok,cached_input_micros_per_mtok,output_micros_per_mtok,multiplier_bps)
          VALUES ($1,$2,$3,$4,$5,$6)`,[storedGroup.id,model.id,live.inputMicros,live.cacheMicros,live.outputMicros,group.multiplierBps]);
      }
    }
    if (!email) return;
    const { rows } = await client.query('SELECT id FROM auth.users WHERE lower(email)=lower($1) AND email_confirmed_at IS NOT NULL',[email]);
    if (rows.length!==1) throw new Error('PILOT_EMAIL must identify one verified Supabase Auth user');
    const id = rows[0].id;
    await client.query('INSERT INTO gateway.wallets(user_id) VALUES ($1) ON CONFLICT DO NOTHING',[id]);
    await client.query('SELECT 1 FROM gateway.wallets WHERE user_id=$1 FOR UPDATE',[id]);
    const marker = createHash('sha256').update('opentoken:pilot-credit:v1:'+id).digest();
    const { rows:[credit] } = await client.query(`INSERT INTO gateway.redeem_codes(secret_digest,amount_micros,expires_at)
      VALUES ($1,10000000,now()+interval '1 day') ON CONFLICT DO NOTHING RETURNING id`,[marker]);
    if (!credit) return;
    await client.query("INSERT INTO gateway.wallet_entries(user_id,redeem_code_id,kind,delta_micros) VALUES ($1,$2,'redemption',10000000)",[id,credit.id]);
    await client.query('UPDATE gateway.wallets SET balance_micros=balance_micros+10000000,updated_at=now() WHERE user_id=$1',[id]);
  });
}

export async function check(client) {
  const { rows:[result] } = await client.query(`SELECT current_user AS role,
    NOT has_schema_privilege(current_user,'gateway','CREATE') AS schema_readonly,
    has_table_privilege(current_user,'gateway.wallets','SELECT') AS wallet_read,
    has_column_privilege(current_user,'gateway.wallets','user_id','INSERT') AS wallet_insert,
    (has_column_privilege(current_user,'gateway.wallets','balance_micros','UPDATE')
      AND has_column_privilege(current_user,'gateway.wallets','held_micros','UPDATE')) AS wallet_update,
    NOT has_column_privilege(current_user,'gateway.wallets','refund_held_micros','INSERT,UPDATE') AS refund_hold_private,
    (has_column_privilege(current_user,'gateway.wallet_entries','user_id','INSERT')
      AND has_column_privilege(current_user,'gateway.wallet_entries','request_id','INSERT')
      AND has_column_privilege(current_user,'gateway.wallet_entries','kind','INSERT')
      AND has_column_privilege(current_user,'gateway.wallet_entries','delta_micros','INSERT')) AS entry_insert,
    NOT has_column_privilege(current_user,'gateway.wallet_entries','redeem_code_id','INSERT') AS redemption_insert_private,
    NOT has_table_privilege(current_user,'gateway.wallet_entries','UPDATE,DELETE,TRUNCATE') AS entry_immutable,
    NOT has_table_privilege(current_user,'gateway.model_rates','INSERT,UPDATE,DELETE,TRUNCATE') AS rates_immutable,
    NOT has_table_privilege(current_user,'gateway.models','INSERT,UPDATE,DELETE,TRUNCATE') AS models_private,
    NOT has_table_privilege(current_user,'gateway.pricing_groups','INSERT,UPDATE,DELETE,TRUNCATE') AS pricing_groups_private,
    has_function_privilege(current_user,'gateway.admin_write_model(uuid,uuid,text,jsonb,boolean,jsonb)','EXECUTE') AS admin_model_write,
    NOT has_table_privilege(current_user,'gateway.account_states','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS account_states_private,
    NOT has_table_privilege(current_user,'gateway.admin_user_invites','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS user_invites_private,
    has_function_privilege(current_user,'gateway.account_access(uuid)','EXECUTE') AS account_access,
    has_function_privilege(current_user,'gateway.admin_list_users(uuid,text,text,uuid,integer)','EXECUTE') AS admin_user_list,
    has_function_privilege(current_user,'gateway.admin_write_user(uuid,uuid,uuid,text,jsonb,boolean)','EXECUTE') AS admin_user_write,
    has_function_privilege(current_user,'gateway.admin_begin_user_invite(uuid,uuid,uuid,text,bytea)','EXECUTE') AS admin_invite_begin,
    has_function_privilege(current_user,'gateway.admin_finish_user_invite(uuid,uuid,uuid,text)','EXECUTE') AS admin_invite_finish,
    NOT has_function_privilege(current_user,'gateway.reconcile_user_invite(uuid,text,bytea)','EXECUTE') AS invite_reconcile_private,
    NOT has_table_privilege(current_user,'gateway.billing_resolutions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS resolutions_private,
    NOT has_table_privilege(current_user,'gateway.billing_alerts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS alerts_private,
    NOT has_function_privilege(current_user,'gateway.resolve_billing_request(uuid,text,text,text,integer,integer,integer)','EXECUTE') AS resolve_private,
    NOT has_function_privilege(current_user,'gateway.run_billing_maintenance()','EXECUTE') AS maintenance_private,
    has_function_privilege(current_user,'gateway.redeem_trial_credit(uuid,bytea)','EXECUTE') AS redemption_execute,
    NOT has_function_privilege(current_user,'gateway.redeem_trial_credit_base(uuid,bytea)','EXECUTE') AS redemption_base_private,
    has_function_privilege(current_user,'gateway.admin_issue_redeem(uuid,uuid,bytea,bigint,timestamptz,bigint,bigint)','EXECUTE') AS admin_redeem_issue,
    has_function_privilege(current_user,'gateway.admin_void_redeem(uuid,uuid)','EXECUTE') AS admin_redeem_void,
    has_function_privilege(current_user,'gateway.admin_list_redeem(uuid,text,uuid)','EXECUTE') AS admin_redeem_list,
    NOT has_function_privilege(current_user,'gateway.audit_redeem_admin(uuid,text,text,text,jsonb)','EXECUTE') AS redeem_audit_private,
    NOT has_table_privilege(current_user,'gateway.redeem_codes','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS redeem_codes_private,
    NOT has_table_privilege(current_user,'gateway.redeem_attempts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS redeem_attempts_private,
    NOT has_table_privilege(current_user,'gateway.stripe_sandbox','INSERT,UPDATE,DELETE,TRUNCATE') AS stripe_sandbox_private,
    NOT has_function_privilege(current_user,'gateway.approve_stripe_refund(uuid,uuid,integer,text)','EXECUTE') AS refund_approval_private,
    NOT has_table_privilege(current_user,'gateway.admin_roles','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS admin_roles_private,
    NOT has_table_privilege(current_user,'gateway.admin_eligible_accounts','SELECT') AS admin_eligibility_private,
    NOT has_table_privilege(current_user,'gateway.admin_audit_events','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS admin_audit_private,
    NOT has_table_privilege(current_user,'gateway.login_events','SELECT,UPDATE,DELETE,TRUNCATE') AS login_events_immutable,
    has_column_privilege(current_user,'gateway.login_events','request_id','INSERT') AS login_events_append,
    has_function_privilege(current_user,'gateway.admin_role_for(uuid)','EXECUTE') AS admin_role_lookup,
    has_function_privilege(current_user,'gateway.authorize_admin(uuid,uuid,text)','EXECUTE') AS admin_access_audit,
    NOT has_function_privilege(current_user,'gateway.set_admin_role(uuid,text,text)','EXECUTE') AS admin_role_change_private,
    NOT coalesce((SELECT has_table_privilege(current_user,c.oid,'SELECT')
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='auth' AND c.relname='users'),true) AS auth_private`);
  if (result.role!=='opentoken_app' || Object.entries(result).some(([field,value])=>field!=='role' && value!==true)) {
    throw new Error('Application role privileges do not match the required restrictions');
  }
}

export async function enableStripeSandbox(client) {
  await inTransaction(client,async () => {
    await client.query('SELECT pg_advisory_xact_lock(961020032)');
    const {rows:[{managed}]} = await client.query("SELECT to_regclass('gateway.channel_probes') IS NOT NULL AS managed");
    if (managed && (await client.query('SELECT 1 FROM gateway.channel_probes LIMIT 1')).rowCount) {
      throw new Error('Use a separate database without real upstream use for Stripe testing');
    }
    const {rows:[{has_live_usage}]} = await client.query(`SELECT EXISTS (
      SELECT 1 FROM gateway.usage_requests u JOIN gateway.models m ON m.id=u.model_id WHERE m.code <> 'mock-text'
    ) AS has_live_usage`);
    if (has_live_usage) throw new Error('Use a separate database without real upstream use for Stripe testing');
    await client.query('INSERT INTO gateway.stripe_sandbox(enabled) VALUES (true) ON CONFLICT DO NOTHING');
  });
}

async function main() {
  const [, , action, ...args] = process.argv;
  if (!['migrate','seed','check','review-stale','billing','redeem','stripe-sandbox','stripe','paid-pilot','admin'].includes(action)) {
    throw new Error('Expected migrate, seed, check, review-stale, billing, redeem, stripe-sandbox, stripe, paid-pilot, or admin');
  }
  const client = connection(action==='check' ? 'DATABASE_URL' : 'MIGRATION_DATABASE_URL');
  try {
    await client.connect();
    if (action==='migrate') { await migrate(client); console.log('Migrations 001–012 ready.'); }
    if (action==='seed') {
      await seed(client,process.env.PILOT_EMAIL?.trim());
      console.log(process.env.PILOT_EMAIL?.trim() ? 'Model catalog and one-time pilot credit ready.' : 'Model catalog ready.');
    }
    if (action==='check') { await check(client); console.log('PostgreSQL role and table access checks passed.'); }
    if (action==='review-stale') console.log(JSON.stringify(await scanBilling(client)));
    if (action==='billing') console.log(JSON.stringify(await billingCommand(client,args),null,2));
    if (action==='redeem') console.log(JSON.stringify(await redeemCommand(client,args),null,2));
    if (action==='admin') console.log(JSON.stringify(await adminCommand(client,args),null,2));
    if (action==='stripe') {
      const result=await stripeCommand(client,args);
      console.log(JSON.stringify(result,null,2));
      if (result.issues?.length) process.exitCode=1;
    }
    if (action==='paid-pilot') {
      const result=await paidPilotCommand(client,args);
      console.log(JSON.stringify(result,null,2));
      if (args[0]==='preflight' && !result.ready) process.exitCode=1;
    }
    if (action==='stripe-sandbox') { await enableStripeSandbox(client); console.log('Stripe sandbox enabled. Real upstream routes are disabled for this database.'); }
  } finally { await client.end(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  main().catch(error => {
    const message = error.code && error.code !== 'P0001' ? 'SQLSTATE '+error.code : error.message;
    console.error('Database command failed:',message);
    process.exitCode=1;
  });
}
