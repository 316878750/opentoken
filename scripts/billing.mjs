const reviewQuery = `SELECT u.id AS request_id,u.status,u.upstream_model_snapshot AS model,
  u.upstream_request_id,u.terminal_reason,u.reserved_micros::text,u.charged_micros::text,u.updated_at,
  a.action,a.operator_id,a.database_actor,a.evidence_reference,a.previous_reason,a.created_at AS resolved_at
  FROM gateway.usage_requests u LEFT JOIN gateway.billing_resolutions a ON a.request_id=u.id`;

export async function scanBilling(client) {
  const {rows:[row]} = await client.query('SELECT gateway.run_billing_maintenance() AS result');
  return row.result;
}

export async function billingCommand(client,[command,...args]) {
  switch (command) {
    case 'list':
      if (!args.length) return (await client.query(reviewQuery +
        " WHERE u.status='review' ORDER BY u.updated_at,u.id LIMIT 100")).rows;
      break;
    case 'show':
      if (args.length===1) {
        const {rows:[row]} = await client.query(reviewQuery+' WHERE u.id=$1',args);
        if (!row) throw new Error('Billing request not found');
        return row;
      }
      break;
    case 'resolve': {
      const [requestId,decision,actor,evidence,...tokens] = args;
      if (!requestId || !actor || !evidence ||
          !(decision==='release' && tokens.length===0 ||
            decision==='settle' && tokens.length===3 && tokens.every(value=>/^\d{1,10}$/.test(value)))) break;
      const {rows:[row]} = await client.query('SELECT gateway.resolve_billing_request($1,$2,$3,$4,$5,$6,$7) AS result',
        [requestId,decision,actor,evidence,...(decision==='settle' ? tokens : [null,null,null])]);
      return {requestId,...row.result};
    }
    case 'scan':
      if (!args.length) return scanBilling(client);
      break;
    case 'alerts':
      if (!args.length) return (await client.query(`SELECT kind,entity_id,expected,actual,opened_at,last_seen_at
        FROM gateway.billing_alerts WHERE resolved_at IS NULL ORDER BY opened_at,kind,entity_id`)).rows;
      break;
    case 'schedule':
      if (!args.length) {
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog');
        const {rows:[job]} = await client.query(`SELECT cron.schedule('opentoken-billing-maintenance',
          '*/5 * * * *', 'SELECT gateway.run_billing_maintenance();') AS job_id`);
        return (await client.query('SELECT jobid,jobname,schedule,active FROM cron.job WHERE jobid=$1',[job.job_id])).rows[0];
      }
      break;
  }
  throw new Error('Usage: db:billing list | show REQUEST_ID | resolve REQUEST_ID release OPERATOR EVIDENCE | '+
    'resolve REQUEST_ID settle OPERATOR EVIDENCE INPUT CACHED OUTPUT | scan | alerts | schedule');
}
