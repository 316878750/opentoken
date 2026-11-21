/** @param {import('pg').PoolClient} db
 * @param {{id:string,kind:string,price_id:string,amount_cents:number}} order
 * @param {import('stripe').Stripe.Invoice} invoice
 */
export async function recordPaidInvoice(db,order,invoice) {
  if (invoice.billing_reason!=='subscription_create' && invoice.billing_reason!=='subscription_cycle') return;
  const [line]=invoice.lines.data;
  if (order.kind!=='subscription' || !/^in_[\w]+$/.test(invoice.id) || invoice.livemode!==false ||
    invoice.status!=='paid' || invoice.currency!=='usd' || invoice.amount_paid!==order.amount_cents ||
    invoice.lines.has_more || invoice.lines.data.length!==1 || line?.pricing?.price_details?.price!==order.price_id ||
    line.amount!==order.amount_cents || !Number.isInteger(line.period.start) || !Number.isInteger(line.period.end) ||
    line.period.start>=line.period.end) throw new Error('Stripe paid invoice does not match the subscription order');
  await db.query(`INSERT INTO gateway.stripe_invoices(stripe_id,order_id,amount_cents,reason,period_start,period_end)
    VALUES ($1,$2,$3,$4,to_timestamp($5),to_timestamp($6)) ON CONFLICT (stripe_id) DO NOTHING`,
  [invoice.id,order.id,invoice.amount_paid,invoice.billing_reason,line.period.start,line.period.end]);
}
