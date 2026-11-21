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
  return <div className="shell">
    <aside><a className="brand" href="/dashboard">OpenToken</a><nav aria-label="管理员后台">
      <a href="/admin">管理员后台</a><a href="/admin/channels" aria-current="page">渠道管理</a><a href="/admin/models">模型管理</a>
      <a href="/admin/users">用户管理</a>
    </nav></aside>
    <main><header className="top"><span>管理控制台</span><form action="/logout" method="post"><button>退出登录</button></form></header>
      <div className="workspace"><ChannelManager /></div>
    </main>
  </div>;
}
