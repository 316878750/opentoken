import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { adminRole, type AdminRole } from './admin';
import { store } from './data';
import { Fault } from './gateway';
import { generatePilotInvite, inviteRecipientDigest, PilotInviteError, pilotInvitesConfigured } from './pilot-invite.mjs';

const role = z.enum(['system_admin','operator','auditor']).nullable();
const state = z.enum(['active','pending','suspended','auth_blocked','deleted']);
const reason = z.string().trim().min(3).max(160);
const revision = z.string().regex(/^(?:0|[1-9]\d{0,18})$/);
export const userListInput = z.strictObject({
  search:z.string().trim().min(1).max(254).optional(), status:state.optional(), cursor:z.uuid().optional(),
  limit:z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).default('25').transform(Number),
});
export const userChangeInput = z.discriminatedUnion('action',[
  z.object({action:z.literal('state'),payload:z.strictObject({suspended:z.boolean(),expectedRevision:revision,reason})}),
  z.object({action:z.literal('role'),payload:z.strictObject({role,expectedRole:role,reason})}),
  z.object({action:z.literal('delete'),payload:z.strictObject({expectedRevision:revision,expectedRole:role,
    confirmation:z.string().trim().toLowerCase().pipe(z.uuid()),reason})}),
]);
export const userInviteInput = z.strictObject({
  email:z.string().trim().toLowerCase().pipe(z.email().max(254)),operationId:z.uuid(),
});

export type AdminUser = {
  id:string;email:string|null;emailConfirmed:boolean;status:z.infer<typeof state>;role:AdminRole|null;
  revision:string;suspended:boolean;deletedAt:string|null;wallet:{balanceMicros:string;heldMicros:string;refundHeldMicros:string}|null;
};
export type AdminUserPage = {items:AdminUser[];nextCursor:string|null;canWrite:boolean;canInvite:boolean;actorId:string};

const errors:Record<string,[number,string]> = {
  user_forbidden:[403,'当前账号没有此项用户管理权限。'],
  admin_recent_auth_required:[403,'请重新登录后再执行此用户管理操作。'],
  user_self_change:[409,'请由另一位系统管理员变更此账号。'],
  user_not_found:[404,'用户不存在。'],
  user_deleted:[409,'该 OpenToken 账号已删除。'],
  user_delete_confirmation:[400,'请输入要删除的用户 ID 以确认。'],
  user_billing_open:[409,'此账号有待完成的结账或尚未结束的订阅。请先完成账务处理，待 Stripe 状态同步后再删除。'],
  user_state_changed:[409,'用户状态已变更，请刷新后重试。'],
  user_role_changed:[409,'用户角色已变更，请刷新后重试。'],
  user_ineligible:[409,'只有已验证且可用的账号可以获得后台角色。'],
  last_admin:[409,'系统需要保留至少一位有效的系统管理员。'],
  invalid_request:[400,'请检查输入字段及其格式。'],
  invite_account_exists:[409,'该邮箱已有账号，请先在用户列表核对。'],
  invite_recipient_unavailable:[409,'暂时无法为该收件人签发邀请，请联系系统管理员核对。'],
  invite_already_issued:[409,'该邀请已经签发，链接只显示一次。'],
  invite_conflict:[409,'邀请操作编号与本次申请不匹配。'],
  invite_pending:[409,'邀请正在处理，请稍后用同一操作编号核对。'],
  invite_unknown:[409,'邀请结果待核对，请先在 Supabase 核实，再决定是否补发。'],
  invite_failed:[502,'Supabase 拒绝了邀请，请检查配置和邮箱后重新发起。'],
};

function userFault(code:string,requestId?:string) {
  const [status,message] = errors[code] ?? [409,'用户管理操作未能完成。'];
  return new Fault(status,code,message,requestId);
}

export async function listAdminUsers(actor:string,filters:z.infer<typeof userListInput>):Promise<AdminUserPage> {
  const access = await adminRole(actor);
  if (access!=='system_admin' && access!=='operator') throw userFault('user_forbidden');
  const {rows:[{items}]} = await store().db.query<{items:AdminUser[]|null}>(
    'SELECT gateway.admin_list_users($1,$2,$3,$4,$5) AS items',
    [actor,filters.search??null,filters.status??null,filters.cursor??null,filters.limit]);
  if (!items) throw userFault('user_forbidden');
  const page = items.slice(0,filters.limit);
  return {items:page,nextCursor:items.length>filters.limit ? page.at(-1)!.id : null,
    canWrite:access==='system_admin',canInvite:pilotInvitesConfigured(),actorId:actor};
}

export async function writeAdminUser(actor:string,target:string,change:z.infer<typeof userChangeInput>,recent:boolean) {
  const requestId = randomUUID();
  if (/(?:token_hash=|opentoken_session=|sb_secret_[\w-]+|mg_[\w-]{43}|sk-[\w-]{15,}|sk_(?:test_|live_)[\w-]+|\b[a-f0-9]{56,64}\b)/i.test(change.payload.reason)) {
    throw new Fault(400,'user_secret_in_reason','请移除变更原因中的邀请链接或凭据。',requestId);
  }
  const {rows:[{result}]} = await store().db.query<{result:{denied:string|null;revision?:string}}>(
    'SELECT gateway.admin_write_user($1,$2,$3,$4,$5,$6) AS result',
    [actor,requestId,target,change.action,JSON.stringify(change.payload),recent]);
  if (result.denied) throw userFault(result.denied,requestId);
  return {id:target,revision:result.revision,requestId};
}

export async function inviteAdminUser(actor:string,input:z.infer<typeof userInviteInput>,origin:string) {
  if (!pilotInvitesConfigured()) {
    const role = await adminRole(actor);
    if (role!=='system_admin' && role!=='operator') throw userFault('user_forbidden');
    throw new Fault(503,'invite_unavailable','此环境尚未配置用户邀请。');
  }
  const {email,operationId} = input;
  const requestId = randomUUID();
  const {db} = store();
  const {rows:[{denied}]} = await db.query<{denied:string|null}>(
    'SELECT gateway.admin_begin_user_invite($1,$2,$3,$4,$5) AS denied',
    [actor,requestId,operationId,email,inviteRecipientDigest(process.env.GATEWAY_SECRET,email)]);
  if (denied) throw userFault(denied,requestId);
  let link:string|undefined;
  let result = 'issued';
  try {
    link = await generatePilotInvite(email,{...process.env,APP_ORIGIN:origin});
  } catch (failure) {
    result = failure instanceof PilotInviteError && failure.definitive ? 'failed' : 'unknown';
  }
  const {rows:[{canReveal}]} = await db.query<{canReveal:boolean}>(
    'SELECT gateway.admin_finish_user_invite($1,$2,$3,$4) AS "canReveal"',[actor,randomUUID(),operationId,result]);
  if (!canReveal) throw userFault('user_forbidden',requestId);
  if (!link) throw userFault(result==='failed' ? 'invite_failed' : 'invite_unknown',requestId);
  return {operationId,requestId,link};
}
