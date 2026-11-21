export async function findStripeCheckout(stripe,order) {
  if (order.checkout_id) return stripe.checkout.sessions.retrieve(order.checkout_id);
  const created = {gte:Math.floor(order.created_at.getTime()/1000)-300,lte:Math.floor(order.expires_at.getTime()/1000)+300};
  let match;
  let inspected = 0;
  for await (const candidate of stripe.checkout.sessions.list({created,limit:100})) {
    if (++inspected>500) throw new Error('Too many Stripe sandbox checkout sessions to reconcile');
    if (candidate.client_reference_id!==order.id) continue;
    if (match) throw new Error('Multiple Stripe sandbox checkout sessions match the order');
    match = candidate;
  }
  return match;
}

export function validateStripeCheckout(order,session) {
  if (session.livemode!==false || !session.id.startsWith('cs_test_') || session.client_reference_id!==order.id ||
    session.metadata?.opentoken_order!==order.id || session.metadata?.opentoken_price!==order.price_id ||
    session.currency!=='usd' || session.amount_total!==order.amount_cents ||
    session.mode!==(order.kind==='credit' ? 'payment' : 'subscription') ||
    (order.checkout_id && order.checkout_id!==session.id)) throw new Error('Stripe checkout does not match the test order');
}
