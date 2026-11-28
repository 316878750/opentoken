import { AdminShell } from '../admin-shell';
import { siteDisplay } from '@/lib/admin-settings';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { adminAccess } from '@/lib/admin';
import { sessionCookie } from '@/lib/session';
import { ChannelManager } from './channel-manager';

export const dynamic = 'force-dynamic';

export default async function ChannelsPage() {
  const {userId,role} = await adminAccess((await cookies()).get(sessionCookie)?.value,'admin.page');
  if (!userId) redirect('/login?redirect=/admin/channels');
  if (role!=='system_admin' && role!=='operator') notFound();
  const {timeZone} = await siteDisplay();
  return <AdminShell role={role} path="/admin/channels">
    <ChannelManager timeZone={timeZone}/>
  </AdminShell>;
}
