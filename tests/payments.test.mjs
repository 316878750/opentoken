import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {after,before,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {enableStripeSandbox,migrate,seed} from '../scripts/database.mjs';
import {stripeCommand} from '../scripts/stripe-ops.mjs';

const user='824f5ed4-d1b9-4449-b3b2-db1e999f25b5';
const email='wallet-fixture@example.test';
let db;
let admin;

before(async () => {
  db=await PGlite.create();
  await db.exec(`CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text NOT NULL,email_confirmed_at timestamptz);
    CREATE ROLE opentoken_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`);
  await db.query('INSERT INTO auth.users VALUES ($1,$2,now())',[user,email]);
  admin={query:async (sql,values)=>{
    if (!values&&sql.trim().replace(/;$/,'').includes(';')) return db.exec(sql);
    const result=await db.query(sql,values);
    return {...result,rowCount:result.rows.length||result.affectedRows||0};
  }};
  await migrate(admin);
  await enableStripeSandbox(admin);
  await seed(admin,email,[]);
});
after(async ()=>db?.close());

async function credit(cents,owner=user) {
  const order=randomUUID(), suffix=order.replaceAll('-',''), payment='pi_'+suffix;
  await db.query(`INSERT INTO gateway.stripe_orders
    (id,user_id,kind,nonce,price_id,amount_cents,state,checkout_id,payment_id,paid_at)
    VALUES ($1,$2,'credit',$1,'price_fixture',$3,'paid',$4,$5,now())`,
    [order,owner,cents,'cs_test_'+suffix,payment]);
  await db.query('SELECT gateway.credit_stripe_test_order($1)',[order]);
  return {order,payment};
}

async function approve(id,order,cents) {
  return (await db.query("SELECT gateway.approve_stripe_refund($1,$2,$3,'fixture operator') AS state",[id,order,cents])).rows[0].state;
}

async function apply(id,payment,cents,state) {
  await db.query('SELECT gateway.apply_stripe_refund($1,$2,$3,$4,$5)',
    [id,'re_'+id.replaceAll('-',''),payment,cents,state]);
}

test('refund hold and ledger are idempotent, and a late failure restores the original credit',async ()=>{
  const {order,payment}=await credit(500);
  const refund=randomUUID();
  assert.equal(await approve(refund,order,500),'approved');
  assert.equal(await approve(refund,order,500),'approved');
  await assert.rejects(approve(randomUUID(),order,1),/refundable/i);
  const wallet=async()=>{
    const {rows:[row]}=await db.query(`SELECT balance_micros::text AS balance,refund_held_micros::text AS held
      FROM gateway.wallets WHERE user_id=$1`,[user]);
    return row;
  };
  assert.deepEqual(await wallet(),{balance:'15000000',held:'5000000'});
  await apply(refund,payment,500,'pending');
  await apply(refund,payment,500,'succeeded');
  await apply(refund,payment,500,'succeeded');
  assert.deepEqual(await wallet(),{balance:'10000000',held:'0'});
  await apply(refund,payment,500,'failed');
  await apply(refund,payment,500,'succeeded');
  assert.deepEqual(await wallet(),{balance:'15000000',held:'0'});
  const {rows}=await db.query('SELECT kind,delta_micros::text AS amount FROM gateway.wallet_entries WHERE refund_id=$1 ORDER BY kind',[refund]);
  assert.deepEqual(rows,[{kind:'stripe_refund',amount:'-5000000'},{kind:'stripe_refund_reversal',amount:'5000000'}]);
  await db.exec('SET ROLE opentoken_app');
  try {
    await assert.rejects(approve(randomUUID(),order,1),{code:'42501'});
    await assert.rejects(db.query('UPDATE gateway.wallet_credit_lots SET remaining_micros=0'),{code:'42501'});
    await assert.rejects(db.query('UPDATE gateway.wallets SET refund_held_micros=0'),{code:'42501'});
  } finally {await db.exec('RESET ROLE');}
});

test('gift credits are consumed before paid lots and active usage limits the original-order refund',async ()=>{
  const owner=randomUUID(), secondEmail='fifo-wallet@example.test';
  await db.query('INSERT INTO auth.users VALUES ($1,$2,now())',[owner,secondEmail]);
  await seed(admin,secondEmail,[]);
  const first=await credit(500,owner);
  const second=await credit(2000,owner);
  const outsideWindow=await credit(5000,owner);
  await db.query("UPDATE gateway.stripe_orders SET paid_at=now()-interval '31 days' WHERE id=$1",[outsideWindow.order]);
  await assert.rejects(approve(randomUUID(),outsideWindow.order,100),/window/i);
  const {rows:[rate]}=await db.query(`SELECT r.id,r.group_id,r.model_id FROM gateway.model_rates r
    JOIN gateway.models m ON m.id=r.model_id WHERE m.code='mock-text'`);
  const {rows:[key]}=await db.query(`INSERT INTO gateway.api_keys(user_id,group_id,name,public_prefix,secret_digest,rpm_limit)
    VALUES ($1,$2,'billing fixture','fixture',$3,10) RETURNING id`,[owner,rate.group_id,randomBytes(32)]);
  const {rows:[usage]}=await db.query(`INSERT INTO gateway.usage_requests(user_id,key_id,group_id,model_id,rate_id,
    upstream_model_snapshot,reserved_micros,status,input_tokens,cached_input_tokens,output_tokens,
    standard_micros,charged_micros,finalized_at)
    VALUES ($1,$2,$3,$4,$5,'mock-text',16000000,'settled',1,0,0,16000000,16000000,now()) RETURNING id`,
    [owner,key.id,rate.group_id,rate.model_id,rate.id]);
  await db.query("INSERT INTO gateway.wallet_entries(user_id,request_id,kind,delta_micros) VALUES ($1,$2,'usage',-16000000)",[owner,usage.id]);
  await db.query('UPDATE gateway.wallets SET balance_micros=balance_micros-16000000,held_micros=2000000 WHERE user_id=$1',[owner]);
  await assert.rejects(approve(randomUUID(),first.order,1),/exceeds/i);
  await assert.rejects(approve(randomUUID(),second.order,1701),/exceeds/i);
  const refund=randomUUID();
  await approve(refund,second.order,1700);
  await apply(refund,second.payment,1700,'failed');
  const {rows:[row]}=await db.query(`SELECT w.refund_held_micros::text AS held,l.remaining_micros::text AS remaining,
    (SELECT count(*)::int FROM gateway.wallet_entries WHERE refund_id=$2) AS entries
    FROM gateway.wallets w JOIN gateway.wallet_credit_lots l USING(user_id) WHERE l.stripe_order_id=$1`,[second.order,refund]);
  assert.deepEqual(row,{held:'0',remaining:'19000000',entries:0});
});

test('backfilled paid invoices restore Pro through cancellation and downgrade after expiry',async ()=>{
  const owner=randomUUID(),email='plan-wallet@example.test',order=randomUUID();
  await db.query('INSERT INTO auth.users VALUES ($1,$2,now())',[owner,email]);
  await seed(admin,email,[]);
  const plan=async()=> (await db.query('SELECT * FROM gateway.sandbox_billing_limits($1)',[owner])).rows[0];
  assert.deepEqual(await plan(),{rpm:10,active_keys:5});
  await db.query(`INSERT INTO gateway.stripe_orders(id,user_id,nonce,kind,price_id,amount_cents,state,subscription_status,subscription_id,customer_id)
    VALUES ($1,$2,$1,'subscription','price_fixture',1000,'paid','active','sub_plan_fixture','cus_plan_fixture')`,[order,owner]);
  assert.deepEqual(await plan(),{rpm:10,active_keys:5});
  await db.query("INSERT INTO gateway.stripe_events(id,kind) VALUES ('evt_v005_invoice','invoice.paid')");
  const now=Math.floor(Date.now()/1000);
  const invoice={id:'in_plan_fixture',object:'invoice',livemode:false,status:'paid',currency:'usd',amount_paid:1000,
    billing_reason:'subscription_create',lines:{has_more:false,data:[{amount:1000,
      pricing:{price_details:{price:'price_fixture'}},period:{start:now-86400,end:now+86400}}]}};
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=async input=>{
    const url=new URL(input);
    assert.equal(url.origin,'https://api.stripe.com');
    if (url.pathname==='/v1/subscriptions/sub_plan_fixture') return Response.json({
      id:'sub_plan_fixture',object:'subscription',livemode:false,customer:'cus_plan_fixture',metadata:{opentoken_order:order},
    });
    assert.equal(url.pathname,'/v1/invoices');
    assert.equal(url.searchParams.get('subscription'),'sub_plan_fixture');
    return Response.json({object:'list',has_more:false,data:[invoice]});
  };
  try {
    const result=await stripeCommand(admin,['sync-invoices',order.toUpperCase()],'sk_test_fixture');
    assert.deepEqual(result.issues,[]);
    assert.equal(result.localInvoices.length,1);
    await stripeCommand(admin,['sync-invoices',order],'sk_test_fixture');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM gateway.stripe_invoices WHERE order_id=$1',[order])).rows[0].count,1);
  } finally {globalThis.fetch=nativeFetch;}
  for (const status of ['active','past_due','canceled']) {
    await db.query('UPDATE gateway.stripe_orders SET subscription_status=$2 WHERE id=$1',[order,status]);
    assert.deepEqual(await plan(),{rpm:60,active_keys:20});
  }
  await db.query("UPDATE gateway.stripe_invoices SET period_end=now()-interval '1 minute' WHERE order_id=$1",[order]);
  assert.deepEqual(await plan(),{rpm:10,active_keys:5});
});

test('an unsubmitted approval can be released once after the operator review window',async ()=>{
  const owner=randomUUID(),email='refund-operator@example.test';
  await db.query('INSERT INTO auth.users VALUES ($1,$2,now())',[owner,email]);
  await seed(admin,email,[]);
  const {order}=await credit(500,owner);
  const id=randomUUID();
  await approve(id,order,500);
  await db.query('UPDATE gateway.stripe_refunds SET last_submitted_at=now() WHERE id=$1',[id]);
  const release=()=>db.query("SELECT gateway.release_unsent_stripe_refund($1,'confirmed no remote refund')",[id]);
  await assert.rejects(release(),/unsubmitted/i);
  await db.query("UPDATE gateway.stripe_refunds SET last_submitted_at=now()-interval '20 minutes' WHERE id=$1",[id]);
  await release();
  await release();
  const {rows:[row]}=await db.query(`SELECT r.state,w.refund_held_micros::text AS held,w.balance_micros::text AS balance
    FROM gateway.stripe_refunds r JOIN gateway.wallets w USING(user_id) WHERE r.id=$1`,[id]);
  assert.deepEqual(row,{state:'canceled',held:'0',balance:'15000000'});
});
