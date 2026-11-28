import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { siteDisplay } from '@/lib/admin-settings';
import { adminRole } from '@/lib/admin';
import { sessionCookie, sessionUser } from '@/lib/session';
import { Dashboard, Keys, Login, Pricing, Redeem, Usage } from '../console';

const screens = ['dashboard','pricing','keys','usage','redeem'] as const;
const labels = ['概览','模型价格','API 密钥','使用记录','兑换与流水'];

export default async function Screen({ params }: { params:Promise<{screen:string}> }) {
  const { screen } = await params;
  if (screen !== 'login' && !screens.some(item => item === screen)) notFound();
  const user = await sessionUser((await cookies()).get(sessionCookie)?.value);
  if (screen === 'login') return user ? redirect('/dashboard') : <Login />;
  if (!user) redirect('/login?redirect=/' + screen);
  const [role,display] = await Promise.all([adminRole(user),siteDisplay()]);
  return <div className="shell">
    <aside>
      <a className="brand" href="/dashboard">OpenToken</a>
      <span className="badge">试点控制台</span>
      <nav aria-label="控制台">
        {screens.map((item,i) => <a key={item} href={'/'+item} aria-current={item===screen ? 'page' : undefined}>{labels[i]}</a>)}
        {role && <a href="/admin">管理员后台</a>}
      </nav>
    </aside>
    <main>
      <header className="top"><span>模型接入控制台</span><form action="/logout" method="post"><button>退出登录</button></form></header>
      <div className="workspace">
        {display.announcement && <section className="panel" aria-label="站点公告">{display.announcement}</section>}
        {display.supportUrl && <a href={display.supportUrl} rel="noreferrer">联系支持</a>}
        {screen==='dashboard' && <Dashboard tz={display.timeZone} />}
        {screen==='keys' && <Keys />}
        {screen==='pricing' && <Pricing />}
        {screen==='usage' && <Usage tz={display.timeZone} />}
        {screen==='redeem' && <Redeem tz={display.timeZone} />}
      </div>
    </main>
  </div>;
}
