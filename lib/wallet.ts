import { lockAccount,store,transaction } from './data';
import { redeemCodeDigest, redeemCodePattern } from './redeem-code.mjs';

type Redemption =
  | {status:'unavailable'|'balance_limit'|'account_unavailable'}
  | {status:'rate_limited';retryAfter:number}
  | {status:'ok';replayed:boolean;receipt:{id:string;amountMicros:string;createdAt:string};
      wallet:{balanceMicros:string;heldMicros:string;availableMicros:string;refundHeldMicros?:string}};

export async function redeemCredit(user:string, code:string):Promise<Redemption> {
  const digest = redeemCodePattern.test(code) ? redeemCodeDigest(code) : null;
  return transaction(async tx=>{
    await lockAccount(tx,user);
    const {rows:[{result}]}=await tx.query<{result:Redemption}>(
      `SELECT CASE WHEN gateway.account_access($1) IS NULL THEN jsonb_build_object('status','account_unavailable')
        ELSE gateway.redeem_trial_credit($1,$2) END AS result`,[user,digest]);
    if (result.status==='ok') {
      const {rows:[wallet]}=await tx.query<{refundHeldMicros:string;availableMicros:string}>(`SELECT
        refund_held_micros::text AS "refundHeldMicros",(balance_micros-held_micros-refund_held_micros)::text AS "availableMicros"
        FROM gateway.wallets WHERE user_id=$1`,[user]);
      if (wallet.refundHeldMicros!=='0') Object.assign(result.wallet,wallet);
    }
    return result;
  });
}

export async function walletEntries(user:string,{kind,cursor}:{
  kind?:'redemption'|'usage'|'stripe_refund'|'stripe_refund_reversal';cursor?:string
}) {
  const {rows} = await store().db.query<{id:string}>(`SELECT e.id,e.kind,e.delta_micros::text AS "deltaMicros",
    e.request_id AS "requestId",e.created_at AS "createdAt"
    FROM gateway.wallet_entries e WHERE e.user_id=$1 AND ($2::text IS NULL OR e.kind=$2)
    AND ($3::uuid IS NULL OR (e.created_at,e.id) <
      (SELECT created_at,id FROM gateway.wallet_entries WHERE user_id=$1 AND id=$3 AND ($2::text IS NULL OR kind=$2)))
    ORDER BY e.created_at DESC,e.id DESC LIMIT 21`,[user,kind??null,cursor??null]);
  return {items:rows.slice(0,20),nextCursor:rows.length>20 ? rows[19].id : null};
}
