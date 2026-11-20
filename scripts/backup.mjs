import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';

const magic = Buffer.from('OPENTOKEN-BACKUP-1\n');
const archiveMagic = Buffer.from('PGDMP');
const maxBytes = 256 * 1024 * 1024;
const restoreErrors = new Map([
  ['PBR01', 'PostgreSQL major version does not match the backup'],
  ['PBR02', 'Unexpected database table inventory'],
  ['PBR03', 'OpenToken migration versions do not match the backup'],
  ['PBR04', 'The recovery database must be empty except for migration records'],
  ['PBR05', 'Restored data differs from the source snapshot'],
  ['55P03', 'Recovery tables could not be locked. Disconnect other clients and retry'],
]);
const tables = [
  'auth.identities', 'auth.users', 'gateway.api_keys', 'gateway.billing_alerts',
  'gateway.billing_resolutions', 'gateway.model_rates', 'gateway.models', 'gateway.pricing_groups',
  'gateway.redeem_attempts', 'gateway.redeem_codes', 'gateway.schema_migrations',
  'gateway.usage_requests', 'gateway.wallet_entries', 'gateway.wallets',
];
const formats = `SET TIME ZONE 'UTC'; SET DateStyle TO 'ISO, YMD';
  SET bytea_output TO 'hex'; SET extra_float_digits TO 3; SET IntervalStyle TO 'postgres';`;
const inventory = `SELECT n.nspname || '.' || c.relname AS name
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','f') AND (n.nspname='gateway' OR
    (n.nspname='auth' AND c.relname IN ('users','identities')))`;
const migrationVersions = `(SELECT jsonb_agg(version ORDER BY version) FROM gateway.schema_migrations)`;
const fingerprint = `SELECT jsonb_build_object('versions', ${migrationVersions},
  'tables', jsonb_build_object(${tables.map(table => `'${table}', (SELECT jsonb_build_array(count(*)::text,
    coalesce(encode(sha256(convert_to(string_agg(digest,' ' ORDER BY digest COLLATE "C"),'UTF8')),'hex'), ''))
    FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest FROM ${table} t) fingerprints)`).join(',\n')}),
  'accountingIssues', (SELECT count(*)::int FROM (
    SELECT w.user_id FROM gateway.wallets w LEFT JOIN (
      SELECT user_id,sum(delta_micros) AS balance FROM gateway.wallet_entries GROUP BY user_id
    ) l USING (user_id) LEFT JOIN (
      SELECT user_id,sum(reserved_micros) AS held FROM gateway.usage_requests
      WHERE status IN ('reserved','dispatched','review') GROUP BY user_id
    ) h USING (user_id) WHERE w.balance_micros<>coalesce(l.balance,0) OR w.held_micros<>coalesce(h.held,0)
    UNION ALL
    SELECT k.id FROM gateway.api_keys k LEFT JOIN (
      SELECT key_id,sum(reserved_micros) FILTER (WHERE status IN ('reserved','dispatched','review')) AS held,
        sum(charged_micros) FILTER (WHERE status='settled') AS spent FROM gateway.usage_requests GROUP BY key_id
    ) u ON u.key_id=k.id WHERE k.held_micros<>coalesce(u.held,0) OR k.spent_micros<>coalesce(u.spent,0)
    UNION ALL
    SELECT u.id FROM gateway.usage_requests u LEFT JOIN gateway.wallet_entries e ON e.request_id=u.id
    WHERE (u.status='settled' AND e.delta_micros IS DISTINCT FROM -u.charged_micros)
      OR (u.status<>'settled' AND e.request_id IS NOT NULL)
  ) issues)) AS fingerprint`;

export function encodeBackup(key, manifest, archive) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(magic);
  return Buffer.concat([magic, nonce, cipher.update(JSON.stringify(manifest) + '\n', 'utf8'),
    cipher.update(archive), cipher.final(), cipher.getAuthTag()]);
}

export function decodeBackup(key, encrypted) {
  let plain;
  try {
    if (encrypted.length < magic.length + 29 || !encrypted.subarray(0, magic.length).equals(magic)) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(magic.length, magic.length + 12));
    decipher.setAAD(magic);
    decipher.setAuthTag(encrypted.subarray(-16));
    plain = Buffer.concat([decipher.update(encrypted.subarray(magic.length + 12, -16)), decipher.final()]);
  } catch {
    throw new Error('Unable to authenticate the backup with this key');
  }
  const boundary = plain.indexOf(10);
  if (boundary < 1 || !plain.subarray(boundary + 1, boundary + 1 + archiveMagic.length).equals(archiveMagic)) {
    throw new Error('The authenticated backup contains an invalid PostgreSQL archive');
  }
  return {manifest:JSON.parse(plain.subarray(0, boundary).toString('utf8')), archive:plain.subarray(boundary + 1)};
}

export function postgresEndpoint(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('A PostgreSQL database URI is required'); }
  const query = [...url.searchParams];
  const database = decodeURIComponent(url.pathname.slice(1));
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || !user || !database ||
      url.hash || /[\u0000-\u001f]/.test(database + user + password) || database.includes('/') ||
      query.length > 1 || query.some(([key]) => key !== 'sslmode')) {
    throw new Error('Use a plain PostgreSQL URI with optional sslmode=verify-full');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local = ['localhost','127.0.0.1','::1'].includes(host);
  if ((!local || query.length) && url.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('Use sslmode=verify-full for remote PostgreSQL');
  }
  const port = Number(url.port || 5432);
  const project = /^db\.([a-z]{20})\.supabase\.co$/.exec(host)?.[1] ??
    (host.endsWith('.pooler.supabase.com') ? /^postgres\.([a-z]{20})$/.exec(user)?.[1] : undefined);
  const identity = createHash('sha256').update(JSON.stringify([project || (local ? 'loopback' : host), port, database])).digest('hex');
  return {host, port, database, user, password, local, project, identity, ssl:!local || query.length > 0};
}

export function restoreTarget(value, source, confirmedProject) {
  const target = postgresEndpoint(value);
  if (target.identity === source.identity || (target.project && target.project === source.project)) {
    throw new Error('Restore cannot target the source project or database');
  }
  if (target.local) {
    if (!/^opentoken_restore_[a-z0-9_]+$/.test(target.database)) throw new Error('Use an isolated database named opentoken_restore_*');
  } else if (!target.project || !source.project || target.database !== 'postgres') {
    throw new Error('Remote restore requires a new Supabase project with an empty postgres database');
  } else if (confirmedProject !== target.project) {
    throw new Error('Explicitly confirm the new Supabase project reference');
  }
  return target;
}

function runTool(tool, args, env = {}, input) {
  const binary = process.env.BACKUP_PG_BIN ? join(process.env.BACKUP_PG_BIN, tool) : tool;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|systemdrive|windir|tmp|temp|home|userprofile|lang|lc_all|ld_library_path)$/i.test(key)));
  return new Promise((resolveTool, reject) => {
    const child = spawn(binary, args, {env:{...inherited, ...env}, windowsHide:true,
      signal:AbortSignal.timeout(240000), stdio:['pipe','pipe',tool === 'psql' ? 'pipe' : 'ignore']});
    const chunks = [];
    let length = 0;
    let diagnostics = '';
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > maxBytes) {
        child.kill();
        reject(new Error(`${tool} output exceeds the pilot backup size limit`));
      } else chunks.push(chunk);
    });
    child.stderr?.on('data', chunk => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-8192); });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') reject(new Error(`Unable to send input to ${tool}`));
    });
    child.on('error', error => reject(new Error(error.code === 'ABORT_ERR' ? `${tool} timed out` :
      `Unable to start ${tool} (${error.code}); check BACKUP_PG_BIN`)));
    child.on('close', code => {
      if (code === 0) return resolveTool(Buffer.concat(chunks));
      const sqlstate = /\bERROR:\s+([A-Z0-9]{5})\b/.exec(diagnostics)?.[1];
      reject(new Error(restoreErrors.get(sqlstate) ||
        `${tool} failed (exit ${code}); check the client version, database connection and preparation`));
    });
    child.stdin.end(input);
  });
}

async function connectionSettings(endpoint) {
  const {host, port, database, user, password, ssl} = endpoint;
  const cert = ssl ? process.env.BACKUP_PG_SSL_ROOT_CERT || '.env.supabase-ca.pem' : '';
  const ca = ssl ? await readFile(cert, 'utf8') : undefined;
  return {
    client: {host, port, database, user, password, ssl:ssl && {ca, rejectUnauthorized:true},
      connectionTimeoutMillis:8000, statement_timeout:120000},
    env: {PGHOST:host, PGPORT:String(port), PGDATABASE:database, PGUSER:user, PGPASSWORD:password,
      PGSSLMODE:ssl ? 'verify-full' : 'disable', PGCONNECT_TIMEOUT:'8',
      PGPASSFILE:process.platform === 'win32' ? 'NUL' : '/dev/null', ...(ssl && {PGSSLROOTCERT:cert})},
  };
}

async function capture(endpoint) {
  const settings = await connectionSettings(endpoint);
  const client = new Client(settings.client);
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(formats);
    const {rows: found} = await client.query(inventory);
    if (JSON.stringify(found.map(r => r.name).sort()) !== JSON.stringify(tables)) {
      throw new Error('Database table inventory differs from the OpenToken backup scope');
    }
    const {rows:[snapshot]} = await client.query(`SELECT pg_export_snapshot() AS id,
      current_setting('server_version_num')::int AS version, transaction_timestamp()::text AS created`);
    const {rows:[state]} = await client.query(fingerprint);
    const archive = await runTool('pg_dump', ['--format=custom', '--data-only', '--no-password', '--strict-names',
      '--lock-wait-timeout=5000', `--snapshot=${snapshot.id}`, ...tables.map(table => `--table=${table}`)],
    {...settings.env, PGOPTIONS:'-c default_transaction_read_only=on'});
    await client.query('COMMIT');
    const source = {identity:endpoint.identity, project:endpoint.project};
    return {archive, manifest:{source, createdAt:snapshot.created, serverVersion:snapshot.version, fingerprint:state.fingerprint}};
  } finally { await client.end(); }
}

async function archiveSql(archive) {
  const toc = (await runTool('pg_restore', ['--list'], {}, archive)).toString('utf8');
  const listedTables = [...toc.matchAll(/^\d+; \d+ \d+ TABLE DATA (\w+) (\w+) /gm)]
    .map(([,schema,table]) => `${schema}.${table}`).sort();
  if (JSON.stringify(listedTables) !== JSON.stringify(tables)) throw new Error('Archive is missing OpenToken table data');
  return runTool('pg_restore', ['--data-only', '--no-owner', '--no-acl', '--file=-'], {}, archive);
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function restore(endpoint, manifest, sql) {
  const {env} = await connectionSettings(endpoint);
  const expected = sqlLiteral(JSON.stringify(manifest.fingerprint));
  const prepare = `SET standard_conforming_strings TO on; SET lock_timeout TO '5s'; SET statement_timeout TO '120s';
    LOCK TABLE ${tables.join(', ')} IN ACCESS EXCLUSIVE MODE;
    DO $check$ BEGIN
      IF current_setting('server_version_num')::int / 10000 <> ${manifest.serverVersion} / 10000 THEN
        RAISE SQLSTATE 'PBR01'; END IF;
      IF (SELECT array_agg(name ORDER BY name COLLATE "C") FROM (${inventory}) objects)
         IS DISTINCT FROM ARRAY[${tables.map(sqlLiteral).join(', ')}] THEN
        RAISE SQLSTATE 'PBR02'; END IF;
      IF ${migrationVersions} IS DISTINCT FROM (${expected}::jsonb->'versions') THEN
        RAISE SQLSTATE 'PBR03'; END IF;
      IF ${tables.filter(t => t !== 'gateway.schema_migrations').map(t => `EXISTS (SELECT 1 FROM ${t})`).join(' OR ')} THEN
        RAISE SQLSTATE 'PBR04'; END IF;
    END $check$;
    DELETE FROM gateway.schema_migrations;
  `;
  const verify = `\n${formats}
    DO $check$ BEGIN
      IF (${fingerprint}) IS DISTINCT FROM ${expected}::jsonb THEN
        RAISE SQLSTATE 'PBR05'; END IF;
    END $check$;
  `;
  await runTool('psql', ['--no-psqlrc', '--no-password', '--quiet', '--single-transaction', '--set=ON_ERROR_STOP=1',
    '--set=VERBOSITY=sqlstate', '--file=-'],
    env, Buffer.concat([Buffer.from(prepare), sql, Buffer.from(verify)]));
}

async function writeBackup(file, data) {
  await mkdir(dirname(file), {recursive:true});
  const partial = `${file}.${randomBytes(8).toString('hex')}.partial`;
  try {
    await writeFile(partial, data, {flag:'wx', mode:0o600, flush:true});
    await rename(partial, file);
  } finally { await rm(partial, {force:true}); }
}

async function main() {
  const [command, arg, confirmedProject, ...extra] = process.argv.slice(2);
  if (extra.length || !['keygen','create','verify','restore'].includes(command) ||
      (['verify','restore'].includes(command) && !arg) || (confirmedProject && command !== 'restore') ||
      (arg && ['create','keygen'].includes(command))) {
    throw new Error('Use keygen, create, verify <archive>, or restore <archive> [new Supabase project reference]');
  }
  if (!process.env.BACKUP_KEY_FILE) throw new Error('BACKUP_KEY_FILE must point to a separately protected key file');
  const keyFile = resolve(process.env.BACKUP_KEY_FILE);
  if (command === 'keygen') {
    await mkdir(dirname(keyFile), {recursive:true});
    await writeFile(keyFile, randomBytes(32).toString('hex') + '\n', {flag:'wx', mode:0o600, flush:true});
    console.log('Backup key created.');
    return;
  }
  const keyText = (await readFile(keyFile, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/i.test(keyText)) throw new Error('Backup key file must contain exactly 64 hexadecimal characters');
  const key = Buffer.from(keyText, 'hex');
  if (command === 'create') {
    const {archive, manifest} = await capture(postgresEndpoint(process.env.MIGRATION_DATABASE_URL));
    await archiveSql(archive);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join('.demo-data', 'backups', `opentoken-${timestamp}-${randomBytes(4).toString('hex')}.otbk`);
    await writeBackup(file, encodeBackup(key, manifest, archive));
    console.log(`Encrypted backup saved to ${file} (${tables.length} tables, ${manifest.fingerprint.accountingIssues} accounting issues).`);
    return;
  }
  if ((await stat(arg)).size > maxBytes + 1024 * 1024) throw new Error('Archive exceeds the pilot backup size limit');
  const {manifest, archive} = decodeBackup(key, await readFile(arg));
  const target = command === 'restore' && restoreTarget(process.env.BACKUP_TARGET_DATABASE_URL, manifest.source, confirmedProject);
  const sql = await archiveSql(archive);
  if (target) await restore(target, manifest, sql);
  console.log(`${target ? 'Restored and matched' : 'Verified'} snapshot from ${manifest.createdAt} (${tables.length} tables, ${manifest.fingerprint.accountingIssues} accounting issues).`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error('Backup command failed.', error.code ? `Code ${error.code}.` : error.message);
    process.exitCode = 1;
  });
}
