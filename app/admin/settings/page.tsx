import { AdminShell } from '../admin-shell';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { adminAccess } from '@/lib/admin';
import { readSettings } from '@/lib/admin-settings';
import { sessionCookie } from '@/lib/session';
import { SettingsManager } from './settings-manager';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const {userId,role} = await adminAccess((await cookies()).get(sessionCookie)?.value,'admin.page');
  if (!userId) redirect('/login?redirect=/admin/settings');
  if (role!=='system_admin' && role!=='operator') notFound();
  const page = await readSettings(userId);
  return <AdminShell role={role} path="/admin/settings">
    <SettingsManager initial={page}/>
  </AdminShell>;
}
