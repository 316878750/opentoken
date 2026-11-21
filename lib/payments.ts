import Stripe from 'stripe';
import type { PoolClient } from 'pg';
import { lockAccount, store, transaction } from './data';
import { Fault } from './gateway';
import { accountRevision } from './session';
import { findStripeCheckout, validateStripeCheckout } from './stripe-checkout.mjs';
import { recordPaidInvoice } from './stripe-invoices.mjs';

type Kind = 'credit'|'subscription';
type RechargeCents = 500|2000|5000;
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
  const creditPrices = {500:credit,2000:process.env.STRIPE_TEST_CREDIT_20_PRICE_ID,5000:process.env.STRIPE_TEST_CREDIT_50_PRICE_ID};
  return {key,signature,creditPrices,subscription};
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
  const settings=config();
  if (!settings || !await isSandboxDatabase()) return {enabled:false,orders:[],canManage:false};
  const db=store().db;
  const {rows:orders} = await db.query(`SELECT o.id,o.kind,o.amount_cents AS "amountCents",o.state,
    o.subscription_status AS "subscriptionStatus",o.period_end AS "periodEnd",o.created_at AS "createdAt",
    (o.customer_id IS NOT NULL AND o.subscription_id IS NOT NULL AND o.kind='subscription') AS "hasCustomer",
    coalesce((SELECT sum(r.amount_cents)::int FROM gateway.stripe_refunds r WHERE r.order_id=o.id AND r.state='succeeded'),0) AS "refundedCents",
    EXISTS(SELECT 1 FROM gateway.stripe_refunds r WHERE r.order_id=o.id AND r.state IN ('approved','pending')) AS "refundPending"
    FROM gateway.stripe_orders o WHERE o.user_id=$1 ORDER BY o.created_at DESC,o.id DESC LIMIT 25`,[user]);
  const {rows:invoices}=await db.query(`SELECT i.stripe_id AS id,i.amount_cents AS "amountCents",i.reason,
    i.period_start AS "periodStart",i.period_end AS "periodEnd"
    FROM gateway.stripe_invoices i JOIN gateway.stripe_orders o ON o.id=i.order_id
    WHERE o.user_id=$1 ORDER BY i.period_start DESC,i.stripe_id LIMIT 25`,[user]);
  const {rows:[limits]}=await db.query('SELECT rpm,active_keys AS "activeKeys" FROM gateway.sandbox_billing_limits($1)',[user]);
  const rechargeOptions=Object.entries(settings.creditPrices).filter(([,id])=>id && /^price_[\w]+$/.test(id)).map(([cents])=>Number(cents));
  return {enabled:true,orders:orders.map(({hasCustomer,...order})=>order),invoices,limits,rechargeOptions,
    canManage:orders.some(order=>order.hasCustomer)};
}

async function openOrder(user:string,kind:Kind,nonce:string,stripe:Stripe,priceId:string,expectedCents:number) {
  async function existing(db:PoolClient|ReturnType<typeof store>['db']) {
    return (await db.query<Order>('SELECT * FROM gateway.stripe_orders WHERE user_id=$1 AND nonce=$2',[user,nonce])).rows[0];
  }
  const previous = await existing(store().db);
  if (previous) return previous;
  if (kind==='subscription') await recoverSubscriptionCheckout(user,stripe);
  const price = await stripe.prices.retrieve(priceId);
  const cents = price.unit_amount;
  if (price.livemode!==false || !price.active || price.currency!=='usd' || !cents ||
    cents!==expectedCents || (kind==='credit' ? price.type!=='one_time' : price.type!=='recurring' ||
      price.recurring?.interval!=='month' || price.recurring.interval_count!==1)) {
    throw new Fault(503,'stripe_price_invalid','请配置有效的美元 Stripe 测试价格。');
  }
  return transaction(async tx => {
    await lockAccount(tx,user);
    const wallet = await tx.query(`SELECT 1 FROM gateway.wallets WHERE user_id=$1
      AND gateway.account_access(user_id) IS NOT NULL FOR UPDATE`,[user]);
    if (!wallet.rowCount) throw new Fault(401,'session_required','请重新登录。');
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

export async function startCheckout(user:string,kind:Kind,nonce:string,origin:string,amount?:RechargeCents) {
  const {stripe,settings} = sandbox();
  await requireSandboxDatabase();
  const expectedCents=kind==='credit' ? amount??500 : 1000;
  const priceId=kind==='credit' ? settings.creditPrices[amount??500] : settings.subscription;
  if (!priceId || !/^price_[\w]+$/.test(priceId)) throw new Fault(503,'stripe_price_invalid','此金额的 Stripe 测试价格尚未配置。');
  const order = await openOrder(user,kind,nonce,stripe,priceId,expectedCents);
  if (order.kind!==kind || order.amount_cents!==expectedCents || order.state!=='open' || order.expires_at.getTime()<=Date.now()) {
    throw new Fault(409,'stripe_order_closed','此结账请求已完成、过期或不匹配。');
  }
  const metadata = {opentoken_order:order.id,opentoken_price:order.price_id};
  const session = order.checkout_id ? await stripe.checkout.sessions.retrieve(order.checkout_id) :
    await stripe.checkout.sessions.create({
      mode:kind==='credit' ? 'payment' : 'subscription',line_items:[{price:order.price_id,quantity:1}],
      client_reference_id:order.id,metadata,expires_at:Math.floor(order.expires_at.getTime()/1000),
      success_url:origin+'/redeem?checkout=success',cancel_url:origin+'/redeem?checkout=cancel',
      ...(kind==='subscription' ? {subscription_data:{metadata},...(order.customer_id ? {customer:order.customer_id} : {})} :
        {payment_intent_data:{metadata}}),
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
  const configuration = process.env.STRIPE_TEST_PORTAL_CONFIGURATION_ID?.trim() || undefined;
  if (configuration && !/^bpc_\w+$/.test(configuration)) {
    throw new Fault(503,'stripe_portal_invalid','请配置有效的 Stripe 测试客户门户。');
  }
  const {rows:[order]} = await store().db.query<{customer_id:string}>(`SELECT customer_id FROM gateway.stripe_orders
    WHERE user_id=$1 AND kind='subscription' AND customer_id IS NOT NULL AND subscription_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1`,[user]);
  if (!order) throw new Fault(404,'stripe_subscription_missing','没有可以管理的测试订阅。');
  const selected = configuration ? await stripe.billingPortal.configurations.retrieve(configuration) :
    (await stripe.billingPortal.configurations.list({is_default:true,active:true,limit:1})).data[0];
  if (!selected || selected.livemode!==false || !selected.active ||
    !selected.features.subscription_cancel.enabled || selected.features.subscription_cancel.mode!=='at_period_end') {
    throw new Fault(503,'stripe_portal_invalid','请将 Stripe 测试门户配置为账期结束时取消续费。');
  }
  if (await accountRevision(user)===null) throw new Fault(401,'session_required','请重新登录。');
  const portal = await stripe.billingPortal.sessions.create({customer:order.customer_id,return_url:origin+'/redeem',configuration:selected.id});
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
  try { session = await findStripeCheckout(stripe,stale); }
  catch { throw new Fault(503,'stripe_checkout_unconfirmed','旧结账状态未确认，请稍后重试或联系运营核对。'); }
  if (session?.status==='expired') {
    const expired = session;
    await transaction(tx=>checkoutEvent(tx,expired,'expired'));
    return;
  }
  await transaction(async tx=>{
    const order = await lockOrder(tx,stale.id);
    if (!order || order.state!=='open') return;
    if (session) {
      validateStripeCheckout(order,session);
      await tx.query('UPDATE gateway.stripe_orders SET checkout_id=$2 WHERE id=$1',[order.id,session.id]);
    } else if (!order.checkout_id && !order.subscription_id) {
      await tx.query("UPDATE gateway.stripe_orders SET state='expired' WHERE id=$1",[order.id]);
    }
  });
}

async function checkoutEvent(tx:PoolClient,session:Stripe.Checkout.Session,closed?:'expired'|'failed',paidAt?:number) {
  const order = await lockOrder(tx,session.metadata?.opentoken_order);
  if (!order) return;
  validateStripeCheckout(order,session);
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
    await tx.query("UPDATE gateway.stripe_orders SET state='paid',checkout_id=$2,payment_id=$3,paid_at=coalesce(paid_at,to_timestamp($4)) WHERE id=$1",
      [order.id,session.id,payment,paidAt]);
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

async function syncSubscription(tx:PoolClient,stripe:Stripe,id:string,orderId?:string,paidInvoice?:Stripe.Invoice) {
  const reference = orderId ?? (await tx.query<{id:string}>('SELECT id FROM gateway.stripe_orders WHERE subscription_id=$1',[id])).rows[0]?.id;
  const order = await lockOrder(tx,reference);
  if (!order) return;
  if (order.subscription_id && order.subscription_id!==id) throw new Error('Stripe test subscription mismatch');
  const ended=order.subscription_status==='canceled'||order.subscription_status==='incomplete_expired';
  if (ended && !paidInvoice) return;
  // Read the authoritative state under the per-order lock so retries and out-of-order events cannot revert a subscription.
  const subscription = await stripe.subscriptions.retrieve(id);
  const customer = identifier(subscription.customer);
  const [item] = subscription.items.data;
  if (subscription.livemode!==false || subscription.metadata.opentoken_order!==order.id || order.kind!=='subscription' ||
    !customer?.startsWith('cus_') || (order.customer_id && order.customer_id!==customer) ||
    (order.subscription_id && order.subscription_id!==subscription.id) ||
    subscription.items.data.length!==1 || item.price.id!==order.price_id ||
    !Number.isSafeInteger(item.current_period_end) || item.current_period_end<=0) throw new Error('Stripe test subscription mismatch');
  if (paidInvoice) await recordPaidInvoice(tx,order,paidInvoice);
  if (ended) return;
  await tx.query(`UPDATE gateway.stripe_orders SET subscription_id=$2,customer_id=$3,subscription_status=$4,
    period_end=to_timestamp($5) WHERE id=$1`,[order.id,subscription.id,customer,subscription.status,item.current_period_end]);
}

async function syncRefund(tx:PoolClient,stripe:Stripe,eventRefund:Stripe.Refund) {
  if (!/^re_[\w]+$/.test(eventRefund.id)) throw new Error('Stripe refund id is invalid');
  const request = eventRefund.metadata?.opentoken_refund;
  const linked = uuid.test(request??'') ?
    (await tx.query<{id:string;order_id:string}>('SELECT id,order_id FROM gateway.stripe_refunds WHERE id=$1',[request])).rows[0] :
    (await tx.query<{id:string;order_id:string}>('SELECT id,order_id FROM gateway.stripe_refunds WHERE stripe_id=$1',[eventRefund.id])).rows[0];
  if (!linked) return;
  const refund=await stripe.refunds.retrieve(eventRefund.id);
  if (refund.id!==eventRefund.id || refund.currency!=='usd' || refund.metadata?.opentoken_refund!==linked.id ||
    refund.metadata?.opentoken_order!==linked.order_id) throw new Error('Stripe refund metadata does not match local approval');
  const state=refund.status==='requires_action' ? 'pending' : refund.status;
  await tx.query('SELECT gateway.apply_stripe_refund($1,$2,$3,$4,$5)',[linked.id,refund.id,identifier(refund.payment_intent),refund.amount,state]);
}

const handledEvents = new Set([
  'checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired',
  'customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed',
  'refund.created','refund.updated','refund.failed',
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
        await checkoutEvent(tx,event.data.object,undefined,event.created);
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
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const details=event.data.object.parent?.subscription_details;
        const subscription = identifier(details?.subscription);
        if (subscription) await syncSubscription(tx,stripe,subscription,details?.metadata?.opentoken_order,
          event.type==='invoice.paid' ? event.data.object : undefined);
        break;
      }
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed':
        await syncRefund(tx,stripe,event.data.object);
        break;
    }
  });
}
