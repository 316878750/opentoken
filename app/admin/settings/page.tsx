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
  return <div className="shell"><aside><a className="brand" href="/dashboard">OpenToken</a>
    <nav aria-label="管理员后台"><a href="/admin">管理员后台</a><a href="/admin/settings" aria-current="page">系统设置</a>
    <a href="/admin/operation-logs">操作日志</a></nav></aside>
    <main><header className="top"><span>管理控制台</span><form action="/logout" method="post"><button>退出登录</button></form></header>
    <div className="workspace"><SettingsManager initial={page}/></div></main></div>;
}
