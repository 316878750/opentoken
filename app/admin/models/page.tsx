import { AdminShell } from '../admin-shell';
import { siteDisplay } from '@/lib/admin-settings';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { adminAccess } from '@/lib/admin';
import { sessionCookie } from '@/lib/session';
import { ModelManager } from './model-manager';

export const dynamic = 'force-dynamic';

export default async function ModelsPage() {
  const {userId,role} = await adminAccess((await cookies()).get(sessionCookie)?.value,'admin.page');
  if (!userId) redirect('/login?redirect=/admin/models');
  if (role!=='system_admin' && role!=='operator') notFound();
  const {timeZone} = await siteDisplay();
  return <AdminShell role={role} path="/admin/models">
    <ModelManager timeZone={timeZone}/>
  </AdminShell>;
}
