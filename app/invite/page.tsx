import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { inviteSetupCookie, localInviteSetupCookie } from '@/lib/invite';
import { InviteForm } from './invite-form';

export const metadata: Metadata = {
  title:'设置试点账号密码 | OpenToken',
  referrer:'no-referrer',
  robots:{index:false,follow:false},
};

export default async function InvitePage() {
  const cookieStore = await cookies();
  const pendingSetup = cookieStore.has(inviteSetupCookie) || cookieStore.has(localInviteSetupCookie);
  return <main className="login"><InviteForm pendingSetup={pendingSetup} /></main>;
}
