import Stripe from 'stripe';
import {findStripeCheckout,validateStripeCheckout} from '../lib/stripe-checkout.mjs';
import {recordPaidInvoice} from '../lib/stripe-invoices.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stripeClient(key) {
  if (!/^sk_test_[A-Za-z0-9_]+$/.test(key??'')) throw new Error('A Stripe sandbox secret key is required');
  return new Stripe(key,{timeout:8000,maxNetworkRetries:0,
    httpClient:Stripe.createFetchHttpClient((input,init)=>fetch(input,{...init,redirect:'error'}))});
}

async function paymentRefunds(stripe,payment) {
  const refunds=[];
  for await (const refund of stripe.refunds.list({payment_intent:payment,limit:100})) {
    if (refunds.length>=500) throw new Error('Too many provider refunds to reconcile interactively');
    refunds.push(refund);
  }
  return refunds;
}

function matchRefund(refund,record) {
  return refund.payment_intent===record.payment_id && refund.currency==='usd' &&
    refund.amount===record.amount_cents && refund.metadata?.opentoken_order===record.order_id &&
    refund.metadata?.opentoken_refund===record.id &&
    (!record.stripe_id||record.stripe_id===refund.id);
}

async function requireOriginalPayment(stripe,row) {
  const payment=await stripe.paymentIntents.retrieve(row.payment_id);
  if (payment.id!==row.payment_id||payment.livemode!==false||payment.status!=='succeeded'||payment.currency!=='usd'||
    payment.amount_received!==row.paid_cents||
    (payment.metadata?.opentoken_order && payment.metadata.opentoken_order!==row.order_id)) {
    throw new Error('The approved original payment is not a matching Stripe sandbox payment');
  }
}

async function approveAndSend(db,stripe,id,order,cents,actor) {
  await db.query('SELECT gateway.approve_stripe_refund($1,$2,$3,$4)',[id,order,cents,actor]);
  const row=await localRefund(db,id);
  if (row.state==='failed'||row.state==='canceled') return {id,state:row.state};
  await requireOriginalPayment(stripe,row);
  const retries=(await paymentRefunds(stripe,row.payment_id)).filter(item=>item.metadata?.opentoken_refund===row.id);
  if (retries.length>1||retries.some(refund=>!matchRefund(refund,row))) throw new Error('Multiple or inconsistent provider refunds need review');
  let [refund]=retries;
  if (!refund) {
    if (row.stripe_id || Date.now()-row.created_at.getTime()>23*3600_000) {
      throw new Error('Refund retry window elapsed or provider record is missing; review the original payment before proceeding');
    }
    await db.query('UPDATE gateway.stripe_refunds SET last_submitted_at=now() WHERE id=$1',[row.id]);
    // Retain the approval on transport errors. A retry must use the same local UUID.
    refund=await stripe.refunds.create({payment_intent:row.payment_id,amount:cents,reason:'requested_by_customer',
      metadata:{opentoken_order:row.order_id,opentoken_refund:row.id}},{idempotencyKey:'opentoken-refund-'+row.id});
    if (!matchRefund(refund,row)) throw new Error('The provider refund does not match the approval');
  }
  return {id,stripeId:refund.id,providerState:refund.status,localState:row.state,amountCents:cents};
}

async function localRefund(db,id) {
  const {rows:[row]}=await db.query(`SELECT r.*,o.payment_id,o.amount_cents AS paid_cents FROM gateway.stripe_refunds r
    JOIN gateway.stripe_orders o ON o.id=r.order_id WHERE r.id=$1`,[id]);
  if (!row) throw new Error('Sandbox refund approval not found');
  return row;
}

async function recoverRefund(db,stripe,id,note) {
  const row=await localRefund(db,id);
  await requireOriginalPayment(stripe,row);
  const remote=await paymentRefunds(stripe,row.payment_id);
  const related=remote.filter(refund=>refund.id===row.stripe_id || refund.metadata?.opentoken_refund===row.id);
  if (related.length>1 || related.some(refund=>!matchRefund(refund,row))) throw new Error('Provider refund does not match the approval');
  if (related.length) {
    if (note) throw new Error('Stripe already has the refund; synchronize its status');
    const [refund]=related;
    await db.query('SELECT gateway.apply_stripe_refund($1,$2,$3,$4,$5)',
      [row.id,refund.id,row.payment_id,refund.amount,refund.status==='requires_action'?'pending':refund.status]);
    return {id:row.id,stripeId:refund.id,state:refund.status};
  }
  if (!note) throw new Error('No linked Stripe refund found; approval remains held');
  if (remote.some(refund=>!refund.metadata?.opentoken_refund)) throw new Error('Unlinked Stripe refunds require reconciliation first');
  await db.query('SELECT gateway.release_unsent_stripe_refund($1,$2)',[row.id,note]);
  return {id:row.id,state:'canceled'};
}

async function syncInvoices(db,stripe,id) {
  const {rows:[order]}=await db.query("SELECT * FROM gateway.stripe_orders WHERE id=$1 AND kind='subscription'",[id]);
  if (!order?.subscription_id) throw new Error('Linked Stripe sandbox subscription required');
  const sub=await stripe.subscriptions.retrieve(order.subscription_id);
  if (sub.livemode!==false || sub.id!==order.subscription_id || sub.customer!==order.customer_id ||
    sub.metadata.opentoken_order!==order.id) throw new Error('Stripe sandbox subscription does not match the order');
  let inspected=0;
  for await (const invoice of stripe.invoices.list({subscription:sub.id,status:'paid',limit:100})) {
    if (++inspected>500) throw new Error('Too many subscription invoices to synchronize interactively');
    await recordPaidInvoice(db,order,invoice);
  }
  return reconcile(db,stripe,id);
}

async function reconcile(db,stripe,id) {
  const {rows:[order]}=await db.query(`SELECT o.*,w.balance_micros::text AS balance,w.held_micros::text AS usage_held,
    w.refund_held_micros::text AS refund_held,coalesce((SELECT sum(e.delta_micros) FROM gateway.wallet_entries e
      WHERE e.user_id=o.user_id),0)::text AS ledger_total
    FROM gateway.stripe_orders o JOIN gateway.wallets w USING(user_id) WHERE o.id=$1`,[id]);
  if (!order) throw new Error('Stripe sandbox order not found');
  const issues=[];
  if (order.balance!==order.ledger_total || BigInt(order.balance)<BigInt(order.usage_held)+BigInt(order.refund_held)) {
    issues.push('wallet_balance_or_hold_mismatch');
  }
  const wallet={balanceMicros:order.balance,ledgerMicros:order.ledger_total,usageHeldMicros:order.usage_held,refundHeldMicros:order.refund_held};
  if (order.kind==='subscription') {
    if (!order.subscription_id) throw new Error('The sandbox subscription has not been linked');
    const stripeInvoices=[];
    for await (const invoice of stripe.invoices.list({subscription:order.subscription_id,status:'paid',limit:100})) {
      if (invoice.billing_reason!=='subscription_create'&&invoice.billing_reason!=='subscription_cycle') continue;
      if (stripeInvoices.length>=500) throw new Error('Too many provider invoices to reconcile interactively');
      const [line]=invoice.lines.data;
      if (invoice.livemode!==false||invoice.currency!=='usd'||!line) issues.push('unexpected_provider_invoice:'+invoice.id);
      stripeInvoices.push({id:invoice.id,amount:invoice.amount_paid,reason:invoice.billing_reason,end:line?.period.end});
    }
    const {rows:local}=await db.query(`SELECT stripe_id AS id,amount_cents AS amount,reason,extract(epoch FROM period_end)::int AS "end"
      FROM gateway.stripe_invoices WHERE order_id=$1`,[id]);
    const remote=new Map(stripeInvoices.map(invoice=>[invoice.id,invoice]));
    for (const invoice of local) {
      const stripeInvoice=remote.get(invoice.id);
      if (!stripeInvoice||Object.keys(invoice).some(key=>invoice[key]!==stripeInvoice[key])) issues.push('invoice_mismatch:'+invoice.id);
      remote.delete(invoice.id);
    }
    for (const unlinked of remote.keys()) issues.push('unlinked_provider_invoice:'+unlinked);
    return {kind:order.kind,order:id,wallet,localInvoices:local,stripeInvoices,issues};
  }
  if (order.state!=='paid'||!order.payment_id) throw new Error('The sandbox recharge has not been confirmed');
  const payment=await stripe.paymentIntents.retrieve(order.payment_id);
  if (payment.livemode!==false||payment.currency!=='usd'||payment.status!=='succeeded'||payment.amount_received!==order.amount_cents) {
    issues.push('payment_mismatch');
  }
  const {rows:[credit]}=await db.query(`SELECT delta_micros::text AS amount FROM gateway.wallet_entries
    WHERE user_id=$1 AND redeem_code_id=$2`,[order.user_id,order.redeemed_code_id]);
  if (credit?.amount!==(BigInt(order.amount_cents)*10_000n).toString()) issues.push('wallet_credit_mismatch');
  const {rows:local}=await db.query(`SELECT r.id,r.stripe_id,r.order_id,r.amount_cents,r.state,o.payment_id,
    coalesce((SELECT sum(delta_micros) FROM gateway.wallet_entries WHERE refund_id=r.id),0)::text AS ledger
    FROM gateway.stripe_refunds r JOIN gateway.stripe_orders o ON o.id=r.order_id WHERE r.order_id=$1`,[id]);
  const provider=await paymentRefunds(stripe,order.payment_id);
  const remote=new Map(provider.map(refund=>[refund.id,refund]));
  for (const row of local) {
    const refund=remote.get(row.stripe_id);
    const expected=BigInt(row.state==='succeeded' ? -row.amount_cents : 0)*10_000n;
    if (!row.stripe_id && row.state==='canceled' && row.ledger==='0') continue;
    const state=refund?.status==='requires_action' ? 'pending' : refund?.status;
    if (!refund||!matchRefund(refund,row)||row.state!==state||row.ledger!==expected.toString()) issues.push('refund_mismatch:'+row.id);
    remote.delete(row.stripe_id);
  }
  for (const unlinked of remote.keys()) issues.push('unlinked_provider_refund:'+unlinked);
  return {kind:order.kind,order:id,payment:payment.id,receivedCents:payment.amount_received,creditMicros:credit?.amount??null,wallet,
    localRefunds:local.map(({id,stripe_id,amount_cents,state,ledger})=>({id,stripeId:stripe_id,amountCents:amount_cents,state,ledgerMicros:ledger})),
    stripeRefunds:provider.map(({id,amount,status})=>({id,amountCents:amount,state:status})),issues};
}

async function syncExpiredCheckout(db,stripe,id) {
  const {rows:[order]}=await db.query('SELECT *,expires_at<=clock_timestamp() AS past_deadline FROM gateway.stripe_orders WHERE id=$1',[id]);
  if (!order) throw new Error('Stripe sandbox order not found');
  if (order.state!=='open') return {order:id,state:order.state};
  if (!order.past_deadline) throw new Error('Wait until the checkout deadline before reconciling the order');
  const session = await findStripeCheckout(stripe,order);
  if (session) {
    validateStripeCheckout(order,session);
    if (session.status!=='expired' || session.payment_status!=='unpaid' || session.subscription) {
      throw new Error('Stripe checkout is not conclusively expired');
    }
  }
  const {rows:[updated]}=await db.query(`UPDATE gateway.stripe_orders
    SET state='expired',checkout_id=coalesce($2,checkout_id)
    WHERE id=$1 AND state='open' AND checkout_id IS NOT DISTINCT FROM $3
      AND payment_id IS NULL AND subscription_id IS NULL AND expires_at<=clock_timestamp()
    RETURNING state`,[id,session?.id??null,order.checkout_id]);
  if (!updated) throw new Error('Checkout changed during reconciliation. Verify the latest order status');
  return {order:id,state:updated.state};
}

export async function stripeCommand(db,args,key=process.env.STRIPE_TEST_SECRET_KEY) {
  const [action,...values]=args;
  const approved=action==='approve-refund'&&values.length===4&&uuid.test(values[0])&&uuid.test(values[1])&&
    /^[1-9]\d{0,9}$/.test(values[2])&&Number(values[2])<=2_147_483_647&&values[3].trim().length>0&&values[3].length<=100;
  const oneId=['reconcile','sync-invoices','sync-refund','sync-expired-checkout'].includes(action)&&values.length===1&&uuid.test(values[0]);
  const cancel=action==='cancel-approval'&&values.length===2&&uuid.test(values[0])&&values[1].trim().length>0&&values[1].length<=160;
  if (!approved&&!oneId&&!cancel) {
    throw new Error('Usage: db:stripe approve-refund REFUND_UUID ORDER_UUID CENTS APPROVER | reconcile ORDER_UUID | '+
      'sync-invoices ORDER_UUID | sync-expired-checkout ORDER_UUID | sync-refund REFUND_UUID | cancel-approval REFUND_UUID REVIEW_NOTE');
  }
  const {rows:[{enabled}]}=await db.query('SELECT EXISTS(SELECT 1 FROM gateway.stripe_sandbox WHERE enabled) AS enabled');
  if (!enabled) throw new Error('Stripe operations require an isolated sandbox database');
  const stripe=stripeClient(key);
  const id=values[0].toLowerCase();
  if (action==='reconcile') return reconcile(db,stripe,id);
  if (action==='sync-invoices') return syncInvoices(db,stripe,id);
  if (action==='sync-expired-checkout') return syncExpiredCheckout(db,stripe,id);
  await db.query('SELECT pg_advisory_lock(961020033,hashtext($1))',[id]);
  try {
    if (approved) return await approveAndSend(db,stripe,id,values[1].toLowerCase(),Number(values[2]),values[3].trim());
    return await recoverRefund(db,stripe,id,cancel?values[1].trim():undefined);
  } finally { await db.query('SELECT pg_advisory_unlock(961020033,hashtext($1))',[id]).catch(()=>{}); }
}
