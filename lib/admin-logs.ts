import * as z from 'zod';
import { store } from './data';
import { Fault } from './gateway';

const auditDate = z.iso.datetime({offset:true})
  .refine(value=>!value.startsWith('0000-') && !/\.\d{4}/.test(value) && Number.isFinite(Date.parse(value)))
  .transform(value=>new Date(value).toISOString()).refine(value=>/^\d{4}-/.test(value) && !value.startsWith('0000-'));
const range = {
  from:auditDate.optional(),to:auditDate.optional(),
  cursor:z.uuid().optional(),requestId:z.uuid().optional(),
  limit:z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).default('25').transform(Number),
};
const ordered = (value:{from?:string;to?:string})=>!value.from || !value.to || Date.parse(value.from)<Date.parse(value.to);
export const loginLogFilter = z.strictObject({...range,userId:z.uuid().optional(),
  identifier:z.string().regex(/^[0-9a-f]{12}$/).optional(),
  outcome:z.enum(['success','failure','rate_limited','unavailable']).optional(),
}).refine(ordered);
export const operationLogFilter = z.strictObject({...range,actorId:z.uuid().optional(),
  object:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  outcome:z.enum(['success','denied']).optional(),
  action:z.string().regex(/^[a-z][a-z_.]{0,39}$/).optional(),
}).refine(ordered);

type AuditRow = {requestId:string;occurredAt:string;outcome:string;reason:string};
export type LoginLog = AuditRow & {userId:string|null;identifier:string};
export type OperationLog = AuditRow & {actorId:string|null;targetId:string|null;source:'account'|'database';
  action:string;details:Record<string,unknown>};
export type AuditPage = {items:(LoginLog|OperationLog)[];nextCursor:string|null};

export async function listAdminLogs(userId:string,query:
  {kind:'login';filters:z.infer<typeof loginLogFilter>}|{kind:'operation';filters:z.infer<typeof operationLogFilter>}) {
  const sql = query.kind==='login' ? 'SELECT gateway.admin_list_login_events($1,$2) AS items'
    : 'SELECT gateway.admin_list_operation_events($1,$2) AS items';
  const {rows:[{items}]} = await store().db.query<{items:AuditPage['items']|null}>(sql,[userId,JSON.stringify(query.filters)]);
  if (!items) throw new Fault(403,'admin_logs_forbidden','当前账号没有查看此日志的权限。');
  const page = items.slice(0,query.filters.limit);
  return {items:page,nextCursor:items.length>page.length ? page.at(-1)!.requestId : null};
}
