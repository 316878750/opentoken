import { AdminShell } from '../admin-shell';
import { siteDisplay } from '@/lib/admin-settings';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { adminAccess } from '@/lib/admin';
import { sessionCookie } from '@/lib/session';
import { UserManager } from './user-manager';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const {userId,role} = await adminAccess((await cookies()).get(sessionCookie)?.value,'admin.page');
  if (!userId) redirect('/login?redirect=/admin/users');
  if (role!=='system_admin' && role!=='operator') notFound();
  const {timeZone} = await siteDisplay();
  return <AdminShell role={role} path="/admin/users">
    <UserManager timeZone={timeZone}/>
  </AdminShell>;
}
