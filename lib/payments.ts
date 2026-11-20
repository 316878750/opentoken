import Stripe from 'stripe';
import type { PoolClient } from 'pg';
import { store, transaction } from './data';
import { Fault } from './gateway';

type Kind = 'credit'|'subscription';
type Order = {
  id:string;user_id:string;kind:Kind;price_id:string;amount_cents:number;state:'open'|'paid'|'expired';
  checkout_id:string|null;payment_id:string|null;customer_id:string|null;subscription_id:string|null;
  subscription_status:string|null;created_at:Date;expires_at:Date;
};

function config() {
  const {STRIPE_TEST_SECRET_KEY:key,STRIPE_TEST_WEBHOOK_SECRET:signature,
    STRIPE_TEST_CREDIT_PRICE_ID:credit,STRIPE_TEST_SUBSCRIPTION_PRICE_ID:subscription} = process.env;
  if (!key || !/^sk_test_[\w]+$/.test(key) || !signature || !/^whsec_[\w]+$/.test(signature) ||
    !credit || !/^price_[\w]+$/.test(credit) || !subscription || !/^price_[\w]+$/.test(subscription)) return null;
  return {key,signature,credit,subscription};
}

function sandbox() {
  const settings = config();
  if (!settings) throw new Fault(503,'stripe_test_disabled','Stripe 测试支付尚未配置。');
  const stripe = new Stripe(settings.key,{timeout:8000,maxNetworkRetries:0,
    httpClient:Stripe.createFetchHttpClient((input,init)=>fetch(input,{...init,redirect:'error'}))});
  return {stripe,settings};
}

async function isSandboxDatabase() {
  const {rows:[row]} = await store().db.query<{enabled:boolean}>('SELECT EXISTS (SELECT 1 FROM gateway.stripe_sandbox) AS enabled');
  return row.enabled;
}

async function requireSandboxDatabase() {
  if (!await isSandboxDatabase()) throw new Fault(503,'stripe_test_disabled','当前数据库未开通 Stripe 沙盒。');
}

function link(url:string|null,hostname:string) {
  if (!url) throw new Fault(502,'stripe_unavailable','Stripe 未返回可用地址。');
  const parsed = new URL(url);
  if (parsed.origin!=='https://'+hostname || parsed.username || parsed.password) {
    throw new Fault(502,'stripe_unavailable','Stripe 未返回可用地址。');
  }
  return parsed.href;
}

export async function billing(user:string) {
  if (!config() || !await isSandboxDatabase()) return {enabled:false,orders:[],canManage:false};
  const {rows:orders} = await store().db.query(`SELECT id,kind,amount_cents AS "amountCents",
    state,
    subscription_status AS "subscriptionStatus",period_end AS "periodEnd",created_at AS "createdAt",
    (customer_id IS NOT NULL AND subscription_id IS NOT NULL AND kind='subscription') AS "hasCustomer"
    FROM gateway.stripe_orders WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25`,[user]);
  return {enabled:true,orders:orders.map(({hasCustomer,...order})=>order),canManage:orders.some(order=>order.hasCustomer)};
}

async function openOrder(user:string,kind:Kind,nonce:string,stripe:Stripe,priceId:string) {
  async function existing(db:PoolClient|ReturnType<typeof store>['db']) {
    return (await db.query<Order>('SELECT * FROM gateway.stripe_orders WHERE user_id=$1 AND nonce=$2',[user,nonce])).rows[0];
  }
  const previous = await existing(store().db);
  if (previous) return previous;
  if (kind==='subscription') await recoverSubscriptionCheckout(user,stripe);
  const price = await stripe.prices.retrieve(priceId);
  const cents = price.unit_amount;
  if (price.livemode!==false || !price.active || price.currency!=='usd' || !cents ||
    !Number.isSafeInteger(cents) || cents<1 || cents>2_147_483_647 ||
    (kind==='credit' ? price.type!=='one_time' : price.type!=='recurring')) {
    throw new Fault(503,'stripe_price_invalid','请配置有效的美元 Stripe 测试价格。');
  }
  return transaction(async tx => {
    await tx.query('SELECT 1 FROM gateway.wallets WHERE user_id=$1 FOR UPDATE',[user]);
    const raced = await existing(tx);
    if (raced) return raced;
    let customer:string|null = null;
    if (kind==='subscription') {
      const {rows:[latest]} = await tx.query<{customer_id:string|null;blocked:boolean}>(`SELECT
        (SELECT customer_id FROM gateway.stripe_orders WHERE user_id=$1 AND kind='subscription' AND customer_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 1) AS customer_id,
        EXISTS (SELECT 1 FROM gateway.stripe_orders WHERE user_id=$1 AND kind='subscription' AND (
          state='open' OR
          (subscription_id IS NOT NULL AND coalesce(subscription_status,'pending') NOT IN ('canceled','incomplete_expired'))
        )) AS blocked`,[user]);
      if (latest.blocked) throw new Fault(409,'stripe_subscription_exists','已有订阅或待完成的结账。');
      customer = latest.customer_id;
    }
    const {rows:[order]} = await tx.query<Order>(`INSERT INTO gateway.stripe_orders (user_id,kind,nonce,price_id,amount_cents,customer_id)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,[user,kind,nonce,priceId,cents,customer]);
    return order;
  });
}

export async function startCheckout(user:string,kind:Kind,nonce:string,origin:string) {
  const {stripe,settings} = sandbox();
  await requireSandboxDatabase();
  const order = await openOrder(user,kind,nonce,stripe,settings[kind]);
  if (order.kind!==kind || order.state!=='open' || order.expires_at.getTime()<=Date.now()) {
    throw new Fault(409,'stripe_order_closed','此结账请求已完成、过期或不匹配。');
  }
  const metadata = {opentoken_order:order.id,opentoken_price:order.price_id};
  const session = order.checkout_id ? await stripe.checkout.sessions.retrieve(order.checkout_id) :
    await stripe.checkout.sessions.create({
      mode:kind==='credit' ? 'payment' : 'subscription',line_items:[{price:order.price_id,quantity:1}],
      client_reference_id:order.id,metadata,expires_at:Math.floor(order.expires_at.getTime()/1000),
      success_url:origin+'/redeem?checkout=success',cancel_url:origin+'/redeem?checkout=cancel',
      ...(kind==='subscription' ? {subscription_data:{metadata},...(order.customer_id ? {customer:order.customer_id} : {})} : {}),
    },{idempotencyKey:'opentoken-checkout-'+order.id});
  if (session.livemode!==false || !session.id.startsWith('cs_test_') ||
    session.client_reference_id!==order.id || session.metadata?.opentoken_price!==order.price_id) {
    throw new Fault(502,'stripe_unavailable','Stripe 返回的测试订单不匹配。');
  }
  if (session.status && session.status!=='open') {
    throw new Fault(409,'stripe_order_closed','此结账已结束。请刷新订单以确认状态。');
  }
  const url = link(session.url,'checkout.stripe.com');
  const {rowCount} = await store().db.query(`UPDATE gateway.stripe_orders SET checkout_id=$2
    WHERE id=$1 AND (checkout_id IS NULL OR checkout_id=$2)`,[order.id,session.id]);
  if (!rowCount) throw new Fault(502,'stripe_unavailable','Stripe 测试订单发生冲突。');
  return {id:order.id,url};
}

export async function startPortal(user:string,origin:string) {
  const {stripe} = sandbox();
  await requireSandboxDatabase();
  const {rows:[order]} = await store().db.query<{customer_id:string}>(`SELECT customer_id FROM gateway.stripe_orders
    WHERE user_id=$1 AND kind='subscription' AND customer_id IS NOT NULL AND subscription_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1`,[user]);
  if (!order) throw new Fault(404,'stripe_subscription_missing','没有可以管理的测试订阅。');
  const portal = await stripe.billingPortal.sessions.create({customer:order.customer_id,return_url:origin+'/redeem'});
  if (portal.livemode!==false) throw new Fault(502,'stripe_unavailable','Stripe 返回的订阅管理地址不匹配。');
  return {url:link(portal.url,'billing.stripe.com')};
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type StripeReference = string|{id:string}|null|undefined;
function identifier(value:StripeReference) {
  return typeof value==='string' ? value : value?.id ?? null;
}

async function lockOrder(tx:PoolClient,id:string|undefined) {
  if (!id || !uuid.test(id)) return;
  const {rows:[owner]} = await tx.query<{user_id:string}>('SELECT user_id FROM gateway.stripe_orders WHERE id=$1',[id]);
  if (!owner) return;
  await tx.query('SELECT 1 FROM gateway.wallets WHERE user_id=$1 FOR UPDATE',[owner.user_id]);
  return (await tx.query<Order>('SELECT * FROM gateway.stripe_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
}

async function recoverSubscriptionCheckout(user:string,stripe:Stripe) {
  const {rows:[stale]} = await store().db.query<Order>(`SELECT * FROM gateway.stripe_orders
    WHERE user_id=$1 AND kind='subscription' AND state='open' AND expires_at<=now()
    ORDER BY created_at DESC LIMIT 1`,[user]);
  if (!stale) return;
  let session:Stripe.Checkout.Session|undefined;
  if (stale.checkout_id) {
    session = await stripe.checkout.sessions.retrieve(stale.checkout_id);
  } else {
    const created = {gte:Math.floor(stale.created_at.getTime()/1000)-300,lte:Math.floor(stale.expires_at.getTime()/1000)+300};
    let inspected = 0;
    for await (const candidate of stripe.checkout.sessions.list({created,limit:100})) {
      if (++inspected>500) throw new Fault(503,'stripe_checkout_unconfirmed','请稍后重试或联系运营核对旧结账。');
      if (candidate.client_reference_id!==stale.id) continue;
      if (session) throw new Fault(503,'stripe_checkout_unconfirmed','旧结账存在多条 Stripe 记录，需运营核对。');
      session = candidate;
    }
  }
  if (session?.status==='expired') {
    const expired = session;
    await transaction(tx=>checkoutEvent(tx,expired,'expired'));
    return;
  }
  await transaction(async tx=>{
    const order = await lockOrder(tx,stale.id);
    if (!order || order.state!=='open') return;
    if (session) {
      validateCheckout(order,session);
      await tx.query('UPDATE gateway.stripe_orders SET checkout_id=$2 WHERE id=$1',[order.id,session.id]);
    } else if (!order.checkout_id && !order.subscription_id) {
      await tx.query("UPDATE gateway.stripe_orders SET state='expired' WHERE id=$1",[order.id]);
    }
  });
}

function validateCheckout(order:Order,session:Stripe.Checkout.Session) {
  if (session.livemode!==false || !session.id.startsWith('cs_test_') || session.client_reference_id!==order.id ||
    session.metadata?.opentoken_order!==order.id || session.metadata?.opentoken_price!==order.price_id ||
    session.currency!=='usd' || session.amount_total!==order.amount_cents ||
    session.mode!==(order.kind==='credit' ? 'payment' : 'subscription') ||
    (order.checkout_id && order.checkout_id!==session.id)) throw new Error('Stripe checkout does not match the test order');
}

async function checkoutEvent(tx:PoolClient,session:Stripe.Checkout.Session,closed?:'expired'|'failed') {
  const order = await lockOrder(tx,session.metadata?.opentoken_order);
  if (!order) return;
  validateCheckout(order,session);
  if (closed) {
    if (closed==='expired' && session.status!=='expired') throw new Error('Stripe checkout has not expired');
    if (order.state==='open' && session.payment_status!=='paid' && !session.subscription) {
      await tx.query("UPDATE gateway.stripe_orders SET state='expired',checkout_id=$2 WHERE id=$1",[order.id,session.id]);
    }
    return;
  }
  if (session.payment_status!=='paid') return;
  if (order.kind==='credit') {
    const payment = identifier(session.payment_intent);
    if (!payment?.startsWith('pi_') || (order.payment_id && order.payment_id!==payment)) throw new Error('Stripe test payment mismatch');
    await tx.query("UPDATE gateway.stripe_orders SET state='paid',checkout_id=$2,payment_id=$3 WHERE id=$1",[order.id,session.id,payment]);
    await tx.query('SELECT gateway.credit_stripe_test_order($1)',[order.id]);
    return;
  }
  const subscription = identifier(session.subscription);
  const customer = identifier(session.customer);
  if (!subscription?.startsWith('sub_') || !customer?.startsWith('cus_') ||
    (order.subscription_id && order.subscription_id!==subscription) ||
    (order.customer_id && order.customer_id!==customer)) throw new Error('Stripe test subscription mismatch');
  await tx.query("UPDATE gateway.stripe_orders SET state='paid',checkout_id=$2,subscription_id=$3,customer_id=$4 WHERE id=$1",
    [order.id,session.id,subscription,customer]);
}

async function syncSubscription(tx:PoolClient,stripe:Stripe,id:string,orderId?:string) {
  const reference = orderId ?? (await tx.query<{id:string}>('SELECT id FROM gateway.stripe_orders WHERE subscription_id=$1',[id])).rows[0]?.id;
  const order = await lockOrder(tx,reference);
  if (!order || order.subscription_status==='canceled' || order.subscription_status==='incomplete_expired') return;
  // Read the authoritative state under the per-order lock so retries and out-of-order events cannot revert a subscription.
  const subscription = await stripe.subscriptions.retrieve(id);
  const customer = identifier(subscription.customer);
  const [item] = subscription.items.data;
  if (subscription.livemode!==false || subscription.metadata.opentoken_order!==order.id || order.kind!=='subscription' ||
    !customer?.startsWith('cus_') || (order.customer_id && order.customer_id!==customer) ||
    (order.subscription_id && order.subscription_id!==subscription.id) ||
    subscription.items.data.length!==1 || item.price.id!==order.price_id ||
    !Number.isSafeInteger(item.current_period_end) || item.current_period_end<=0) throw new Error('Stripe test subscription mismatch');
  await tx.query(`UPDATE gateway.stripe_orders SET subscription_id=$2,customer_id=$3,subscription_status=$4,
    period_end=to_timestamp($5) WHERE id=$1`,[order.id,subscription.id,customer,subscription.status,item.current_period_end]);
}

const handledEvents = new Set([
  'checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired',
  'customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.payment_failed',
]);

export async function receiveStripeWebhook(payload:string,signature:string|null) {
  const {stripe,settings} = sandbox();
  let event:Stripe.Event;
  try {
    if (!signature) throw new Error('Missing signature');
    event = stripe.webhooks.constructEvent(payload,signature,settings.signature);
    if (event.livemode!==false || !/^evt_[\w]+$/.test(event.id)) throw new Error('Test event required');
  } catch {
    throw new Fault(400,'stripe_event_invalid','Stripe 测试事件验签失败。');
  }
  if (!handledEvents.has(event.type)) return;
  await requireSandboxDatabase();
  await transaction(async tx => {
    const {rowCount} = await tx.query('INSERT INTO gateway.stripe_events (id,kind) VALUES ($1,$2) ON CONFLICT DO NOTHING',[event.id,event.type]);
    if (!rowCount) return;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await checkoutEvent(tx,event.data.object);
        break;
      case 'checkout.session.async_payment_failed':
        await checkoutEvent(tx,event.data.object,'failed');
        break;
      case 'checkout.session.expired':
        await checkoutEvent(tx,event.data.object,'expired');
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSubscription(tx,stripe,event.data.object.id,event.data.object.metadata.opentoken_order);
        break;
      case 'invoice.payment_failed': {
        const subscription = identifier(event.data.object.parent?.subscription_details?.subscription);
        if (subscription) await syncSubscription(tx,stripe,subscription);
        break;
      }
    }
  });
}
