import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

let base = process.env.TEST_URL;
let cookie;
let server, serverExit, temporaryData;
test.before(async () => {
  if (process.env.TEST_URL) return;
  temporaryData = await mkdtemp(join(tmpdir(),'model-gateway-test-'));
  server = spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','0'],{
    windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,NEXT_TELEMETRY_DISABLED:'1',
      DEMO_DATA_DIR:temporaryData,DEMO_DELAY_MS:'5000',DEMO_EMAIL:'demo@example.test',DEMO_PASSWORD:'local-demo-only'},
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
  if (temporaryData) await rm(temporaryData,{recursive:true,force:true});
});
async function request(path, { method = 'GET', body, token, retry, session = true } = {}) {
  const r = await fetch(base + path, {
    method, headers: {
      ...(body ? { 'content-type': 'application/json', origin: base } : {}),
      ...(session && cookie ? { cookie } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(retry ? { 'idempotency-key': retry } : {}),
    }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, headers: r.headers, data: r.status === 204 ? null : await r.json() };
}

test('mock call reserves funds, settles once and hides API key after creation', async () => {
  assert.equal((await request('/api/keys', {session:false})).status, 401);
  assert.equal((await request('/api/session/login', { method:'POST', body:{email:'demo@example.test',password:'wrong'} })).status, 401);
  const login = await request('/api/session/login', { method:'POST', body:{email:'demo@example.test',password:'local-demo-only'} });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const { data: catalog } = await request('/api/catalog');
  const { data: start } = await request('/api/dashboard');
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
});
