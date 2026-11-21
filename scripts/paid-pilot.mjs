import Stripe from 'stripe';

const pricePlans=[
  {field:'STRIPE_LIVE_CREDIT_PRICE_ID',cents:500,type:'one_time'},
  {field:'STRIPE_LIVE_CREDIT_20_PRICE_ID',cents:2000,type:'one_time'},
  {field:'STRIPE_LIVE_CREDIT_50_PRICE_ID',cents:5000,type:'one_time'},
  {field:'STRIPE_LIVE_SUBSCRIPTION_PRICE_ID',cents:1000,type:'recurring'},
];
const webhookEvents=[
  'checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired',
  'customer.subscription.created','customer.subscription.updated','customer.subscription.deleted',
  'invoice.paid','invoice.payment_failed','refund.created','refund.updated','refund.failed',
];
const required={
  STRIPE_LIVE_SECRET_KEY:/^(?:rk|sk)_live_[A-Za-z0-9_]+$/,
  STRIPE_LIVE_ACCOUNT_ID:/^acct_[A-Za-z0-9]+$/,
  STRIPE_LIVE_WEBHOOK_SECRET:/^whsec_[A-Za-z0-9_]+$/,
  STRIPE_LIVE_WEBHOOK_ENDPOINT_ID:/^we_[A-Za-z0-9]+$/,
  STRIPE_LIVE_PORTAL_CONFIGURATION_ID:/^bpc_[A-Za-z0-9]+$/,
  STRIPE_LIVE_PILOT_COUNTRY:/^[A-Z]{2}$/,
  STRIPE_LIVE_TAX_POLICY:/^(?:stripe_tax|confirmed_no_tax)$/,
  APP_ORIGIN:/^https:\/\/[a-z0-9.-]+$/i,
  ...Object.fromEntries(pricePlans.map(({field})=>[field,/^price_[A-Za-z0-9]+$/])),
};

async function readDbStatus(db) {
  const {rows:[shape]}=await db.query(`SELECT
    to_regclass('gateway.paid_pilot_settings') IS NOT NULL AND
    to_regclass('gateway.paid_pilot_accounts') IS NOT NULL AND
    to_regprocedure('gateway.paid_pilot_access(uuid)') IS NOT NULL AS migrated,
    to_regclass('gateway.stripe_sandbox') IS NOT NULL AS has_sandbox_table`);
  const {rows:[{sandbox}]}=shape.has_sandbox_table ?
    await db.query('SELECT EXISTS(SELECT 1 FROM gateway.stripe_sandbox WHERE enabled) AS sandbox') : {rows:[{sandbox:false}]};
  if (!shape.migrated) return {migrated:false,sandbox,eligibleAccounts:0,checkoutEnabled:false};
  const {rows:[state]}=await db.query(`SELECT
    (SELECT count(*)::int FROM gateway.paid_pilot_accounts p
      CROSS JOIN LATERAL gateway.paid_pilot_access(p.user_id) a WHERE a.eligible)
      AS "eligibleAccounts",
    EXISTS(SELECT 1 FROM gateway.paid_pilot_settings WHERE checkout_enabled) AS "checkoutEnabled"`);
  return {migrated:true,sandbox,...state};
}

async function preflight(db,env,fetcher) {
  const database=await readDbStatus(db);
  const missing=Object.entries(required).filter(([field,pattern])=>!pattern.test(env[field]??'')).map(([field])=>field);
  const issues=[];
  if (!database.migrated) issues.push('paid_pilot_migration_missing');
  if (database.sandbox) issues.push('stripe_sandbox_database');
  if (database.eligibleAccounts===0) issues.push('no_eligible_pilot_accounts');
  if (database.checkoutEnabled) issues.push('checkout_should_be_paused_during_preflight');
  if (missing.length || database.sandbox) return {ready:false,database,missing,issues,stripeChecked:false};

  async function get(path) {
    const response=await fetcher('https://api.stripe.com/v1/'+path,{
      method:'GET',headers:{authorization:'Bearer '+env.STRIPE_LIVE_SECRET_KEY,'stripe-version':Stripe.API_VERSION},
      redirect:'error',signal:AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('A Stripe live configuration read failed (HTTP '+response.status+').');
    }
    return response.json();
  }
  const [account,prices,portal,endpoint,tax]=await Promise.all([
    get('account'),Promise.all(pricePlans.map(({field})=>get('prices/'+env[field]))),
    get('billing_portal/configurations/'+env.STRIPE_LIVE_PORTAL_CONFIGURATION_ID),
    get('webhook_endpoints/'+env.STRIPE_LIVE_WEBHOOK_ENDPOINT_ID),
    env.STRIPE_LIVE_TAX_POLICY==='stripe_tax' ? get('tax/settings') : null,
  ]);
  if (account.id!==env.STRIPE_LIVE_ACCOUNT_ID || account.charges_enabled!==true) issues.push('stripe_account_not_charge_enabled');
  for (const [index,price] of prices.entries()) {
    const {field,cents,type}=pricePlans[index];
    if (price.id!==env[field] || price.livemode!==true || !price.active || price.currency!=='usd' ||
      price.unit_amount!==cents || price.type!==type || (type==='recurring' &&
        (price.recurring?.interval!=='month'||price.recurring.interval_count!==1)) ||
      (tax&&price.tax_behavior!=='exclusive')) issues.push('unexpected_live_price:'+field);
  }
  if (new Set(prices.map(price=>price.id)).size!==pricePlans.length) issues.push('live_prices_must_be_distinct');
  if (portal.id!==env.STRIPE_LIVE_PORTAL_CONFIGURATION_ID || portal.livemode!==true || !portal.active ||
    !portal.features?.subscription_cancel?.enabled || portal.features.subscription_cancel.mode!=='at_period_end') {
    issues.push('unexpected_live_customer_portal');
  }
  if (endpoint.id!==env.STRIPE_LIVE_WEBHOOK_ENDPOINT_ID || endpoint.livemode!==true || endpoint.status!=='enabled' ||
    endpoint.url!==env.APP_ORIGIN+'/api/stripe/webhook' || endpoint.api_version!==Stripe.API_VERSION ||
    !webhookEvents.every(event=>endpoint.enabled_events?.includes(event))) issues.push('unexpected_live_webhook');
  if (tax && (tax.livemode!==true || tax.status!=='active')) issues.push('stripe_tax_settings_inactive');
  return {ready:issues.length===0,database,missing,issues,stripeChecked:true};
}

export async function paidPilotCommand(db,args,{env=process.env,fetcher=fetch}={}) {
  const [action,email,...extra]=args;
  if (!email && !extra.length && action==='preflight') return preflight(db,env,fetcher);
  if (!email && !extra.length && action==='status') return readDbStatus(db);
  if (!email && !extra.length && action==='pause') {
    await db.query('UPDATE gateway.paid_pilot_settings SET checkout_enabled=false WHERE singleton AND checkout_enabled');
    return {checkoutEnabled:false};
  }
  if (!extra.length && ['allow','revoke'].includes(action) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email??'') && email.length<=254) {
    if (action==='revoke') {
      await db.query(`DELETE FROM gateway.paid_pilot_accounts p USING auth.users u
        WHERE u.id=p.user_id AND lower(u.email)=lower($1)`,[email]);
      return {eligible:false};
    }
    const {rows:[{matched}]}=await db.query(`WITH verified AS MATERIALIZED (
        SELECT id FROM auth.users WHERE lower(email)=lower($1) AND email_confirmed_at IS NOT NULL
      ), counted AS (SELECT count(*)::int AS matched FROM verified), added AS (
        INSERT INTO gateway.paid_pilot_accounts(user_id)
        SELECT verified.id FROM verified,counted WHERE counted.matched=1 ON CONFLICT DO NOTHING
      ) SELECT matched FROM counted`,[email]);
    if (matched!==1) throw new Error('The pilot address must identify one confirmed account');
    return {eligible:true};
  }
  throw new Error('Usage: db:paid-pilot status | preflight | allow EMAIL | revoke EMAIL | pause');
}
