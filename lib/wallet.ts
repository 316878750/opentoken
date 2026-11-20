import { store } from './data';
import { redeemCodeDigest, redeemCodePattern } from './redeem-code.mjs';

type Redemption =
  | {status:'unavailable'|'balance_limit'}
  | {status:'rate_limited';retryAfter:number}
  | {status:'ok';replayed:boolean;receipt:{id:string;amountMicros:string;createdAt:string};
      wallet:{balanceMicros:string;heldMicros:string;availableMicros:string}};

export async function redeemCredit(user:string, code:string) {
  const digest = redeemCodePattern.test(code) ? redeemCodeDigest(code) : null;
  const {rows:[row]} = await store().db.query<{result:Redemption}>(
    'SELECT gateway.redeem_trial_credit($1,$2) AS result',[user,digest]);
  return row.result;
}

export async function walletEntries(user:string,{kind,cursor}:{kind?:'redemption'|'usage';cursor?:string}) {
  const {rows} = await store().db.query<{id:string}>(`SELECT e.id,e.kind,e.delta_micros::text AS "deltaMicros",
    e.request_id AS "requestId",e.created_at AS "createdAt"
    FROM gateway.wallet_entries e WHERE e.user_id=$1 AND ($2::text IS NULL OR e.kind=$2)
    AND ($3::uuid IS NULL OR (e.created_at,e.id) <
      (SELECT created_at,id FROM gateway.wallet_entries WHERE user_id=$1 AND id=$3 AND ($2::text IS NULL OR kind=$2)))
    ORDER BY e.created_at DESC,e.id DESC LIMIT 21`,[user,kind??null,cursor??null]);
  return {items:rows.slice(0,20),nextCursor:rows.length>20 ? rows[19].id : null};
}
