import { z } from 'zod';
import { generateRedeemCode, redeemAmountMicros, redeemCodeDigest } from '../lib/redeem-code.mjs';

export async function redeemCommand(client,[command,...args]) {
  if (command==='issue' && args.length===2) {
    const [usd,expiry] = args;
    const micros = redeemAmountMicros(usd);
    if (!micros) throw new Error('Amount must be a positive USD value within the wallet range, with up to six decimal places');
    if (!z.iso.datetime({offset:true}).safeParse(expiry).success) throw new Error('Provide an ISO 8601 expiry with a timezone');
    const time = new Date(expiry);
    const code = generateRedeemCode();
    const {rows:[row]} = await client.query(`INSERT INTO gateway.redeem_codes (secret_digest,amount_micros,expires_at)
      SELECT $1,$2,$3::timestamptz WHERE $3::timestamptz > clock_timestamp()
      RETURNING id,amount_micros::text AS "amountMicros",expires_at AS "expiresAt"`,
    [redeemCodeDigest(code),micros,time.toISOString()]);
    if (!row) throw new Error('Expiry must be in the future');
    return {...row,code};
  }
  if (command==='void' && args.length===1) {
    // Redemption also locks the code row, so void cannot race past a successful credit.
    await client.query('BEGIN');
    try {
      const {rows:[code]} = await client.query(`SELECT to_jsonb(c)->>'issued_by' AS issued_by
        FROM gateway.redeem_codes c WHERE id=$1 FOR UPDATE`,args);
      if (!code) throw new Error('Code not found');
      if (code.issued_by) throw new Error('Use the administrator console to void a managed code');
      const used = await client.query('SELECT 1 FROM gateway.wallet_entries WHERE redeem_code_id=$1',args);
      if (used.rowCount) throw new Error('Code has already been redeemed');
      const {rows:[row]} = await client.query(`UPDATE gateway.redeem_codes SET
        updated_at=CASE WHEN voided_at IS NULL THEN clock_timestamp() ELSE updated_at END,
        voided_at=coalesce(voided_at,clock_timestamp()) WHERE id=$1
        RETURNING id,voided_at AS "voidedAt"`,args);
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK').catch(()=>{});
      throw error;
    }
  }
  throw new Error('Usage: db:redeem issue USD EXPIRY_ISO | void CODE_ID');
}
