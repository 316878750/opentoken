import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { completeInvite as handleInvite } from '../lib/invite.ts';
import { generatePilotInvite } from '../scripts/pilot-invite.mjs';

const origin = 'https://pilot.example.test';
const hash = 'a'.repeat(56);
const password = 'fixture-invite-password';
const completeInvite = (request,expectedOrigin,auth) => handleInvite(request,expectedOrigin,auth,'a1'.repeat(32));
const makeRequest = (input,headers = {}) => new Request(`${origin}/api/invite`,{
  method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(input),
});
const user = {id:'30000000-0000-4000-8000-000000000003',email:'invitee@example.test',aud:'authenticated',
  app_metadata:{provider:'email'},user_metadata:{},created_at:'2026-11-20T00:00:00Z',invited_at:'2026-11-20T00:00:00Z'};
const accessToken = 'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({sub:user.id,exp:Date.now()/1000+3600})).toString('base64url')+'.fixture';

function fixtureAuth(updateStatuses = [],account = user) {
  let inviteAvailable = true, installedPassword;
  let refreshToken = '',refreshCount = 0;
  const replies = [...updateStatuses];
  const createSession = () => Response.json({access_token:accessToken,refresh_token:refreshToken,expires_in:3600,token_type:'bearer',user:account});
  const auth = () => createClient('https://auth.example.test','sb_publishable_fixture',{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{fetch:async (url,options) => {
      const {pathname:path,search} = new URL(url);
      if (path==='/auth/v1/verify' && options.method==='POST') {
        const supplied = JSON.parse(options.body);
        if (!inviteAvailable || supplied.token_hash!==hash || supplied.type!=='invite') {
          return Response.json({code:'otp_expired',msg:'Fixture token expired'},{status:403});
        }
        inviteAvailable = false;
        refreshToken = 'fixture-refresh-token';
        return createSession();
      }
      if (path==='/auth/v1/token' && search==='?grant_type=refresh_token' && options.method==='POST') {
        if (!refreshToken || JSON.parse(options.body).refresh_token!==refreshToken) {
          return Response.json({code:'refresh_token_not_found',msg:'Fixture refresh expired'},{status:400});
        }
        refreshToken = 'fixture-rotated-refresh-token-'+(++refreshCount);
        return createSession();
      }
      if (new Headers(options.headers).get('authorization')!==`Bearer ${accessToken}`) {
        return Response.json({code:'bad_jwt',msg:'Fixture unauthorized'},{status:401});
      }
      if (path==='/auth/v1/user' && options.method==='PUT') {
        const status = replies.shift() || 200;
        if (status!==200) return Response.json({code:'fixture_failure',msg:'Provider details'},{status});
        installedPassword = JSON.parse(options.body).password;
        return Response.json(user);
      }
      if (path==='/auth/v1/logout' && options.method==='POST') {
        refreshToken = '';
        return new Response(null,{status:204});
      }
      return new Response(null,{status:404});
    }},
  }).auth;
  return {auth,installedPassword:() => installedPassword};
}

test('rejects invite requests before creating an Auth client',async () => {
  const auth = () => assert.fail('invalid requests must not contact Auth');
  for (const [input,headers,status] of [
    [{token_hash:hash,password},{origin:'https://other.example.test'},403],
    [{token_hash:hash,password},{origin:'null'},403],
    [{token_hash:hash,password},{'content-type':'application/jsonx'},400],
    [{token_hash:hash,password,redirect:'https://other.example.test'},{},400],
    [{token_hash:hash,password:'short'},{},400],
    [{token_hash:hash,password:'密'.repeat(25)},{},400],
    [{token_hash:hash,password:'a'.repeat(2048)},{},413],
  ]) {
    assert.equal((await completeInvite(makeRequest(input,headers),origin,auth)).status,status);
  }
  const get = new Request(`${origin}/api/invite`,{headers:{origin}});
  assert.equal((await completeInvite(get,origin,auth)).status,405);
});

test('sets the password with the verified invite session while exposing only success',async () => {
  const {auth,installedPassword} = fixtureAuth();
  const response = await completeInvite(makeRequest({token_hash:hash,password}),origin,auth);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('set-cookie'),null);
  assert.deepEqual(await response.json(),{ok:true});
  assert.equal(installedPassword(),password);
  const reused = await completeInvite(makeRequest({token_hash:hash,password:'a-different-password'}),origin,auth);
  assert.equal(reused.status,401);
  assert.equal(installedPassword(),password);
});

test('retries a transient password update without exchanging the one-time token again',async () => {
  const {auth,installedPassword} = fixtureAuth([503]);
  const response = await completeInvite(makeRequest({token_hash:hash,password}),origin,auth);
  assert.equal(response.status,200);
  assert.equal(installedPassword(),password);
});

test('refuses to set a pilot password for a verified user who was never invited',async () => {
  const {auth,installedPassword} = fixtureAuth([],{...user,invited_at:undefined});
  const response = await completeInvite(makeRequest({token_hash:hash,password}),origin,auth);
  assert.equal(response.status,401);
  assert.equal(installedPassword(),undefined);
});

test('uses a short encrypted setup cookie to retry a rejected password without reusing the invitation',async () => {
  const {auth,installedPassword} = fixtureAuth([422]);
  const response = await completeInvite(makeRequest({token_hash:hash,password}),origin,auth);
  assert.equal(response.status,409);
  const body = await response.json();
  assert.equal(body.error.code,'invite_password_setup_failed');
  assert.doesNotMatch(JSON.stringify(body),/Provider details|fixture-refresh-token/);
  assert.equal(installedPassword(),undefined);
  const header = response.headers.get('set-cookie') || '';
  assert.match(header,/^__Host-opentoken_invite_setup=/);
  assert.match(header,/; Max-Age=600;.*; Secure/i);
  assert.match(header,/; HttpOnly; SameSite=Strict/i);
  assert.doesNotMatch(header,/fixture-refresh-token|fixture-invite-password|a{56}/);
  const cookie = header.split(';',1)[0];
  const retry = await completeInvite(makeRequest({password:'fixture-new-pilot-password'},{cookie}),origin,auth);
  assert.equal(retry.status,200);
  assert.equal(installedPassword(),'fixture-new-pilot-password');
  assert.match(retry.headers.get('set-cookie'),/Max-Age=0/);
  const replay = await completeInvite(makeRequest({password},{cookie}),origin,auth);
  assert.equal(replay.status,401);
  assert.equal(installedPassword(),'fixture-new-pilot-password');
});

test('rejects a tampered, cross-origin, or expired setup cookie before contacting Supabase',async t => {
  t.mock.timers.enable({apis:['Date']});
  const {auth} = fixtureAuth([422]);
  const initial = await completeInvite(makeRequest({token_hash:hash,password}),origin,auth);
  assert.equal(initial.status,409);
  const cookie = (initial.headers.get('set-cookie') || '').split(';',1)[0];
  assert.notEqual(cookie,'');
  const tokenStart = cookie.indexOf('=')+1;
  const changed = cookie.slice(0,tokenStart)+(cookie[tokenStart]==='A' ? 'B' : 'A')+cookie.slice(tokenStart+1);
  const noAuth = () => assert.fail('a tampered or expired cookie must not contact Auth');
  const tampered = await completeInvite(makeRequest({password},{cookie:changed}),origin,noAuth);
  assert.equal(tampered.status,401);
  const other = 'https://other.example.test';
  const copied = new Request(`${other}/api/invite`,{
    method:'POST',headers:{origin:other,'content-type':'application/json',cookie},body:JSON.stringify({password}),
  });
  assert.equal((await completeInvite(copied,other,noAuth)).status,401);
  t.mock.timers.tick(600_001);
  const expired = await completeInvite(makeRequest({password},{cookie}),origin,noAuth);
  assert.equal(expired.status,401);
  assert.match(expired.headers.get('set-cookie'),/Max-Age=0/);
});

test('generates a fragment-only application URL through Supabase admin generateLink',async t => {
  const secret = 'sb_secret_fixture';
  const authOrigin = 'https://auth.example.test';
  t.mock.method(globalThis,'fetch',async (url,options) => {
    const payload = JSON.parse(options.body);
    if (options.method!=='POST' || new URL(url).origin!==authOrigin || new URL(url).pathname!=='/auth/v1/admin/generate_link' ||
      new Headers(options.headers).get('apikey')!==secret || payload.type!=='invite' || payload.email!==user.email) {
      return Response.json({},{status:400});
    }
    return Response.json({...user,action_link:`${authOrigin}/verify?token=${hash}`,email_otp:'111111',
      hashed_token:hash,verification_type:'invite',redirect_to:origin});
  });
  const env = {SUPABASE_URL:authOrigin,SUPABASE_SECRET_KEY:secret,APP_ORIGIN:origin};
  assert.equal(await generatePilotInvite(user.email,env),`${origin}/invite#token_hash=${hash}`);
  await assert.rejects(generatePilotInvite(user.email,{...env,APP_ORIGIN:`${origin}/wrong`}),/APP_ORIGIN/);
  await assert.rejects(generatePilotInvite(user.email,{...env,SUPABASE_SECRET_KEY:'sb_publishable_wrong'}),/SUPABASE_SECRET_KEY/);
});
