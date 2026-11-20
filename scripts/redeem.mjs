import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { redeemCodeDigest } from '../lib/redeem-code.mjs';

export async function redeemCommand(client,[command,...args]) {
  if (command==='issue' && args.length===2) {
    const [usd,expiry] = args;
    if (!/^\d{1,13}(\.\d{1,6})?$/.test(usd)) throw new Error('Amount must be a positive USD value with up to six decimal places');
    const [whole,fraction=''] = usd.split('.');
    const micros = BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0'));
    if (micros<1n || micros>9_223_372_036_854_775_807n) throw new Error('Amount is outside the supported wallet range');
    if (!z.iso.datetime({offset:true}).safeParse(expiry).success) throw new Error('Provide an ISO 8601 expiry with a timezone');
    const time = new Date(expiry);
    const code = 'otc_' + randomBytes(24).toString('base64url');
    const {rows:[row]} = await client.query(`INSERT INTO gateway.redeem_codes (secret_digest,amount_micros,expires_at)
      SELECT $1,$2,$3::timestamptz WHERE $3::timestamptz > clock_timestamp()
      RETURNING id,amount_micros::text AS "amountMicros",expires_at AS "expiresAt"`,
    [redeemCodeDigest(code),micros.toString(),time.toISOString()]);
    if (!row) throw new Error('Expiry must be in the future');
    return {...row,code};
  }
  if (command==='void' && args.length===1) {
    // Redemption also locks the code row, so void cannot race past a successful credit.
    await client.query('BEGIN');
    try {
      const {rows:[code]} = await client.query('SELECT voided_at FROM gateway.redeem_codes WHERE id=$1 FOR UPDATE',args);
      if (!code) throw new Error('Code not found');
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
