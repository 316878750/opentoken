import { store } from './data';
import { Fault } from './gateway';
import { generateRedeemCode, redeemAmountMicros, redeemCodeDigest } from './redeem-code.mjs';

export type RedeemCodeStatus = 'active' | 'expired' | 'voided' | 'redeemed';
export type AdminRedeemPage = {items:{id:string;amountMicros:string;status:RedeemCodeStatus;createdAt:string;
  expiresAt:string;voidedAt:string|null;issuedBy:string|null;redeemedBy:string|null;redeemedAt:string|null;
  receiptId:string|null}[];nextCursor:string|null};
export type AdminRedeemIssue = {id:string;amountMicros:string;expiresAt:string;status:RedeemCodeStatus;code?:string};

const denialMessages:Partial<Record<string,readonly [number,string]>> = {
  forbidden:[403,'当前账号没有此兑换码操作的权限。'],
  issue_conflict:[409,'该签发编号已用于不同的申请。'],
  invalid_expiry:[400,'有效期必须晚于当前时间。'],
  operator_single_limit:[409,'超过单码签发额度，或运营签发额度尚未启用。'],
  operator_daily_limit:[409,'超过今日累计签发额度。'],
  code_not_found:[404,'兑换码记录不存在。'],
  code_redeemed:[409,'兑换码已核销。'],
  code_expired:[409,'兑换码已过期。'],
};

function reject(result:string, requestId?:string):never {
  const denial = Object.hasOwn(denialMessages,result) ? denialMessages[result] : undefined;
  if (!denial) throw new Error('Unexpected administrator redemption result');
  throw new Fault(denial[0],result,denial[1],requestId);
}

export async function listAdminRedeem(userId:string,{status,cursor}:{status?:RedeemCodeStatus;cursor?:string}) {
  const {rows:[{page}]} = await store().db.query<{page:AdminRedeemPage|null}>(
    'SELECT gateway.admin_list_redeem($1,$2,$3) AS page',[userId,status??null,cursor??null]);
  return page??reject('forbidden');
}

export async function issueAdminRedeem(userId:string,{amountUsd,expiresAt,operationId}:{
  amountUsd:string;expiresAt:string;operationId:string;
}) {
  const amount = redeemAmountMicros(amountUsd);
  if (!amount) throw new Fault(400,'invalid_amount','请输入大于零且最多六位小数的美元金额。');
  const code = generateRedeemCode();
  const single = redeemAmountMicros(process.env.OPERATOR_REDEEM_SINGLE_USD) ?? '0';
  const daily = redeemAmountMicros(process.env.OPERATOR_REDEEM_DAILY_USD) ?? '0';
  const {rows:[{issued}]} = await store().db.query<{issued:AdminRedeemIssue & {result:string;requestId?:string}}>(
    'SELECT gateway.admin_issue_redeem($1,$2,$3,$4,$5,$6,$7) AS issued',
    [userId,operationId,redeemCodeDigest(code),amount,expiresAt,single,daily]);
  const {result,requestId,...summary} = issued;
  if (result==='issued') return {status:201,requestId,body:{...summary,code}};
  if (result==='replayed') return {status:200,requestId,body:summary};
  return reject(result,requestId);
}

export async function voidAdminRedeem(userId:string,id:string) {
  const {rows:[{voided}]} = await store().db.query<{voided:{result:string;id:string;voidedAt:string;requestId?:string}}>(
    'SELECT gateway.admin_void_redeem($1,$2) AS voided',[userId,id]);
  if (voided.result!=='voided') return reject(voided.result,voided.requestId);
  return {requestId:voided.requestId,body:{id:voided.id,voidedAt:voided.voidedAt,status:'voided'}};
}
