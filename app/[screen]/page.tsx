import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { siteDisplay } from '@/lib/admin-settings';
import { adminRole } from '@/lib/admin';
import { sessionCookie, sessionUser } from '@/lib/session';
import { Dashboard, Keys, Login, Pricing, Redeem, Usage } from '../console';
import { guidePath } from '@/lib/catalog-display';
import { NavigationMenu } from '../navigation-menu';

const screens = ['dashboard','pricing','keys','usage','redeem'] as const;
const labels = ['概览','模型价格','API 密钥','使用记录','兑换与流水'];

export default async function Screen({ params,searchParams }: {
  params:Promise<{screen:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>;
}) {
  const { screen } = await params;
  if (screen !== 'login' && !screens.some(item => item === screen)) notFound();
  const user = await sessionUser((await cookies()).get(sessionCookie)?.value);
  const query = await searchParams;
  const selection = (screen==='keys' || (screen==='login' && query.redirect==='/keys')) &&
    (query.model!==undefined || query.groupId!==undefined) ? {
      model:typeof query.model==='string'?query.model:'',groupId:typeof query.groupId==='string'?query.groupId:'',
    } : undefined;
  if (screen === 'login') return user ? redirect(selection?guidePath(selection):'/dashboard') : <Login selection={selection}/>;
  if (!user) redirect('/login?redirect=/' + screen+(selection?'&'+new URLSearchParams(selection):''));
  const [role,display] = await Promise.all([adminRole(user),siteDisplay()]);
  return <div className="shell">
    <aside>
      <a className="brand" href="/dashboard">OpenToken</a>
      <span className="badge">试点控制台</span>
      <NavigationMenu><nav aria-label="控制台">
        {screens.map((item,i) => <a key={item} href={'/'+item} aria-current={item===screen ? 'page' : undefined}>{labels[i]}</a>)}
        {role && <a href="/admin">管理员后台</a>}
      </nav></NavigationMenu>
    </aside>
    <main>
      <header className="top"><span>模型接入控制台</span><form action="/logout" method="post"><button>退出登录</button></form></header>
      <div className="workspace">
        {display.announcement && <section className="panel" aria-label="站点公告">{display.announcement}</section>}
        {display.supportUrl && <a href={display.supportUrl} rel="noreferrer">联系支持</a>}
        {screen==='dashboard' && <Dashboard tz={display.timeZone} />}
        {screen==='keys' && <Keys selection={selection}/>}
        {screen==='pricing' && <Pricing />}
        {screen==='usage' && <Usage tz={display.timeZone} />}
        {screen==='redeem' && <Redeem tz={display.timeZone} />}
      </div>
    </main>
  </div>;
}
