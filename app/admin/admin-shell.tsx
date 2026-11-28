import type { ReactNode } from 'react';
import type { AdminRole } from '@/lib/admin';

const modules = [
  ['/admin','兑换码管理'],
  ['/admin/channels','渠道管理'],
  ['/admin/models','模型管理'],
  ['/admin/users','用户管理'],
  ['/admin/login-logs','登录日志'],
  ['/admin/operation-logs','操作日志'],
  ['/admin/settings','系统设置'],
] as const;
const roleNames = {system_admin:'系统管理员',operator:'运营人员',auditor:'审计员'};

export function AdminShell({role,path,children}:{
  role:AdminRole;path:typeof modules[number][0];children:ReactNode;
}) {
  const visible = modules.filter(([href])=>{
    if (href==='/admin' || href==='/admin/operation-logs') return true;
    return href==='/admin/login-logs' ? role!=='operator' : role!=='auditor';
  });
  return <div className="shell admin-shell" data-admin-entry>
    <aside>
      <a className="brand" href="/dashboard">OpenToken</a>
      <nav aria-label="管理员后台">
        {visible.map(([href,label])=><a key={href} href={href} aria-current={path===href?'page':undefined}>{label}</a>)}
        <a className="console-return" href="/dashboard">返回用户控制台</a>
      </nav>
    </aside>
    <main><header className="top"><span>管理员后台 · {roleNames[role]}</span>
      <form action="/logout" method="post"><button>退出登录</button></form></header>
      <div className="workspace">{children}</div>
    </main>
  </div>;
}
