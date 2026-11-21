import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { adminAccess, type AdminRole } from '@/lib/admin';
import { sessionCookie } from '@/lib/session';

export const dynamic = 'force-dynamic';

const roleLabels: Record<AdminRole,string> = {
  system_admin:'系统管理员',
  operator:'运营人员',
  auditor:'审计员',
};

export default async function AdminPage() {
  const {userId,role} = await adminAccess((await cookies()).get(sessionCookie)?.value,'admin.page');
  if (!userId) redirect('/login?redirect=/admin');
  if (!role) notFound();

  return <div className="shell" data-admin-entry>
    <aside>
      <a className="brand" href="/dashboard">OpenToken</a>
      <nav aria-label="管理员后台">
        <a href="/admin" aria-current="page">管理员后台</a>
        <a href="/dashboard">返回控制台</a>
      </nav>
    </aside>
    <main>
      <header className="top"><span>管理员后台</span><form action="/logout" method="post"><button>退出登录</button></form></header>
      <div className="workspace">
        <section className="panel">
          <h1>管理员后台</h1>
          <p>当前角色为{roleLabels[role]}。</p>
        </section>
      </div>
    </main>
  </div>;
}
