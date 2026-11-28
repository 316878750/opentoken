import { AdminShell } from './admin-shell';
import { siteDisplay } from '@/lib/admin-settings';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { adminAccess } from '@/lib/admin';
import { sessionCookie } from '@/lib/session';
import { RedeemCodes } from './redeem-codes';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const {userId,role} = await adminAccess((await cookies()).get(sessionCookie)?.value,'admin.page');
  if (!userId) redirect('/login?redirect=/admin');
  if (!role) notFound();

  const {timeZone} = await siteDisplay();
  return <AdminShell role={role} path="/admin">
    <RedeemCodes timeZone={timeZone} key={userId} actorId={userId} canWrite={role!=='auditor'}/>
  </AdminShell>;
}
