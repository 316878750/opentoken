import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { check,migrate,seed } from '../scripts/database.mjs';
import { redeemCommand } from '../scripts/redeem.mjs';
import { resolveLiveUpstream } from '../lib/upstream-config.mjs';

const primary = '30000000-0000-4000-8000-000000000001';
const secondary = '30000000-0000-4000-8000-000000000002';
const trial = '30000000-0000-4000-8000-000000000003';
const identities = new Map([['pilot-a@example.test',primary],['pilot-b@example.test',secondary],['pilot-c@example.test',trial]]);
const trialCodes = {contest:'',funding:'',expired:'otc_'+'C'.repeat(32),voided:''};
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
    if (request.method==='GET' && request.url==='/auth/v1/settings' && request.headers.apikey==='fixture-key') return json(200,{});
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
  const expiry = new Date(Date.now()+3_600_000).toISOString();
  for (const type of ['contest','funding','voided']) {
    const issued = await redeemCommand(admin,['issue','3.00',expiry]);
    assert.match(issued.code,/^otc_[A-Za-z0-9_-]{32}$/);
    assert.equal(issued.amountMicros,'3000000');
    trialCodes[type] = issued.code;
    if (type==='voided') assert.equal((await redeemCommand(admin,['void',issued.id])).id,issued.id);
  }
  await database.query(`INSERT INTO gateway.redeem_codes (secret_digest,amount_micros,created_at,expires_at)
    VALUES ($1,3000000,now()-interval '2 days',now()-interval '1 day')`,
  [createHash('sha256').update(trialCodes.expired).digest()]);
  await database.exec('SET ROLE opentoken_app');
  await check(admin);
  await assert.rejects(database.query('UPDATE gateway.wallet_entries SET delta_micros=0'),{code:'42501'});
  await assert.rejects(database.query(`INSERT INTO gateway.wallet_entries (user_id,redeem_code_id,kind,delta_micros)
    VALUES ($1,gen_random_uuid(),'redemption',100)`,[primary]),{code:'42501'});
  await assert.rejects(database.query('SELECT * FROM gateway.redeem_codes'),{code:'42501'});
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

test('public readiness checks PostgreSQL and Auth without disclosing service configuration', async () => {
  const health = await request('/api/health',{session:false});
  assert.equal(health.status,200);
  assert.deepEqual(health.data,{status:'ok'});
  assert.match(health.headers.get('cache-control'),/no-store/);
});

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

test('concurrent requests on separate keys cannot over-reserve a shared wallet', async () => {
  const login = await request('/api/session/login',loginPayload('pilot-a@example.test'));
  cookie = login.headers.get('set-cookie').split(';')[0];
  const {data:{rates}} = await request('/api/catalog');
  const groupId = rates.find(rate=>rate.model==='mock-text').groupId;
  const {data:before} = await request('/api/dashboard');
  const reserved = 2_000_000n;
  const admitted = Number(BigInt(before.availableMicros)/reserved);
  assert.ok(admitted>0 && admitted<6,'Fixture must have a small, positive wallet balance');
  const keys = await Promise.all(Array.from({length:admitted+1},(_,i)=>request('/api/keys',{
    method:'POST',body:{name:'concurrent wallet '+i,groupId,rpm:10},
  })));
  assert.ok(keys.every(key=>key.status===201));
  const calls = keys.map(key=>request('/v1/chat/completions',{method:'POST',token:key.data.secret,session:false,
    body:{model:'mock-text',messages:[{role:'user',content:'Concurrent wallet test'}],max_completion_tokens:128}}));
  const results = await Promise.all(calls);
  assert.equal(results.filter(call=>call.status===200).length,admitted);
  const denied = results.filter(call=>call.status===402);
  assert.equal(denied.length,1);
  assert.equal(denied[0].data.error.code,'insufficient_balance');
  const {data:after} = await request('/api/dashboard');
  assert.equal(after.heldMicros,before.heldMicros);
  assert.equal(BigInt(before.balanceMicros)-BigInt(after.balanceMicros),BigInt(admitted)*750_000n);
});

test('a late authoritative response settles a request moved to review by the scanner', async () => {
  const login = await request('/api/session/login',loginPayload('pilot-a@example.test'));
  cookie = login.headers.get('set-cookie').split(';')[0];
  const {data:{rates}} = await request('/api/catalog');
  const groupId = rates.find(rate=>rate.model==='mock-text').groupId;
  const {data:key} = await request('/api/keys',{method:'POST',body:{name:'delayed response',groupId,rpm:10}});
  const pending = request('/v1/chat/completions',{method:'POST',token:key.secret,session:false,
    body:{model:'mock-text',messages:[{role:'user',content:'Delayed reply'}],max_completion_tokens:128}});
  let dispatched;
  for(let attempt=0;attempt<40&&!dispatched;attempt++){
    const {data} = await request('/api/usage?key_id='+key.id);
    dispatched = data.items.find(row=>row.status==='dispatched');
    if(!dispatched)await sleep(60);
  }
  assert.ok(dispatched);
  await database.query(`UPDATE gateway.usage_requests SET status='review',terminal_reason='dispatch_interrupted'
    WHERE id=$1 AND status='dispatched'`,[dispatched.id]);
  assert.equal((await pending).status,200);
  const {data:{items:[row]}} = await request('/api/usage?request_id='+dispatched.id);
  assert.equal(row.status,'settled');
  assert.equal(row.ledgerDeltaMicros,'-750000');
});

test('only one account can redeem a code and the winner can replay its original receipt', async () => {
  const sessions = await Promise.all(['pilot-a@example.test','pilot-b@example.test'].map(async email => {
    const result = await request('/api/session/login',loginPayload(email));
    assert.equal(result.status,200);
    return result.headers.get('set-cookie').split(';')[0];
  }));
  const useCode = (code,sessionOverride) => request('/api/redeem',{method:'POST',body:{code},sessionOverride});
  assert.equal((await request('/api/redeem',{method:'POST',body:{code:trialCodes.contest},session:false})).status,401);
  const starts = await Promise.all(sessions.map(sessionOverride=>request('/api/dashboard',{sessionOverride})));
  const results = await Promise.all(sessions.map(session=>useCode(trialCodes.contest,session)));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,404]);
  const winner = results.findIndex(r=>r.status===200);
  const loser = 1-winner;
  const receipt = results[winner].data;
  assert.equal(receipt.receipt.amountMicros,'3000000');
  assert.equal(receipt.replayed,false);
  assert.equal(BigInt(receipt.wallet.balanceMicros)-BigInt(starts[winner].data.balanceMicros),3_000_000n);
  assert.equal(receipt.wallet.heldMicros,starts[winner].data.heldMicros);
  const replay = await useCode(trialCodes.contest,sessions[winner]);
  assert.deepEqual(replay.data,{...receipt,replayed:true});
  const activities = await Promise.all(sessions.map(sessionOverride=>request('/api/wallet/entries?kind=redemption',{sessionOverride})));
  assert.equal(activities[winner].data.items.filter(item=>item.id===receipt.receipt.id).length,1);
  assert.ok(activities[loser].data.items.every(item=>item.id!==receipt.receipt.id));
  assert.ok(!JSON.stringify(activities).includes(trialCodes.contest));
  assert.equal((await request('/api/dashboard',{sessionOverride:sessions[loser]})).data.balanceMicros,starts[loser].data.balanceMicros);
  for (const code of [trialCodes.expired,trialCodes.voided,'invalid',trialCodes.expired]) {
    const failed = await useCode(code,sessions[loser]);
    assert.equal(failed.status,404);
    assert.deepEqual(failed.data,results[loser].data);
  }
  const limited = await useCode(trialCodes.expired,sessions[loser]);
  assert.equal(limited.status,429);
  assert.ok(Number(limited.headers.get('retry-after'))>0);
});

test('a user with an empty wallet can redeem credit, call the mock model and reconcile the ledger', async () => {
  assert.equal((await fetch(base+'/redeem',{redirect:'manual'})).headers.get('location'),'/login?redirect=/redeem');
  const login = await request('/api/session/login',loginPayload('pilot-c@example.test'));
  assert.equal(login.status,200);
  const sessionOverride = login.headers.get('set-cookie').split(';')[0];
  const page=await fetch(base+'/redeem',{headers:{Cookie:sessionOverride}});
  assert.equal(page.status,200);
  assert.match(await page.text(),/兑换额度/);
  const {data:before} = await request('/api/dashboard',{sessionOverride});
  assert.equal(before.balanceMicros,'0');
  const {data:{rates}} = await request('/api/catalog',{sessionOverride});
  const groupId=rates.find(rate=>rate.model==='mock-text').groupId;
  const key = await request('/api/keys',{method:'POST',sessionOverride,body:{name:'funded trial',groupId,rpm:10}});
  const call = () => request('/v1/chat/completions',{method:'POST',session:false,token:key.data.secret,
    body:{model:'mock-text',messages:[{role:'user',content:'Trial credit fixture'}],max_completion_tokens:128,stream:false}});
  assert.equal((await call()).status,402);
  const credit = await request('/api/redeem',{method:'POST',sessionOverride,body:{code:trialCodes.funding}});
  assert.equal(credit.status,200);
  assert.equal(credit.data.wallet.availableMicros,'3000000');
  const result=await call();
  assert.equal(result.status,200);
  const {data:after} = await request('/api/dashboard',{sessionOverride});
  assert.equal(after.balanceMicros,'2250000');
  assert.equal(after.heldMicros,'0');
  const {data:{items}} = await request('/api/wallet/entries',{sessionOverride});
  assert.deepEqual(items.map(row=>[row.kind,row.deltaMicros]),[['usage','-750000'],['redemption','3000000']]);
  assert.equal(items[0].requestId,result.headers.get('x-request-id'));
  assert.equal(items[1].id,credit.data.receipt.id);
});
