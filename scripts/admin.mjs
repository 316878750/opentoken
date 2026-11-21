const roles = ['system_admin','operator','auditor'];
const reasons = ['initial_setup','staff_change','role_review','incident_response'];
const denials = {
  account_ineligible:'Administrator roles require an active, confirmed account',
  last_admin:'Cannot remove the last system administrator',
  first_admin_required:'Assign a system administrator first',
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function adminCommand(client,args) {
  const [action,userId,roleOrReason,grantReason] = args;
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
