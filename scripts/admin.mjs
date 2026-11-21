import { z } from 'zod';
import { inviteRecipientDigest } from '../lib/pilot-invite.mjs';

const roles = ['system_admin','operator','auditor'];
const reasons = ['initial_setup','staff_change','role_review','incident_response'];
const denials = {
  account_ineligible:'Administrator roles require an active, confirmed account',
  last_admin:'Cannot remove the last system administrator',
  first_admin_required:'Assign a system administrator first',
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function adminCommand(client,args,env=process.env) {
  const [action,userId,roleOrReason,grantReason] = args;
  if (action==='reconcile-invite') {
    const input = z.string().trim().toLowerCase().pipe(z.email().max(254)).safeParse(roleOrReason);
    if (args.length!==3 || !uuid.test(userId ?? '') || !input.success) {
      throw new Error('Expected admin reconcile-invite OPERATION_UUID RECIPIENT_EMAIL');
    }
    const digest = inviteRecipientDigest(env.GATEWAY_SECRET,input.data);
    const {rows:[{result}]} = await client.query('SELECT gateway.reconcile_user_invite($1,$2,$3) AS result',
      [userId,input.data,digest]);
    const failures = {
      invite_recipient_mismatch:'Invitation does not match this recipient',
      invite_still_waiting:'Still waiting for the provider outcome. Wait at least two minutes from the operation start',
      invite_already_resolved:'Invitation is already resolved',
    };
    if (result.denied) throw new Error(`${failures[result.denied] ?? 'Invitation reconciliation denied'} (audit ${result.requestId})`);
    return {operationId:userId,status:result.status,requestId:result.requestId};
  }
  const grant = action==='grant' && args.length===4 && roles.includes(roleOrReason);
  const revoke = action==='revoke' && args.length===3;
  const reason = grant ? grantReason : roleOrReason;
  if ((!grant && !revoke) || !uuid.test(userId ?? '') || !reasons.includes(reason)) {
    throw new Error('Expected admin grant USER_UUID ROLE REASON or admin revoke USER_UUID REASON. Reasons: '+reasons.join(', '));
  }
  const {rows:[{result}]} = await client.query('SELECT gateway.set_admin_role($1,$2,$3) AS result',
    [userId,grant ? roleOrReason : null,reason]);
  if (result.denied) {
    const message = denials[result.denied] ?? 'Administrator role change denied';
    throw new Error(`${message} (audit ${result.requestId})`);
  }
  return {userId,role:result.role,requestId:result.requestId};
}
