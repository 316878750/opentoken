import { AdminShell } from '../admin-shell';
import { siteDisplay } from '@/lib/admin-settings';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { adminAccess } from '@/lib/admin';
import { sessionCookie } from '@/lib/session';
import { AuditLog } from './audit-log';

export default async function AuditPage({params}:{params:Promise<{audit:string}>}) {
  const {audit} = await params;
  if (audit!=='login-logs' && audit!=='operation-logs') notFound();
  const {userId,role} = await adminAccess((await cookies()).get(sessionCookie)?.value,'admin.page');
  if (!userId) redirect('/login?redirect=/admin/'+audit);
  const login = audit==='login-logs';
  if (!role || (login && role==='operator')) notFound();
  const {timeZone} = await siteDisplay();
  return <AdminShell role={role} path={login?'/admin/login-logs':'/admin/operation-logs'}>
    <AuditLog timeZone={timeZone} screen={audit} ownOnly={role==='operator'}/>
  </AdminShell>;
}
