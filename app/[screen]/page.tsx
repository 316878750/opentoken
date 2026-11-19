import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { sessionCookie, sessionUser } from '@/lib/session';
import { Dashboard, Keys, Login, Pricing, Usage } from '../console';

const screens = ['dashboard','pricing','keys','usage'] as const;
const labels = ['概览','模型价格','API 密钥','使用记录'];

export default async function Screen({ params }: { params:Promise<{screen:string}> }) {
  const { screen } = await params;
  if (screen !== 'login' && !screens.some(item => item === screen)) notFound();
  const user = await sessionUser((await cookies()).get(sessionCookie)?.value);
  if (screen === 'login') return user ? redirect('/dashboard') : <Login />;
  if (!user) redirect('/login?redirect=/' + screen);
  return <div className="shell">
    <aside>
      <a className="brand" href="/dashboard">OpenToken</a>
      <span className="badge">试点控制台</span>
      <nav aria-label="控制台">
        {screens.map((item,i) => <a key={item} href={'/'+item} aria-current={item===screen ? 'page' : undefined}>{labels[i]}</a>)}
      </nav>
    </aside>
    <main>
      <header className="top"><span>模型接入控制台</span><form action="/logout" method="post"><button>退出登录</button></form></header>
      <div className="workspace">
        {screen==='dashboard' && <Dashboard />}
        {screen==='keys' && <Keys />}
        {screen==='pricing' && <Pricing />}
        {screen==='usage' && <Usage />}
      </div>
    </main>
  </div>;
}
