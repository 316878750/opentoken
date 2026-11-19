import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir,writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { resolveLiveUpstream } from '../lib/upstream-config.mjs';

const maxCompletion = 16;

function amount(rate,input,cached,output) {
  const raw = BigInt(input-cached)*BigInt(rate.inputMicros)+BigInt(cached)*BigInt(rate.cacheMicros)+BigInt(output)*BigInt(rate.outputMicros);
  return (raw*BigInt(rate.multiplierBps)+9_999_999_999n)/10_000_000_000n;
}

async function verify(origin,upstream) {
  const url = new URL(origin);
  const model = upstream.alias;
  let cookie, keyId;

  async function request(path,{method='GET',body,token,retry}={}) {
    const headers = {
      ...(cookie && !token ? {Cookie:cookie} : {}),
      ...(method!=='GET' ? {Origin:url.origin} : {}),
      ...(body ? {'Content-Type':'application/json'} : {}),
      ...(token ? {Authorization:'Bearer '+token} : {}),
      ...(retry ? {'Idempotency-Key':retry} : {}),
    };
    const res = await fetch(new URL(path,url.origin),{method,headers,body:body ? JSON.stringify(body) : undefined,
      redirect:'error',signal:AbortSignal.timeout(40000)});
    return {status:res.status,headers:res.headers,data:await res.json()};
  }
  function ok(result,label) {
    if (result.status<200 || result.status>=300) {
      const code = result.data?.error?.code;
      throw new Error(label+' HTTP '+result.status+(code ? ' ('+code+')' : '')+
        (result.headers.has('x-request-id') ? ' request '+result.headers.get('x-request-id') : ''));
    }
    return result.data;
  }
  const login = await request('/api/session/login',{method:'POST',body:{email:process.env.PILOT_EMAIL,password:process.env.PILOT_PASSWORD}});
  ok(login,'Pilot login');
  cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie,'Login did not set the session cookie');
  const catalog = ok(await request('/api/catalog'),'Catalog');
  const rate = catalog.rates.find(r=>r.model===model && r.upstream===(upstream.mode==='compatible' ? 'compatible' : 'openai'));
  assert.ok(rate,'The configured upstream model is unavailable in the selected instance');
  assert.ok(Number.isSafeInteger(rate.maxContextTokens) && rate.maxContextTokens>0 && rate.maxOutputTokens>=maxCompletion,
    'Invalid model limits');
  const assumedCached = BigInt(rate.cacheMicros)>BigInt(rate.inputMicros) ? rate.maxContextTokens : 0;
  const reserved = amount(rate,rate.maxContextTokens,assumedCached,maxCompletion);
  const before = ok(await request('/api/dashboard'),'Before dashboard');
  if (upstream.mode==='compatible') {
    assert.equal(rate.inputMicros,upstream.inputMicros);
    assert.equal(rate.cacheMicros,upstream.cacheMicros);
    assert.equal(rate.outputMicros,upstream.outputMicros);
    assert.equal(rate.maxContextTokens,upstream.maxContextTokens);
    assert.equal(rate.multiplierBps,10000);
  }
  assert.ok(reserved>0n && BigInt(before.availableMicros)>=reserved,'Pilot wallet needs enough available balance');
  assert.equal(before.heldMicros,'0','Use a pilot wallet without other active requests');
  await mkdir('.demo-data',{recursive:true});
  const marker = '.demo-data/live-check.json';
  const retry = randomUUID();
  try {
    await writeFile(marker,JSON.stringify({status:'prepared',retry},null,2)+'\n',{flag:'wx'});
  } catch (error) {
    if (error.code==='EEXIST') throw new Error('A previous live check exists. Inspect .demo-data/live-check.json before authorizing another call.');
    throw error;
  }
  try {
    const key = ok(await request('/api/keys',{method:'POST',body:{
      name:'一次性真实验收',groupId:rate.groupId,rpm:1,capMicros:reserved.toString(),
    }}),'Create pilot key');
    keyId = key.id;
    await writeFile(marker,JSON.stringify({status:'dispatch_attempted',retry,keyId},null,2)+'\n');
    let completed = false;
    const resultPromise = request('/v1/chat/completions',{method:'POST',token:key.secret,retry,body:{
      model,messages:[{role:'user',content:'Reply with exactly OK.'}],max_completion_tokens:maxCompletion,stream:false,
    }}).then(result=>({result}),error=>({error})).finally(()=>{completed=true;});
    let inFlight = null;
    for (let i=0;i<8 && !completed;i++) {
      await wait(90);
      try {
        const dash = ok(await request('/api/dashboard'),'In-flight dashboard');
        if (BigInt(dash.heldMicros)-BigInt(before.heldMicros)===reserved && dash.balanceMicros===before.balanceMicros) {
          assert.equal(BigInt(before.availableMicros)-BigInt(dash.availableMicros),reserved);
          inFlight = dash;
          break;
        }
      } catch { /* Final ledger evidence is checked below even if polling misses a fast completion. */ }
    }
    const outcome = await resultPromise;
    if (outcome.error) throw outcome.error;
    const responseId = outcome.result.headers.get('x-request-id');
    if (responseId) await writeFile(marker,JSON.stringify({status:'response_received',retry,keyId,requestId:responseId},null,2)+'\n');
    const result = ok(outcome.result,'One upstream request');
    const id = responseId;
    assert.match(id,/^[0-9a-f-]{36}$/);
    const {items:[row]} = ok(await request('/api/usage?request_id='+id),'Usage record');
    const after = ok(await request('/api/dashboard'),'After dashboard');
    assert.ok(row?.upstreamRequestId,'No upstream request or completion identifier was recorded');
    assert.equal(row.status,'settled');
    assert.equal(row.reservedMicros,reserved.toString());
    assert.equal(row.inputTokens,result.usage.prompt_tokens);
    assert.equal(row.cachedTokens,result.usage.prompt_tokens_details.cached_tokens);
    assert.equal(row.outputTokens,result.usage.completion_tokens);
    const charged = amount(rate,row.inputTokens,row.cachedTokens,row.outputTokens);
    assert.ok(charged>0n,'Usage fee must be positive');
    assert.equal(row.chargedMicros,charged.toString());
    assert.equal(row.ledgerDeltaMicros,(-charged).toString());
    assert.equal(BigInt(before.balanceMicros)-BigInt(after.balanceMicros),charged);
    assert.equal(BigInt(after.chargedMicros)-BigInt(before.chargedMicros),charged);
    assert.equal(after.heldMicros,before.heldMicros);
    const released = reserved-charged;
    assert.ok(released>=0n);
    assert.equal(row.releasedMicros,released.toString());
    assert.equal(BigInt(before.availableMicros)-BigInt(after.availableMicros),charged);
    if (inFlight) assert.equal(BigInt(after.availableMicros)-BigInt(inFlight.availableMicros),released);
    const evidence = {status:'verified',upstreamMode:upstream.mode,upstreamModel:upstream.model,
      requestId:id,upstreamRequestId:row.upstreamRequestId,releasedMicros:released.toString(),
      reservedMicros:row.reservedMicros,chargedMicros:row.chargedMicros,ledgerDeltaMicros:row.ledgerDeltaMicros,
      inFlightDashboardObserved:Boolean(inFlight),tokens:result.usage,balanceBefore:before.balanceMicros,balanceAfter:after.balanceMicros};
    await writeFile(marker,JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence,null,2));
  } finally {
    if (keyId) {
      try {ok(await request('/api/keys/'+keyId,{method:'DELETE'}),'Revoke pilot key');}
      catch {console.error('The dedicated pilot key could not be revoked. Revoke it in the key list.');}
    }
  }
}

async function run() {
  const missing = ['PILOT_EMAIL','PILOT_PASSWORD','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','DATABASE_URL','GATEWAY_SECRET']
    .filter(name=>!process.env[name]?.trim());
  if (process.env.ENABLE_OPENAI!=='1') missing.push('ENABLE_OPENAI=1');
  if (missing.length) throw new Error('Missing live configuration: '+missing.join(', '));
  const upstream = resolveLiveUpstream();
  const serverEnv = {...process.env,APP_ORIGIN:'',NODE_OPTIONS:'',PILOT_PASSWORD:'',MIGRATION_DATABASE_URL:'',NEXT_TELEMETRY_DISABLED:'1'};
  const server = spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','0'],
    {windowsHide:true,stdio:['ignore','pipe','ignore'],env:serverEnv});
  const exited = once(server,'exit');
  let logs = '', origin;
  server.stdout.on('data',chunk => {
    logs += chunk;
    origin ??= logs.match(/Local:\s+(http:\/\/127\.0\.0\.1:[1-9]\d*)/)?.[1];
  });
  try {
    for (let retry=0;retry<80;retry++) {
      if (server.exitCode!==null) break;
      let ready = false;
      try {
        if (origin) ready = (await fetch(origin+'/login',{signal:AbortSignal.timeout(800)})).ok;
      } catch (error) {
        if (error.name!=='TimeoutError' && error.cause?.code!=='ECONNREFUSED') throw error;
      }
      if (ready) return await verify(origin,upstream);
      await wait(200);
    }
    throw new Error('OpenToken failed to start. Run pnpm build before verification.');
  } finally {
    server.kill();
    await exited;
  }
}

run().catch(error=>{
  console.error('Live verification stopped:',error instanceof assert.AssertionError ? 'accounting assertion failed' : error.message);
  process.exitCode=1;
});
