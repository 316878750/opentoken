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
  return <div className="shell">
    <aside><a className="brand" href="/dashboard">OpenToken</a>
      <nav aria-label="管理员后台">
        <a href="/admin">管理员后台</a>
        {role!=='operator' && <a href="/admin/login-logs" aria-current={login?'page':undefined}>登录日志</a>}
        <a href="/admin/operation-logs" aria-current={!login?'page':undefined}>操作日志</a>
      </nav>
    </aside>
    <main><header className="top"><span>管理控制台</span><form action="/logout" method="post"><button>退出登录</button></form></header>
      <div className="workspace"><AuditLog screen={audit} ownOnly={role==='operator'}/></div>
    </main>
  </div>;
}
