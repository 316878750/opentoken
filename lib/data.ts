import { PGlite } from '@electric-sql/pglite';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const userId = '30000000-0000-4000-8000-000000000001';
const directory = resolve(process.env.DEMO_DATA_DIR || '.demo-data');
const globals = globalThis as typeof globalThis & { demoStore?: ReturnType<typeof initialize> };

async function initialize() {
  await mkdir(directory, { recursive: true });
  const pepperPath = join(directory, 'demo.secret');
  try { await writeFile(pepperPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const pepper = await readFile(pepperPath);
  const db = await PGlite.create(join(directory, 'postgres'));
  await db.exec('CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY)');
  if (!(await db.query("SELECT 1 FROM pg_namespace WHERE nspname='gateway'")).rows.length) {
    await db.exec(await readFile(join(process.cwd(), 'replica', 'schema.sql'), 'utf8'));
  }
  await db.transaction(async tx => {
    await tx.query('INSERT INTO auth.users VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    const wallet = await tx.query('INSERT INTO gateway.wallets (user_id,balance_micros) VALUES ($1,10000000) ON CONFLICT DO NOTHING RETURNING id', [userId]);
    if (wallet.rows.length) {
      const seed = await tx.query<{id: string}>(`INSERT INTO gateway.redeem_codes (secret_digest,amount_micros,expires_at)
        VALUES ($1,10000000,now()+interval '1 day') RETURNING id`, [randomBytes(32)]);
      await tx.query("INSERT INTO gateway.wallet_entries (user_id,redeem_code_id,kind,delta_micros) VALUES ($1,$2,'redemption',10000000)", [userId, seed.rows[0].id]);
    }
    await tx.exec(`
      INSERT INTO gateway.pricing_groups (code,name) VALUES ('demo','演示分组') ON CONFLICT DO NOTHING;
      INSERT INTO gateway.models (code,upstream_model,max_context_tokens,max_output_tokens)
        VALUES ('mock-text','mock-text',1000,128) ON CONFLICT DO NOTHING;
      INSERT INTO gateway.model_rates (group_id,model_id,input_micros_per_mtok,cached_input_micros_per_mtok,output_micros_per_mtok,multiplier_bps)
        SELECT g.id,m.id,1872000000,500000000,1000000000,10000
        FROM gateway.pricing_groups g CROSS JOIN gateway.models m
        WHERE g.code='demo' AND m.code='mock-text' ON CONFLICT DO NOTHING;
      UPDATE gateway.usage_requests SET status='review',terminal_reason='process_interrupted',updated_at=now()
        WHERE status IN ('reserved','dispatched');
    `);
  });
  return { db, pepper };
}

export function store() {
  return globals.demoStore ??= initialize();
}

export async function digest(namespace: string, value: string) {
  return createHmac('sha256', (await store()).pepper).update(namespace + '\0' + value).digest();
}

export { userId };
