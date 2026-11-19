import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { check,migrate,seed } from '../scripts/database.mjs';
import { resolveLiveUpstream } from '../lib/upstream-config.mjs';

const primary = '30000000-0000-4000-8000-000000000001';
const secondary = '30000000-0000-4000-8000-000000000002';
const identities = new Map([['pilot-a@example.test',primary],['pilot-b@example.test',secondary]]);
const upstreamEnv = {
  ENABLE_OPENAI:'1',UPSTREAM_MODE:'compatible',OPENAI_BASE_URL:'https://provider.example/v1',
  COMPATIBLE_API_KEY:'fixture-key',OPENAI_MODEL:'vendor/text-model',OPENAI_RESPONSE_MODEL:'',
  UPSTREAM_INPUT_USD_PER_MTOK:'0.20',UPSTREAM_CACHED_USD_PER_MTOK:'0.04',UPSTREAM_OUTPUT_USD_PER_MTOK:'0.60',
  UPSTREAM_MAX_CONTEXT_TOKENS:'8192',UPSTREAM_MAX_TOKENS_FIELD:'max_tokens',
};
let base;
let cookie;
let server, serverExit, socket, database, auth;

function fakeAuth() {
  const activeTokens = new Map();
  return createServer(async (request,response) => {
    const json = (status,payload) => {
      response.writeHead(status,{'Content-Type':'application/json'});
      response.end(JSON.stringify(payload));
    };
    const makeUser = (id,email) => ({id,email,aud:'authenticated',role:'authenticated',
      app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()});
    if (request.method==='POST' && request.url==='/auth/v1/token?grant_type=password') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const {email,password} = JSON.parse(raw);
      if (!identities.has(email) || password!=='fixture-test-password') {
        return json(400,{code:'invalid_credentials',msg:'Invalid credentials'});
      }
      const id = identities.get(email);
      const token = 'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({sub:id,exp:Date.now()/1000+3600})).toString('base64url')+'.fixture';
      const user = makeUser(id,email);
      activeTokens.set(token,user);
      return json(200,{access_token:token,refresh_token:'unused',expires_in:3600,token_type:'bearer',user});
    }
    const token = request.headers.authorization?.slice('Bearer '.length);
    if (request.method==='GET' && request.url==='/auth/v1/user' && activeTokens.has(token)) return json(200,activeTokens.get(token));
    if (request.method==='POST' && request.url?.startsWith('/auth/v1/logout')) {
      return json(204,null);
    }
    return json(401,{code:'bad_jwt',msg:'Invalid session'});
  });
}

test.before(async () => {
  database = await PGlite.create();
  await database.exec(`CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text NOT NULL,email_confirmed_at timestamptz);
    CREATE ROLE opentoken_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`);
  for (const [email,id] of identities) await database.query('INSERT INTO auth.users VALUES ($1,$2,now())',[id,email]);
  const admin = {query:async (sql,params) => {
    if (!params && sql.trim().replace(/;$/,'').includes(';')) return database.exec(sql);
    const result = await database.query(sql,params);
    return {...result,rowCount:result.rows.length || result.affectedRows || 0};
  }};
  await migrate(admin);
  await migrate(admin);
  await seed(admin,'pilot-a@example.test',resolveLiveUpstream(upstreamEnv));
  await seed(admin,'pilot-a@example.test',resolveLiveUpstream(upstreamEnv));
  await database.exec('SET ROLE opentoken_app');
  await check(admin);
  await assert.rejects(database.query('UPDATE gateway.wallet_entries SET delta_micros=0'),{code:'42501'});
  await assert.rejects(database.query('SELECT * FROM auth.users'),{code:'42501'});
  socket = new PGLiteSocketServer({db:database,host:'127.0.0.1',port:0,maxConnections:5});
  await socket.start();
  auth = fakeAuth();
  auth.listen(0,'127.0.0.1');
  await once(auth,'listening');
  server = spawn(process.execPath,['--import','./tests/openai-fixture.mjs','node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','0'],{
    windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,NEXT_TELEMETRY_DISABLED:'1',
      DATABASE_URL:'postgresql://opentoken_app@'+socket.getServerConn()+'/postgres',
      SUPABASE_URL:'http://127.0.0.1:'+auth.address().port,SUPABASE_PUBLISHABLE_KEY:'fixture-key',
      GATEWAY_SECRET:'01'.repeat(32),APP_ORIGIN:'',DEMO_DELAY_MS:'5000',...upstreamEnv},
  });
  serverExit = once(server,'exit');
  let logs = '';
  server.stdout.on('data',chunk => {
    logs += chunk;
    base ??= logs.match(/Local:\s+(http:\/\/127\.0\.0\.1:[1-9]\d*)/)?.[1];
  });
  const deadline = Date.now()+20_000;
  while (Date.now()<deadline) {
    if (server.exitCode !== null) break;
    try { if (base && (await fetch(base+'/login',{signal:AbortSignal.timeout(500)})).ok) return; }
    catch { /* Wait until the server accepts connections. */ }
    await sleep(200);
  }
  assert.fail('Local Next.js server did not start. Run pnpm build before testing.\n'+logs);
});
test.after(async () => {
  if (server) { server.kill(); await serverExit; }
  if (auth) await new Promise(resolve=>auth.close(resolve));
  if (socket) await socket.stop();
  if (database) await database.close();
});
async function request(path, { method = 'GET', body, token, retry, session = true, sessionOverride } = {}) {
  const r = await fetch(base + path, {
    method, headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(method!=='GET' ? {origin:base} : {}),
      ...(session && (sessionOverride || cookie) ? {cookie:sessionOverride || cookie} : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(retry ? { 'idempotency-key': retry } : {}),
    }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, headers: r.headers, data: r.status === 204 ? null : await r.json() };
}

const loginPayload = (email,password='fixture-test-password') => ({method:'POST',body:{email,password}});

test('mock call settles once, hides the API key and isolates independent users', async () => {
  assert.equal((await request('/api/keys', {session:false})).status, 401);
  assert.equal((await request('/api/session/login',loginPayload('pilot-a@example.test','wrong'))).status,401);
  const login = await request('/api/session/login',loginPayload('pilot-a@example.test'));
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const { data: catalog } = await request('/api/catalog');
  const { data: start } = await request('/api/dashboard');
  assert.equal(start.balanceMicros,'10000000');
  const key = await request('/api/keys', { method:'POST', body:{name:'integration',groupId:catalog.rates[0].groupId,rpm:20} });
  assert.equal(key.status, 201);
  assert.match(key.headers.get('cache-control'), /no-store/);
  const secret = key.data.secret;
  const { data: keys } = await request('/api/keys');
  assert.equal(keys.items.find(item => item.id === key.data.id).prefix, secret.slice(0,12));
  assert.ok(!JSON.stringify(keys).includes(secret));

  const body = { model:'mock-text', messages:[{role:'user',content:'A local demo'}], max_completion_tokens:128 };
  const retry = crypto.randomUUID();
  const call = request('/v1/chat/completions', {method:'POST',body,token:secret,retry,session:false});
  let pending;
  for (let i=0; i<60 && !pending; i++) {
    const {data} = await request('/api/usage?key_id=' + key.data.id);
    pending = data.items.find(row => row.status === 'dispatched');
    if (!pending) await sleep(70);
  }
  assert.ok(pending);
  const during = (await request('/api/dashboard')).data;
  assert.equal(during.balanceMicros, start.balanceMicros);
  assert.equal(during.heldMicros, '2000000');
  assert.equal(during.availableMicros, String(BigInt(start.balanceMicros)-2_000_000n));
  const duplicate = await request('/v1/chat/completions', {method:'POST',body:{...body,stream:false},token:secret,retry,session:false});
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error.code,'duplicate_request');
  assert.equal(duplicate.data.error.request_id, pending.id);
  const result = await call;
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-request-id'), pending.id);
  const end = (await request('/api/dashboard')).data;
  assert.equal(end.heldMicros, '0');
  assert.equal(end.balanceMicros, String(BigInt(start.balanceMicros)-750_000n));
  const rows = (await request('/api/usage?key_id=' + key.data.id)).data.items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, pending.id);
  assert.equal(rows[0].status, 'settled');
  assert.equal(rows[0].chargedMicros, '750000');
  assert.equal(rows[0].ledgerDeltaMicros, '-750000');
  const limited = await request('/api/keys', { method:'POST', body:{name:'limited',groupId:catalog.rates[0].groupId,rpm:20,capMicros:'1000000'} });
  const blocked = await request('/v1/chat/completions', {method:'POST',body,token:limited.data.secret,session:false});
  assert.equal(blocked.status,402);
  assert.equal(blocked.data.error.code,'key_budget_exceeded');
  assert.equal((await request('/api/dashboard')).data.heldMicros,'0');
  const otherLogin = await request('/api/session/login',loginPayload('pilot-b@example.test'));
  const sessionOverride = otherLogin.headers.get('set-cookie').split(';')[0];
  assert.deepEqual((await request('/api/keys',{sessionOverride})).data.items,[]);
  assert.deepEqual((await request('/api/usage?request_id='+pending.id,{sessionOverride})).data.items,[]);
  assert.equal((await request('/api/keys/'+key.data.id,{method:'DELETE',sessionOverride})).status,404);
  assert.equal((await request('/api/dashboard',{sessionOverride})).data.balanceMicros,'0');
});

test('compatible upstream settles one debit, releases the remainder and handles missing billing evidence',async () => {
  const login = await request('/api/session/login',loginPayload('pilot-a@example.test'));
  cookie = login.headers.get('set-cookie').split(';')[0];
  const price = (await request('/api/catalog')).data.rates.find(row=>row.model==='compatible-chat');
  assert.equal(price.upstream,'compatible');
  const key = await request('/api/keys',{method:'POST',body:{name:'provider fixture',groupId:price.groupId,rpm:20}});
  assert.equal(key.status,201);
  const call = content => request('/v1/chat/completions',{method:'POST',token:key.data.secret,session:false,
    retry:crypto.randomUUID(),body:{model:price.model,messages:[{role:'user',content}],max_completion_tokens:16,stream:false}});
  const dashboardBefore = (await request('/api/dashboard')).data;
  const result = await call('fixture success');
  assert.equal(result.status,200);
  const id = result.headers.get('x-request-id');
  const {items:[settled]} = (await request('/api/usage?request_id='+id)).data;
  assert.equal(settled.upstreamRequestId,'fixture-provider-request');
  assert.equal(settled.reservedMicros,'1648');
  assert.equal(settled.chargedMicros,'4');
  assert.equal(settled.releasedMicros,'1644');
  assert.equal(settled.ledgerDeltaMicros,'-4');
  const paid = (await request('/api/dashboard')).data;
  assert.equal(BigInt(dashboardBefore.balanceMicros)-BigInt(paid.balanceMicros),4n);
  assert.equal(paid.heldMicros,dashboardBefore.heldMicros);
  assert.equal(BigInt(paid.availableMicros)-(BigInt(dashboardBefore.availableMicros)-1648n),1644n);
  const rejected = await call('fixture rejection');
  assert.equal(rejected.status,503);
  const {items:[unconfirmed]} = (await request('/api/usage?request_id='+rejected.data.error.request_id)).data;
  assert.equal(unconfirmed.status,'review');
  assert.equal(unconfirmed.releasedMicros,null);
  assert.equal(unconfirmed.ledgerDeltaMicros,null);
  assert.equal((await request('/api/dashboard')).data.heldMicros,'1648');
  const failed = await call('fixture uncertain');
  assert.equal(failed.status,503);
  const {items:[review]} = (await request('/api/usage?request_id='+failed.data.error.request_id)).data;
  assert.equal(review.status,'review');
  assert.equal(review.releasedMicros,null);
  assert.equal(review.ledgerDeltaMicros,null);
  const held = (await request('/api/dashboard')).data;
  assert.equal(held.heldMicros,'3296');
  assert.equal(held.balanceMicros,paid.balanceMicros);
  const logout = await request('/api/session/logout',{method:'POST'});
  assert.equal(logout.status,204);
  assert.match(logout.headers.get('set-cookie'),/Max-Age=0/i);
  cookie = undefined;
  assert.equal((await request('/api/keys')).status,401);
});
