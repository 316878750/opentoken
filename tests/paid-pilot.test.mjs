import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import Stripe from 'stripe';
import {enableStripeSandbox,migrate} from '../scripts/database.mjs';
import {paidPilotCommand} from '../scripts/paid-pilot.mjs';

let db,admin;
const selected=randomUUID(), other=randomUUID();
const email='pilot-owner@example.test';

before(async()=>{
  db=await PGlite.create();
  await db.exec(`CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz);
    CREATE ROLE opentoken_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`);
  await db.query("INSERT INTO auth.users VALUES ($1,$2,now()),($3,'unconfirmed@example.test',NULL)",
    [selected,email,other]);
  admin={query:async (sql,args)=>{
    if (!args&&sql.trim().replace(/;$/,'').includes(';')) return db.exec(sql);
    const result=await db.query(sql,args);
    return {...result,rowCount:result.rows.length||result.affectedRows||0};
  }};
  await migrate(admin);
});
after(async()=>db?.close());

test('a verified invited account is isolated and checkout starts paused',async()=>{
  const access=async id=>(await db.query('SELECT * FROM gateway.paid_pilot_access($1)',[id])).rows[0];
  assert.deepEqual(await access(selected),{eligible:false,checkout_allowed:false});
  await assert.rejects(paidPilotCommand(admin,['allow','unconfirmed@example.test']),/confirmed/i);
  assert.deepEqual(await paidPilotCommand(admin,['allow',email.toUpperCase()]),{eligible:true});
  assert.deepEqual(await paidPilotCommand(admin,['allow',email]),{eligible:true});
  assert.deepEqual(await access(selected),{eligible:true,checkout_allowed:false});
  await db.query('INSERT INTO gateway.paid_pilot_settings VALUES (true,true)');
  assert.deepEqual(await access(selected),{eligible:true,checkout_allowed:true});
  assert.deepEqual(await access(other),{eligible:false,checkout_allowed:false});
  await paidPilotCommand(admin,['pause']);
  assert.deepEqual(await access(selected),{eligible:true,checkout_allowed:false});
  await paidPilotCommand(admin,['revoke',email]);
  assert.deepEqual(await access(selected),{eligible:false,checkout_allowed:false});
});

test('preflight reports missing live configuration without sending network requests',async()=>{
  const result=await paidPilotCommand(admin,['preflight'],{env:{STRIPE_LIVE_SECRET_KEY:'sk_test_ignored'},
    fetcher:()=>assert.fail('Missing configuration must not reach Stripe')});
  assert.equal(result.ready,false);
  assert.ok(result.missing.includes('STRIPE_LIVE_SECRET_KEY'));
  assert.ok(result.missing.includes('STRIPE_LIVE_TAX_POLICY'));
});

test('live preflight only reads Stripe and rejects mismatched prices and webhook API version',async()=>{
  await paidPilotCommand(admin,['allow',email]);
  const env={
    APP_ORIGIN:'https://pilot.example.test',
    STRIPE_LIVE_SECRET_KEY:'rk_live_fixture',STRIPE_LIVE_ACCOUNT_ID:'acct_Fixture',
    STRIPE_LIVE_WEBHOOK_SECRET:'whsec_fixture',STRIPE_LIVE_WEBHOOK_ENDPOINT_ID:'we_Fixture',
    STRIPE_LIVE_CREDIT_PRICE_ID:'price_Five',STRIPE_LIVE_CREDIT_20_PRICE_ID:'price_Twenty',
    STRIPE_LIVE_CREDIT_50_PRICE_ID:'price_Fifty',STRIPE_LIVE_SUBSCRIPTION_PRICE_ID:'price_Pro',
    STRIPE_LIVE_PORTAL_CONFIGURATION_ID:'bpc_Fixture',
    STRIPE_LIVE_PILOT_COUNTRY:'CA',STRIPE_LIVE_TAX_POLICY:'stripe_tax',
  };
  const price=(id,amount)=>({id,unit_amount:amount,active:true,currency:'usd',livemode:true,tax_behavior:'exclusive',
    type:id==='price_Pro'?'recurring':'one_time',recurring:{interval:'month',interval_count:1}});
  const endpoint={id:'we_Fixture',livemode:true,status:'enabled',api_version:Stripe.API_VERSION,url:env.APP_ORIGIN+'/api/stripe/webhook',
    enabled_events:['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired',
      'customer.subscription.created','customer.subscription.updated','customer.subscription.deleted',
      'invoice.paid','invoice.payment_failed','refund.created','refund.updated','refund.failed']};
  const fixtures={
    '/v1/account':{id:'acct_Fixture',charges_enabled:true},
    '/v1/prices/price_Five':price('price_Five',500),'/v1/prices/price_Twenty':price('price_Twenty',2000),
    '/v1/prices/price_Fifty':price('price_Fifty',5000),'/v1/prices/price_Pro':price('price_Pro',1000),
    '/v1/billing_portal/configurations/bpc_Fixture':{id:'bpc_Fixture',livemode:true,active:true,
      features:{subscription_cancel:{enabled:true,mode:'at_period_end'}}},
    '/v1/webhook_endpoints/we_Fixture':endpoint,
    '/v1/tax/settings':{livemode:true,status:'active'},
  };
  async function fetcher(input,request) {
    const url=new URL(input);
    assert.equal(url.origin,'https://api.stripe.com');
    assert.equal(request.method,'GET');
    assert.equal(request.redirect,'error');
    assert.equal(request.headers['stripe-version'],Stripe.API_VERSION);
    assert.ok(fixtures[url.pathname]);
    return Response.json(fixtures[url.pathname]);
  }
  assert.equal((await paidPilotCommand(admin,['preflight'],{env,fetcher})).ready,true);
  fixtures['/v1/prices/price_Fifty'].livemode=false;
  endpoint.api_version='unverified';
  const report=await paidPilotCommand(admin,['preflight'],{env,fetcher});
  assert.equal(report.ready,false);
  assert.deepEqual(report.issues,['unexpected_live_price:STRIPE_LIVE_CREDIT_50_PRICE_ID','unexpected_live_webhook']);
});

test('production pilot membership and sandbox are mutually exclusive and private',async()=>{
  await assert.rejects(enableStripeSandbox(admin),/paid pilot/i);
  await db.exec('SET ROLE opentoken_app');
  try {
    await assert.rejects(db.query('SELECT * FROM gateway.paid_pilot_accounts'),{code:'42501'});
    await assert.rejects(db.query('UPDATE gateway.paid_pilot_settings SET checkout_enabled=true'),{code:'42501'});
  } finally {await db.exec('RESET ROLE');}
  await paidPilotCommand(admin,['revoke',email]);
  await db.query('DELETE FROM gateway.paid_pilot_settings');
  await enableStripeSandbox(admin);
  await assert.rejects(paidPilotCommand(admin,['allow',email]),/outside the Stripe sandbox/i);
});
