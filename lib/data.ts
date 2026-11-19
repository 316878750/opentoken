import { createHmac } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

const globals = globalThis as typeof globalThis & { opentokenPool?: Pool };

export function store() {
  if (!globals.opentokenPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    const url = new URL(connectionString);
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
    const query = [...url.searchParams];
    if (url.hash || query.length>1 || query.some(([key,value]) => key!=='sslmode' || value!=='verify-full')) {
      throw new Error('Use a plain PostgreSQL URI with at most one sslmode=verify-full');
    }
    if (!local && (url.searchParams.get('sslmode') !== 'verify-full' ||
      decodeURIComponent(url.username).split('.')[0] !== 'opentoken_app')) {
      throw new Error('Use the opentoken_app role and sslmode=verify-full');
    }
    const pool = new Pool({connectionString,max:5,connectionTimeoutMillis:5000,statement_timeout:8000});
    pool.on('error', () => console.error('Idle PostgreSQL connection failed'));
    globals.opentokenPool = pool;
  }
  return {db:globals.opentokenPool};
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await store().db.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}

export function digest(namespace: string, value: string) {
  const secret = process.env.GATEWAY_SECRET || '';
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('GATEWAY_SECRET must be 32 bytes in hex');
  return createHmac('sha256',Buffer.from(secret,'hex')).update(namespace+'\0'+value).digest();
}

export async function ensureWallet(userId: string) {
  await store().db.query('INSERT INTO gateway.wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING',[userId]);
}
