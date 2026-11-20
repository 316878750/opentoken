import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate, seed } from '../scripts/database.mjs';

const user = '40000000-0000-4000-8000-000000000001';
const email = 'billing@example.test';
let database;
let admin;

before(async () => {
  database = await PGlite.create();
  await database.exec(`CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text NOT NULL,email_confirmed_at timestamptz);
    CREATE ROLE opentoken_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`);
  await database.query('INSERT INTO auth.users VALUES ($1,$2,now())',[user,email]);
  admin = {query:async (sql,params) => {
    if (!params && sql.trim().replace(/;$/,'').includes(';')) return database.exec(sql);
    const result = await database.query(sql,params);
    return {...result,rowCount:result.rows.length || result.affectedRows || 0};
  }};
  await migrate(admin);
  await migrate(admin);
  await seed(admin,email,null);
});

after(async () => { await database?.close(); });

async function reserve(status,ageMinutes=0) {
  return database.transaction(async tx => {
    const {rows:[rate]} = await tx.query(`SELECT r.id,r.group_id,r.model_id FROM gateway.model_rates r
      JOIN gateway.models m ON r.model_id=m.id WHERE m.code='mock-text' AND r.closed_at IS NULL`);
    const {rows:[key]} = await tx.query(`INSERT INTO gateway.api_keys
      (user_id,group_id,name,public_prefix,secret_digest,rpm_limit,held_micros)
      VALUES ($1,$2,'billing fixture','fixture',$3,10,1000000) RETURNING id`, [user,rate.group_id,randomBytes(32)]);
    await tx.query('UPDATE gateway.wallets SET held_micros=held_micros+1000000 WHERE user_id=$1',[user]);
    const {rows:[request]} = await tx.query(`INSERT INTO gateway.usage_requests
      (user_id,key_id,group_id,model_id,rate_id,upstream_model_snapshot,reserved_micros,status,terminal_reason,updated_at)
      VALUES ($1,$2,$3,$4,$5,'mock-text',1000000,$6,'fixture',now()-make_interval(mins=>$7)) RETURNING id`,
    [user,key.id,rate.group_id,rate.model_id,rate.id,status,ageMinutes]);
    return request.id;
  });
}

async function resolve(id,action,evidence='provider-receipt-001',counts=[null,null,null]) {
  const {rows:[row]} = await database.query('SELECT gateway.resolve_billing_request($1,$2,$3,$4,$5,$6,$7) AS result',
    [id,action,'pilot-operator',evidence,...counts]);
  return row.result;
}

async function maintenance() {
  const {rows:[row]} = await database.query('SELECT gateway.run_billing_maintenance() AS result');
  return row.result;
}

test('manual settlement uses the original rate and repeats without another debit or audit event', async () => {
  const id = await reserve('review');
  await database.exec(`UPDATE gateway.model_rates SET closed_at=now() WHERE closed_at IS NULL
      AND model_id=(SELECT id FROM gateway.models WHERE code='mock-text');
    INSERT INTO gateway.model_rates
      (group_id,model_id,input_micros_per_mtok,cached_input_micros_per_mtok,output_micros_per_mtok,multiplier_bps)
      SELECT g.id,m.id,100000000,100000000,100000000,12000
      FROM gateway.pricing_groups g CROSS JOIN gateway.models m WHERE g.code='pilot' AND m.code='mock-text'`);
  const decisions = await Promise.all([
    resolve(id,'settle','provider-receipt-001',[100,25,10]),
    resolve(id,'settle','provider-receipt-001',[100,25,10]),
  ]);
  assert.deepEqual(decisions.map(d => d.replayed).sort(),[false,true]);
  assert.equal(decisions[0].chargedMicros,'162900');
  assert.equal(decisions[0].releasedMicros,'837100');
  await assert.rejects(resolve(id,'release'),/already resolved/i);
  const {rows:[row]} = await database.query(`SELECT u.status,w.balance_micros::text,w.held_micros::text,
    k.held_micros::text AS key_held,k.spent_micros::text AS key_spent,
    (SELECT count(*)::int FROM gateway.billing_resolutions a WHERE a.request_id=u.id) AS audit_count,
    (SELECT count(*)::int FROM gateway.wallet_entries e WHERE e.request_id=u.id AND delta_micros=-162900) AS debit_count
    FROM gateway.usage_requests u JOIN gateway.wallets w ON w.user_id=u.user_id
    JOIN gateway.api_keys k ON k.id=u.key_id WHERE u.id=$1`,[id]);
  assert.deepEqual(row,{status:'settled',balance_micros:'9837100',held_micros:'0',key_held:'0',key_spent:'162900',audit_count:1,debit_count:1});
});

test('manual release requires evidence, retains the balance and records its actor', async () => {
  const id = await reserve('review');
  await assert.rejects(resolve(id,'release',' '),/evidence/i);
  await assert.rejects(resolve(id,'settle','bad-usage',[1,2,0]),/token/i);
  await assert.rejects(resolve(id,'settle','over-quote',[100000,0,0]),/reservation/i);
  const result = await resolve(id,'release','provider-no-charge-002');
  assert.equal(result.releasedMicros,'1000000');
  assert.equal((await resolve(id,'release','provider-no-charge-002')).replayed,true);
  const {rows:[row]} = await database.query(`SELECT u.status,a.operator_id,a.evidence_reference,a.previous_reason,
    (SELECT count(*)::int FROM gateway.wallet_entries e WHERE e.request_id=u.id) AS debit_count
    FROM gateway.usage_requests u JOIN gateway.billing_resolutions a ON a.request_id=u.id WHERE u.id=$1`,[id]);
  assert.deepEqual(row,{status:'released',operator_id:'pilot-operator',evidence_reference:'provider-no-charge-002',previous_reason:'fixture',debit_count:0});
});

test('an existing debit prevents manual release until the inconsistency is investigated', async () => {
  const id = await reserve('review');
  await database.query("INSERT INTO gateway.wallet_entries (user_id,request_id,kind,delta_micros) VALUES ($1,$2,'usage',-100)",[user,id]);
  await assert.rejects(resolve(id,'release'),/ledger.*conflicts/i);
  const {rows:[row]} = await database.query(`SELECT status,
    EXISTS(SELECT 1 FROM gateway.billing_resolutions a WHERE a.request_id=u.id) AS audited
    FROM gateway.usage_requests u WHERE id=$1`,[id]);
  assert.deepEqual(row,{status:'review',audited:false});
  await database.query('DELETE FROM gateway.wallet_entries WHERE request_id=$1',[id]);
  await resolve(id,'release');
});

test('maintenance releases only expired undispatched requests and tracks persistent discrepancies', async () => {
  const expired = await reserve('reserved',3);
  const uncertain = await reserve('dispatched',3);
  const recent = await reserve('dispatched');
  const oldReview = await reserve('review',16);
  await assert.rejects(resolve(recent,'release'),/not awaiting review/i);
  await database.query('UPDATE gateway.wallets SET balance_micros=balance_micros+1 WHERE user_id=$1',[user]);
  assert.deepEqual(await maintenance(),{expired:1,movedToReview:1,openAlerts:2});
  const {rows:[row]} = await database.query(`SELECT
    (SELECT status FROM gateway.usage_requests WHERE id=$1) AS expired,
    (SELECT action FROM gateway.billing_resolutions WHERE request_id=$1) AS expired_action,
    (SELECT status FROM gateway.usage_requests WHERE id=$2) AS uncertain,
    (SELECT status FROM gateway.usage_requests WHERE id=$3) AS recent,
    (SELECT held_micros::text FROM gateway.wallets WHERE user_id=$4) AS held`,[expired,uncertain,recent,user]);
  assert.deepEqual(row,{expired:'released',expired_action:'expire',uncertain:'review',recent:'dispatched',held:'3000000'});
  const {rows:open} = await database.query(`SELECT kind,entity_id FROM gateway.billing_alerts
    WHERE resolved_at IS NULL ORDER BY kind`);
  assert.deepEqual(open,[{kind:'review_stale',entity_id:oldReview},{kind:'wallet_balance',entity_id:user}]);
  assert.deepEqual(await maintenance(),{expired:0,movedToReview:0,openAlerts:2});
  await database.query('UPDATE gateway.wallets SET balance_micros=balance_micros-1 WHERE user_id=$1',[user]);
  await resolve(oldReview,'release','provider-no-charge-003');
  assert.equal((await maintenance()).openAlerts,0);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM gateway.billing_alerts WHERE resolved_at IS NOT NULL')).rows[0].count,2);
  await database.exec('SET ROLE opentoken_app');
  try{
    await assert.rejects(database.query('SELECT * FROM gateway.billing_resolutions'),{code:'42501'});
    await assert.rejects(database.query('SELECT * FROM gateway.billing_alerts'),{code:'42501'});
    await assert.rejects(database.query('SELECT gateway.run_billing_maintenance()'),{code:'42501'});
  }finally{await database.exec('RESET ROLE');}
});

test('one expired reservation with inconsistent holds does not prevent other work or alerts', async () => {
  const damaged = await reserve('reserved',4);
  const healthy = await reserve('reserved',3);
  const dispatched = await reserve('dispatched',3);
  await database.query(`UPDATE gateway.api_keys SET held_micros=0
    WHERE id=(SELECT key_id FROM gateway.usage_requests WHERE id=$1)`,[damaged]);
  const result = await maintenance();
  assert.equal(result.expired,1);
  assert.equal(result.movedToReview,2);
  const {rows:[row]} = await database.query(`SELECT
    (SELECT terminal_reason FROM gateway.usage_requests WHERE id=$1) AS damage,
    (SELECT status FROM gateway.usage_requests WHERE id=$2) AS healthy,
    (SELECT status FROM gateway.usage_requests WHERE id=$3) AS dispatched,
    EXISTS(SELECT 1 FROM gateway.billing_alerts
      WHERE kind='reservation_inconsistent' AND entity_id=$1 AND resolved_at IS NULL) AS alerted`,[damaged,healthy,dispatched]);
  assert.deepEqual(row,{damage:'reservation_inconsistent',healthy:'released',dispatched:'review',alerted:true});
});
