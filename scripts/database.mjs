import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';

function connection(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Use a PostgreSQL connection string');
  const query = [...url.searchParams];
  if (url.hash || query.length>1 || query.some(([key,value]) => key!=='sslmode' || value!=='verify-full')) {
    throw new Error('Use a plain PostgreSQL URI with at most one sslmode=verify-full');
  }
  if (!['127.0.0.1','localhost'].includes(url.hostname) && url.searchParams.get('sslmode')!=='verify-full') {
    throw new Error('Use sslmode=verify-full for remote PostgreSQL');
  }
  return new Client({connectionString:value,connectionTimeoutMillis:8000,statement_timeout:15000});
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
    await client.query(`
      REVOKE ALL ON SCHEMA gateway FROM PUBLIC;
      GRANT USAGE ON SCHEMA gateway TO opentoken_app;
      GRANT SELECT ON gateway.pricing_groups,gateway.models,gateway.model_rates TO opentoken_app;
      GRANT SELECT,INSERT,UPDATE ON gateway.wallets,gateway.api_keys,gateway.usage_requests TO opentoken_app;
      GRANT SELECT,INSERT ON gateway.wallet_entries TO opentoken_app;
    `);
  });
}

export async function seed(client,email) {
  await inTransaction(client,async () => {
    await client.query('SELECT pg_advisory_xact_lock(961020031)');
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
    has_table_privilege(current_user,'gateway.wallets','INSERT') AS wallet_insert,
    has_table_privilege(current_user,'gateway.wallets','UPDATE') AS wallet_update,
    has_table_privilege(current_user,'gateway.wallet_entries','INSERT') AS entry_insert,
    NOT has_table_privilege(current_user,'gateway.wallet_entries','UPDATE,DELETE,TRUNCATE') AS entry_immutable,
    NOT has_table_privilege(current_user,'gateway.model_rates','INSERT,UPDATE,DELETE,TRUNCATE') AS rates_immutable,
    NOT coalesce((SELECT has_table_privilege(current_user,c.oid,'SELECT')
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='auth' AND c.relname='users'),true) AS auth_private`);
  if (result.role!=='opentoken_app' || Object.entries(result).some(([field,value])=>field!=='role' && value!==true)) {
    throw new Error('Application role privileges do not match the required restrictions');
  }
}

async function main() {
  const action = process.argv[2];
  if (!['migrate','seed','check','review-stale'].includes(action)) throw new Error('Expected migrate, seed, check, or review-stale');
  const client = connection(action==='check' ? 'DATABASE_URL' : 'MIGRATION_DATABASE_URL');
  try {
    await client.connect();
    if (action==='migrate') { await migrate(client); console.log('Migration 001 ready.'); }
    if (action==='seed') {
      await seed(client,process.env.PILOT_EMAIL?.trim());
      console.log(process.env.PILOT_EMAIL?.trim() ? 'Model catalog and one-time pilot credit ready.' : 'Model catalog ready.');
    }
    if (action==='check') { await check(client); console.log('PostgreSQL role and table access checks passed.'); }
    if (action==='review-stale') {
      const { rowCount } = await client.query(`UPDATE gateway.usage_requests SET status='review',terminal_reason='dispatch_interrupted',updated_at=now()
        WHERE status IN ('dispatched','reserved') AND updated_at<now()-interval '2 minutes'`);
      console.log('Requests moved to review:',rowCount);
    }
  } finally { await client.end(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  main().catch(error => { console.error('Database command failed:',error.code ? 'SQLSTATE '+error.code : error.message); process.exitCode=1; });
}
