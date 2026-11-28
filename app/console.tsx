'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { TrendDay } from '@/lib/reports';
import { catalogPrice, guidePath, type CatalogSelection } from '@/lib/catalog-display';

type Rate = {groupId:string;groupName:string;model:string;maxOutputTokens:number;inputMicros:string;cacheMicros:string;outputMicros:string;multiplierBps:number;upstream:'mock'|'openai'|'compatible';streaming:boolean};
type KeyRow = {id:string;name:string;prefix:string;status:string;groupId:string;groupName:string;rpm:number;capMicros:string|null};
type RequestRow = {id:string;prefix:string;model:string;status:string;reservedMicros:string;releasedMicros:string|null;standardMicros:string|null;
  chargedMicros:string|null;ledgerDeltaMicros:string|null;inputTokens:number|null;cachedTokens:number|null;outputTokens:number|null;createdAt:string;updatedAt:string;upstreamRequestId:string|null};
type Wallet = {balanceMicros:string;heldMicros:string;refundHeldMicros?:string;availableMicros:string;asOf:string;activeKeys:number;
  requests:number;todayRequests:number;tokens:string;todayTokens:string;chargedMicros:string;standardMicros:string;
  todayChargedMicros:string;reviewCount:number};
type UsagePage = {items:RequestRow[];nextCursor:string|null};
type WalletEntry = {id:string;kind:'redemption'|'usage'|'stripe_refund'|'stripe_refund_reversal';deltaMicros:string;requestId:string|null;createdAt:string};
const ledgerKind:Record<WalletEntry['kind'],string> = {
  redemption:'额度到账',usage:'模型扣费',stripe_refund:'充值退款',stripe_refund_reversal:'退款失败返还',
};
type WalletPage = {items:WalletEntry[];nextCursor:string|null};
type CreditReceipt = {receipt:{id:string;amountMicros:string;createdAt:string};replayed:boolean;
  wallet:Pick<Wallet,'balanceMicros'|'heldMicros'|'refundHeldMicros'|'availableMicros'>};

export class ApiError extends Error {
  constructor(public status:number, message:string, public requestId?:string, public code?:string) { super(message); }
}

export async function api<T>(url:string, options:RequestInit = {}): Promise<T> {
  const response = await fetch(url,{ ...options,cache:'no-store',headers:{
    ...options.headers,...(options.body ? {'Content-Type':'application/json'} : {}),
  } });
  const data = await response.json();
  if (!response.ok) {
    if (response.status===401 && url.startsWith('/api/') && url!=='/api/session/login') {
      const params = new URLSearchParams(location.search);
      const selection = location.pathname==='/keys' && (params.has('model') || params.has('groupId'))
        ? new URLSearchParams({model:params.get('model')??'',groupId:params.get('groupId')??''}) : undefined;
      location.replace('/login?redirect='+location.pathname+(selection?'&'+selection:''));
    }
    throw new ApiError(response.status,data.error?.message || '暂时无法完成操作。',data.error?.request_id,data.error?.code);
  }
  return data;
}

export function useData<T>(url:string, interval = 0) {
  const [snapshot,setSnapshot] = useState<{url:string;data:T}>();
  const [error,setError] = useState('');
  const [reload,refresh] = useState(0);
  const revision = useRef(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const current = revision.current;
      try {
        const data = await api<T>(url,{signal:AbortSignal.timeout(12000)});
        if (!stopped && current===revision.current) { setSnapshot({url,data}); setError(''); }
      } catch {
        if (!stopped && current===revision.current) setError('数据暂未更新，请重试。');
      } finally {
        if (!stopped && interval) timer = setTimeout(load,interval);
      }
    }
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  },[url,interval,reload]);
  return {data:snapshot?.url===url ? snapshot.data : undefined,error,refresh:() => refresh(n => n+1),
    replaceAndRefresh:(data:T)=>{
      revision.current++;
      setSnapshot({url,data});setError('');refresh(n=>n+1);
    }};
}

export function money(micros: string | null) {
  if (micros===null) return '待确认';
  const value = BigInt(micros);
  const remainder = (value % 1_000_000n).toString().padStart(6,'0').replace(/0+$/,'').padEnd(2,'0');
  return 'USD '+(value/1_000_000n).toLocaleString('en-US')+'.'+remainder;
}

function statusLabel(status:string) {
  return ({reserved:'处理中',dispatched:'处理中',review:'待核对',settled:'已结算',released:'已释放',
    active:'启用',disabled:'停用',revoked:'已撤销'} as Record<string,string>)[status] || status;
}

function Heading({title,description}:{title:string;description:string}) {
  return <div className="heading"><h1>{title}</h1><p>{description}</p></div>;
}
function ErrorNote({error}:{error:string}) { return error ? <p className="error" role="alert">{error}</p> : null; }
function Placeholder({error}:{error:string}) { return <p className="panel muted">{error ? '暂时无法读取数据。' : '正在读取数据…'}</p>; }

export function Login({selection}:{selection?:CatalogSelection}) {
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      await api('/api/session/login',{method:'POST',body:JSON.stringify(Object.fromEntries(form)),signal:AbortSignal.timeout(22000)});
      const destination = new URLSearchParams(location.search).get('redirect');
      const destinations = ['/dashboard','/pricing','/keys','/usage','/redeem','/admin','/admin/channels','/admin/models',
        '/admin/users','/admin/settings','/admin/login-logs','/admin/operation-logs'];
      location.replace(destination==='/keys' && selection ? guidePath(selection) :
        destination && destinations.includes(destination) ? destination : '/dashboard');
    } catch (error) {
      setError(error instanceof ApiError ? error.message : '登录请求暂时无法完成。');
      setBusy(false);
    }
  }
  return <main className="login"><form className="panel" action="/api/session/login" method="post" onSubmit={submit}>
    <span className="brand">OpenToken</span><Heading title="登录控制台" description="使用受邀账号登录，创建 API 密钥并查看每笔调用费用。" />
    <label>邮箱<input type="email" name="email" autoComplete="username" required /></label>
    <label>密码<input type="password" name="password" autoComplete="current-password" required /></label>
    <ErrorNote error={error} /><button className="primary" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
  </form></main>;
}

const trendMetrics = {requests:'请求数',tokens:'计费 Token',chargedMicros:'实际扣费'} as const;

function UsageTrend({tz}:{tz:string}) {
  const [days,setDays] = useState<'7'|'30'>('7');
  const [metric,setMetric] = useState<keyof typeof trendMetrics>('requests');
  const {data,error,refresh} = useData<{items:TrendDay[]}>('/api/usage-trend?days='+days+'&tz='+encodeURIComponent(tz),15000);
  const value = (day:TrendDay) => BigInt(day[metric]);
  const peak = data?.items.reduce((max,day)=>value(day)>max ? value(day) : max,0n) ?? 0n;
  const format = (amount:bigint) => metric==='chargedMicros' ? money(amount.toString()) : amount.toLocaleString('zh-CN');
  const hasRequests = data?.items.some(day=>day.requests>0);
  return <section className="panel" aria-labelledby="trend-title">
    <h2 id="trend-title">用量趋势</h2>
    <div className="filters">
      <label>时间范围<select value={days} onChange={e=>setDays(e.target.value==='30' ? '30' : '7')}>
        <option value="7">最近 7 天</option><option value="30">最近 30 天</option>
      </select></label>
      <label>指标<select value={metric} onChange={e=>setMetric(e.target.value as keyof typeof trendMetrics)}>
        <option value="requests">请求数</option><option value="tokens">计费 Token</option><option value="chargedMicros">实际扣费</option>
      </select></label>
      <button type="button" onClick={refresh}>刷新趋势</button>
    </div>
    <ErrorNote error={error} />
    {data ? hasRequests ? <>
      <p className="muted trend-summary">时区 {tz} · 单日峰值 {format(peak)}</p>
      <div className="trend-chart" aria-hidden="true">{data.items.map(day=>
        <div key={day.date} title={day.date+' · '+trendMetrics[metric]+' '+format(value(day))}
          style={{height:(peak>0n ? Number(value(day)*10000n/peak)/100 : 0)+'%'}} />)}</div>
      <div className="trend-dates" aria-hidden="true">
        <span>{data.items[0]?.date}</span><span>{data.items.at(-1)?.date}</span>
      </div>
      <details className="trend-details">
        <summary>查看按日明细</summary>
        <div className="table-wrap"><table><thead><tr><th scope="col">日期</th><th scope="col">请求数</th>
          <th scope="col">计费 Token</th><th scope="col">实际扣费</th></tr></thead>
          <tbody>{data.items.map(day=><tr key={day.date}><th scope="row">{day.date}</th>
            <td>{day.requests.toLocaleString('zh-CN')}</td><td>{BigInt(day.tokens).toLocaleString('zh-CN')}</td>
            <td>{money(day.chargedMicros)}</td></tr>)}</tbody></table></div>
      </details>
    </> : <p className="muted trend-summary">这段时间没有请求。</p> :
      !error && <p className="muted trend-summary">正在读取趋势…</p>}
  </section>;
}

export function Dashboard({tz}:{tz:string}) {
  const {data,error,refresh} = useData<Wallet>('/api/dashboard?tz='+encodeURIComponent(tz),1200);
  return <><Heading title="概览" description="核对可用额度、预占和已结算费用。" />
    <div className="actions"><a className="action primary" href="/keys">管理密钥</a><a className="action" href="/usage">查看使用记录</a>
      <a className="action" href="/redeem">兑换额度</a>
      <button type="button" onClick={refresh}>刷新余额和汇总</button></div>
    <ErrorNote error={error} />
    {data ? <><section className="panel" aria-labelledby="wallet-title"><h2 id="wallet-title">余额</h2>
      <dl className="metrics">
        <div><dt>可用余额</dt><dd data-testid="available">{money(data.availableMicros)}</dd></div>
        <div><dt>账面余额</dt><dd data-testid="balance">{money(data.balanceMicros)}</dd></div>
        <div><dt>预占金额</dt><dd data-testid="held">{money(data.heldMicros)}</dd></div>
        {data.refundHeldMicros && data.refundHeldMicros!=='0' && <div><dt>退款冻结</dt><dd>{money(data.refundHeldMicros)}</dd></div>}
      </dl>
      <p className="muted">{data.heldMicros!=='0' ? '预占额度暂留给处理中或待核对的请求。' : '当前没有预占额度。'}</p>
      <small className="muted">更新于 {new Date(data.asOf).toLocaleTimeString('zh-CN',{timeZone:tz})}</small>
      {data.reviewCount>0 && <p><a href="/usage?status=review">查看 {data.reviewCount} 笔待核对请求</a></p>}
    </section>
    {data.requests===0 && <section className="panel first-call" aria-labelledby="first-call-title">
      <h2 id="first-call-title">发起第一次调用</h2>
      <ol className="setup-steps">
        <li><strong>准备额度</strong><p>{BigInt(data.availableMicros)>0n ? '已有可用余额，可用于请求预占。' : '可用余额为零。有兑换码时可先兑换试点额度。'}</p>
          <a href="/redeem">查看额度与流水</a></li>
        <li><strong>保存分组密钥</strong><p>{data.activeKeys>0 ? '已有启用的密钥，可使用已保存的完整值。' : '创建一把 API 密钥，并保存仅显示一次的完整值。'}</p>
          <a href="/keys">{data.activeKeys>0 ? '管理密钥' : '创建第一把密钥'}</a></li>
        <li><strong>运行示例并查账</strong><p>使用密钥所属分组的模型调用一次，再用响应里的请求 ID 查账。</p>
          <a href="/keys#connection-guide">查看接入示例</a></li>
      </ol>
    </section>}
    <section className="panel"><h2>用量与已结算费用</h2><p>统计时区 {tz}</p>
      <dl className="metrics">
        <div><dt>今日 / 累计请求</dt><dd>{data.todayRequests} / {data.requests}</dd></div>
        <div><dt>今日 / 累计计费 Token</dt><dd>{data.todayTokens} / {data.tokens}</dd></div>
        <div><dt>启用密钥</dt><dd>{data.activeKeys}</dd></div>
        <div><dt>今日实际扣费</dt><dd>{money(data.todayChargedMicros)}</dd></div>
        <div><dt>累计实际扣费</dt><dd>{money(data.chargedMicros)}</dd></div>
        <div><dt>累计标准费用</dt><dd>{money(data.standardMicros)}</dd></div>
      </dl>
    </section></> : <Placeholder error={error} />}
    <UsageTrend tz={tz} />
  </>;
}

export function Pricing() {
  const {data,error,refresh} = useData<{rates:Rate[]}>('/api/catalog');
  const [search,setSearch] = useState('');
  const [group,setGroup] = useState('');
  const [provider,setProvider] = useState('');
  const [streaming,setStreaming] = useState(false);
  const [compare,setCompare] = useState('');
  const [basis,setBasis] = useState('group');
  const providers = {mock:'模拟',compatible:'兼容上游',openai:'OpenAI'};
  const rates = data?.rates ?? [];
  const groups = new Map(rates.map(rate=>[rate.groupId,rate.groupName]));
  const modelCounts = new Map<string,number>();
  for (const rate of rates) modelCounts.set(rate.model,(modelCounts.get(rate.model)??0)+1);
  const rows = rates.filter(rate=>compare ? rate.model===compare :
    rate.model.toLowerCase().includes(search.trim().toLowerCase()) && (!group || rate.groupId===group) &&
    (!provider || rate.upstream===provider) && (!streaming || rate.streaming))
    .sort((a,b)=>a.model.localeCompare(b.model) || a.groupName.localeCompare(b.groupName,'zh-CN'));
  return <><Heading title="模型价格" description="按模型与分组比较每百万 Token 的单价，选择后查看接入示例。" />
    <section className="panel catalog" aria-label="模型目录">
      {compare ? <div className="actions"><h2>{compare} · 分组比价</h2>
        <button onClick={()=>setCompare('')}>返回筛选结果</button></div> :
        <div className="filters">
          <label>模型名称<input type="search" value={search} onChange={e=>setSearch(e.target.value)} /></label>
          <label>分组<select value={group} onChange={e=>setGroup(e.target.value)}><option value="">全部分组</option>
            {[...groups].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
          <label>上游<select value={provider} onChange={e=>setProvider(e.target.value)}><option value="">全部上游</option>
            {Object.entries(providers).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
          <label className="check"><input type="checkbox" checked={streaming} onChange={e=>setStreaming(e.target.checked)}/>支持流式</label>
          <button disabled={!search && !group && !provider && !streaming} onClick={()=>{
            setSearch('');setGroup('');setProvider('');setStreaming(false);
          }}>重置筛选</button>
        </div>}
      <div className="filters catalog-basis">
        <label>价格口径<select value={basis} onChange={e=>setBasis(e.target.value)}>
          <option value="group">分组单价（已计倍率）</option><option value="base">基础单价（乘倍率前）</option>
        </select></label><button onClick={refresh}>刷新目录</button>
      </div>
      <ErrorNote error={error}/>
      {!data ? <p role="status">{error?'暂时无法读取目录，请刷新重试。':'正在读取目录…'}</p> :
        !rows.length ? <p className="list-empty">{!rates.length?'暂无可用模型。':compare?'该模型已退出目录。':'没有符合条件的模型，可重置筛选。'}</p> :
        <div className="table-wrap" role="region" aria-label="费率表格" tabIndex={0}><table className="phone-records" aria-label={compare?'模型分组比价':'模型费率'}>
          <caption>{basis==='group'?'分组单价':'基础单价'} · 美元 / 百万 Token</caption>
          <thead><tr>{['模型','分组','输入','缓存读取','输出','倍率','请求方式','接入'].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{rows.map(rate=>{
            const multiplier = basis==='group'?rate.multiplierBps:10000;
            return <tr key={rate.groupId+rate.model}><th scope="row"><code>{rate.model}</code><br/><small>{providers[rate.upstream]}</small></th>
              <td data-label="分组">{rate.groupName}</td><td data-label="输入">{catalogPrice(rate.inputMicros,multiplier)}</td><td data-label="缓存读取">{catalogPrice(rate.cacheMicros,multiplier)}</td>
              <td data-label="输出">{catalogPrice(rate.outputMicros,multiplier)}</td><td data-label="倍率">{rate.multiplierBps/10000}×</td><td data-label="请求方式">{rate.streaming?'流式 / 非流式':'非流式'}</td>
              <td data-label="接入" className="record-wide"><a href={guidePath({model:rate.model,groupId:rate.groupId})}>接入此模型</a>
                {!compare && (modelCounts.get(rate.model)??0)>1 && <button onClick={()=>setCompare(rate.model)}>比较分组</button>}</td>
            </tr>;
          })}</tbody></table></div>}
    </section>
  </>;
}

type NewKey = {id:string;secret:string;name:string;groupId:string;groupName:string};
type Step = 'form' | 'secret' | 'confirm';

function CallExample({endpoint,rate}:{endpoint:string;rate:Rate}) {
  const [notice,setNotice] = useState('');
  const example = [
    '& {',
    "  $secret = Read-Host 'OpenToken API key' -AsSecureString",
    "  $credential = [System.Net.NetworkCredential]::new('', $secret)",
    '  $headers = @{ Authorization = "Bearer $($credential.Password)" }',
    '  $body = @{',
    `    model = '${rate.model}'`,
    "    messages = @(@{ role = 'user'; content = 'Hello' })",
    `    max_completion_tokens = ${Math.min(64,rate.maxOutputTokens)}`,
    '    stream = $false',
    '  } | ConvertTo-Json -Depth 4',
    `  $result = Invoke-RestMethod -Method Post -Uri '${endpoint}/chat/completions' \``,
    "    -Headers $headers -ContentType 'application/json' -Body $body -ErrorAction Stop",
    '  $result.choices[0].message.content',
    '  "OpenToken request ID: $($result.id)"',
    '}',
  ].join('\n');
  async function copy() {
    try { await navigator.clipboard.writeText(example); setNotice('已复制 PowerShell 示例。'); }
    catch { setNotice('请选中下方示例，手动复制。'); }
  }
  return <>
    <p>将整段粘贴到 PowerShell，按提示输入已保存的密钥。运行一次会发起一笔{rate.upstream==='mock'?'模拟':'上游'}调用，并按所选分组费率结算。</p>
    <div className="example-bar"><strong>PowerShell · 非流式</strong><button onClick={copy}>复制示例</button></div>
    <pre className="call-example" tabIndex={0} aria-label="PowerShell 调用示例"><code>{example}</code></pre>
    <p role="status">{notice}</p>
    <p>复制输出末尾的 OpenToken request ID，到<a href="/usage">使用记录</a>查询本次扣费。</p>
  </>;
}

export function Keys({selection}:{selection?:CatalogSelection}) {
  const keys = useData<{items:KeyRow[]}>('/api/keys');
  const catalog = useData<{rates:Rate[]}>('/api/catalog');
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const keyField = useRef<HTMLInputElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const open = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController>(null);
  const [step,setStep] = useState<Step>('form');
  const [created,setCreated] = useState<NewKey>();
  const [saved,setSaved] = useState(false);
  const [creating,setCreating] = useState(false);
  const [unknown,setUnknown] = useState(false);
  const [formError,setFormError] = useState('');
  const [notice,setNotice] = useState('');
  const [pageError,setPageError] = useState('');
  const [demoBusy,setDemoBusy] = useState(false);
  const lastDemo = useRef<string>(null);
  const [revoke,setRevoke] = useState<KeyRow>();
  const revokeDialog = useRef<HTMLDialogElement>(null);
  const revokeTrigger = useRef<HTMLButtonElement>(null);
  const [endpoint,setEndpoint] = useState('');
  const [guideKeyId,setGuideKeyId] = useState('');
  const [guideModel,setGuideModel] = useState('');
  const guideTitle = useRef<HTMLHeadingElement>(null);
  const focusGuideOnClose = useRef(false);
  const targetRate = selection && catalog.data?.rates.find(rate=>rate.groupId===selection.groupId && rate.model===selection.model);
  const activeKeys = keys.data?.items.filter(key=>key.status==='active' && (!selection || key.groupId===targetRate?.groupId)) ?? [];
  const guideKey = activeKeys.find(key=>key.id===guideKeyId) ?? activeKeys[0];
  const guideRates = catalog.data?.rates.filter(rate=>rate.groupId===guideKey?.groupId && (!selection || rate.model===selection.model)) ?? [];
  const guideRate = guideRates.find(rate=>rate.model===guideModel) ?? guideRates[0];
  const groups = selection ? (targetRate?[targetRate]:[]) : [...new Map(catalog.data?.rates.map(rate => [rate.groupId,rate])).values()];
  const demoAllowed = (!selection || selection.model==='mock-text') &&
    catalog.data?.rates.some(rate=>rate.groupId===created?.groupId && rate.model==='mock-text');
  const clear = useCallback(() => {
    request.current?.abort();
    if (keyField.current) keyField.current.value = '';
    setCreated(undefined); setSaved(false); setStep('form'); setFormError(''); setNotice('');
    setUnknown(false); setCreating(false);
  },[]);
  useEffect(() => {
    setEndpoint(location.origin+'/v1');
    const hide = () => { clear(); dialog.current?.close(); };
    window.addEventListener('pagehide',hide);
    return () => { window.removeEventListener('pagehide',hide); request.current?.abort(); };
  },[clear]);
  useEffect(() => {
    if (!dialog.current?.open) return;
    if (step==='confirm') keep.current?.focus();
    else if (step==='secret') title.current?.focus();
    else nameField.current?.focus();
  },[step]);

  function dismiss() {
    clear();
    dialog.current?.close();
  }
  function startCreate() {
    clear(); dialog.current?.showModal(); nameField.current?.focus();
  }
  function showGuide() {
    if (!created || !saved) return;
    setGuideKeyId(created.id); setGuideModel('');
    focusGuideOnClose.current = true;
    dismiss();
  }
  function close() {
    if (creating) return;
    if (step==='secret' && !saved) setStep('confirm');
    else if (step==='confirm') setStep('secret');
    else dismiss();
  }
  async function create(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || unknown) return;
    const form = new FormData(event.currentTarget);
    const cap = String(form.get('cap') || '').trim();
    if (cap && (!/^\d{1,9}(\.\d{1,6})?$/.test(cap) || Number(cap)<=0)) {
      setFormError('累计额度必须大于零，且最多六位小数。');
      (event.currentTarget.elements.namedItem('cap') as HTMLInputElement).focus();
      return;
    }
    const [whole,dec=''] = cap.split('.');
    const capMicros = cap ? String(BigInt(whole)*1_000_000n+BigInt(dec.padEnd(6,'0'))) : null;
    const controller = new AbortController();
    const groupId = String(form.get('groupId'));
    request.current = controller;
    setCreating(true); setFormError('');
    try {
      const result = await api<Omit<NewKey,'groupId'|'groupName'>>('/api/keys',{method:'POST',body:JSON.stringify({
        name:form.get('name'),groupId,rpm:Number(form.get('rpm')),capMicros,
      }),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])});
      if (!controller.signal.aborted) {
        setCreated({...result,groupId,groupName:groups.find(rate=>rate.groupId===groupId)?.groupName || ''});
        setStep('secret'); keys.refresh();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status<500) setFormError(error.message);
      else { setUnknown(true); setFormError('创建结果未确认。请先刷新列表，确认是否已创建。'); }
    } finally { if (!controller.signal.aborted) setCreating(false); }
  }
  async function copyKey() {
    try { await navigator.clipboard.writeText(created!.secret); setNotice('已复制密钥。'); }
    catch { keyField.current?.select(); setNotice('复制失败，已选中密钥，可手动复制。'); }
  }
  async function demo() {
    if (!created || !demoAllowed || demoBusy || lastDemo.current===created.id) return;
    lastDemo.current = created.id;
    setDemoBusy(true);
    setNotice('调用已发起。可在新标签页查看实时余额和请求。');
    try {
      const result = await api<{id:string}>('/v1/chat/completions',{method:'POST',
        headers:{Authorization:'Bearer '+created.secret,'Idempotency-Key':crypto.randomUUID()},
        body:JSON.stringify({model:'mock-text',messages:[{role:'user',content:'运行本地演示'}],max_completion_tokens:128})});
      setNotice('调用已结算。请求编号：'+result.id);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message+(error.requestId ? ' 请求编号：'+error.requestId : '') : '调用结果未确认，请到使用记录核对。');
    } finally { setDemoBusy(false); }
  }
  async function changeKey(row:KeyRow, remove = false) {
    setPageError('');
    try {
      await api('/api/keys/'+row.id,remove ? {method:'DELETE'} : {method:'PATCH',
        body:JSON.stringify({status:row.status==='active'?'disabled':'active'})});
      keys.refresh();
    } catch (error) { setPageError(error instanceof ApiError ? error.message : '暂时无法更新密钥。'); }
  }
  return <><Heading title="API 密钥" description="创建分组密钥，将模型接入本地兼容客户端。" />
    <div className="actions">
      <button ref={open} className="primary" disabled={!groups.length} onClick={startCreate}>创建密钥</button>
      <button onClick={() => {keys.refresh();catalog.refresh();}}>刷新列表</button>
    </div>
    <ErrorNote error={keys.error || catalog.error || pageError} />
    <section className="panel"><h2>接入地址</h2><p><code>{endpoint}</code></p>
      <button onClick={async () => {try { await navigator.clipboard.writeText(endpoint); setPageError(''); setNotice('已复制接入地址。'); }
        catch {setPageError('复制失败，可选中地址后手动复制。');}}}>复制接入地址</button>
      <p className="muted">密钥只能使用所属分组的模型。可用模型及流式支持见 <a href="/pricing">模型价格</a>。</p>
      {!created && notice && <p role="status">{notice}</p>}
    </section>
    <section id="connection-guide" className="panel connection-guide">
      <h2 ref={guideTitle} tabIndex={-1}>首次调用示例</h2>
      {targetRate && <p>当前选择 <strong>{targetRate.model}</strong> · {targetRate.groupName}。<a href="/pricing">更换模型或分组</a></p>}
      {!keys.data || !catalog.data ? <p>{keys.error || catalog.error ? '无法读取分组或密钥，请刷新列表。' : '正在读取分组与密钥…'}</p> :
        selection && !targetRate ? <p className="list-empty">所选模型与分组当前不可用，请<a href="/pricing">返回模型目录</a>重新选择。</p> :
        !guideKey ? <><p>{targetRate?'该分组暂无启用的密钥。':'请先创建或恢复一把密钥。'}保存完整值后即可查看调用示例。</p>
          {targetRate && <button onClick={startCreate}>为此分组创建密钥</button>}</> :
        <><div className="filters"><label>使用密钥<select value={guideKey.id} onChange={e=>{setGuideKeyId(e.target.value);setGuideModel('');}}>
          {activeKeys.map(key=><option key={key.id} value={key.id}>{key.name} · {key.prefix}… · {key.groupName}</option>)}
        </select></label>
        {guideRate && <label>调用模型<select value={guideRate.model} onChange={e=>setGuideModel(e.target.value)}>
          {guideRates.map(rate=><option key={rate.model} value={rate.model}>{rate.model}</option>)}
        </select></label>}</div>
        {guideRate && endpoint ? <CallExample key={guideKey.id+guideRate.model} endpoint={endpoint} rate={guideRate} /> :
          <p>当前分组暂无可调用模型，请查看<a href="/pricing">模型价格</a>或选择其他密钥。</p>}</>}
    </section>
    {keys.data ? <section className="panel table-wrap"><h2>密钥列表</h2>
      {keys.data.items.length ? <table className="phone-records" aria-label="密钥列表"><thead><tr><th scope="col">名称与前缀</th><th scope="col">分组</th><th scope="col">状态</th><th scope="col">额度 / RPM</th><th scope="col">操作</th></tr></thead>
        <tbody>{keys.data.items.map(row => <tr key={row.id}><td data-label="名称与前缀" className="record-wide">{row.name}<br/><code>{row.prefix}…</code></td><td data-label="分组">{row.groupName}</td>
          <td data-label="状态"><span className="badge">{statusLabel(row.status)}</span></td><td data-label="额度 / RPM">{row.capMicros===null?'不限':money(row.capMicros)} / {row.rpm}</td>
          <td data-label="操作" className="record-wide">{row.status!=='revoked' && <div className="actions"><button onClick={() => void changeKey(row)}>{row.status==='active'?'停用':'恢复'}</button>
            <button onClick={e => { revokeTrigger.current=e.currentTarget; setRevoke(row); revokeDialog.current?.showModal(); }}>撤销</button></div>}</td></tr>)}</tbody></table>
        : <p>还没有密钥。创建一把密钥即可发起第一次调用。</p>}</section> : <Placeholder error={keys.error} />}
    <dialog ref={dialog} aria-labelledby="key-title" onCancel={event => {event.preventDefault();close();}}
      onClose={() => {
        clear();
        (focusGuideOnClose.current ? guideTitle.current : open.current)?.focus();
        focusGuideOnClose.current = false;
      }}>
      <h2 id="key-title" tabIndex={-1} ref={title}>{step==='form'?'创建密钥':step==='secret'?'保存 API 密钥':'关闭密钥窗口？'}</h2>
      <form onSubmit={create} hidden={step!=='form'}>
        <p>完整密钥只在创建成功后显示一次。</p>
        <label>名称<input ref={nameField} name="name" required maxLength={80} placeholder="例如：本机测试" /></label>
        <label>分组<select name="groupId" required>{groups.map(rate =>
          <option key={rate.groupId} value={rate.groupId}>{rate.groupName}</option>)}</select></label>
        <p className="muted">更换分组需要新建密钥。</p>
        <label>累计额度（USD，可选）<input name="cap" inputMode="decimal" placeholder="留空时受钱包可用余额约束" /></label>
        <label>每分钟请求上限<input name="rpm" type="number" min={1} max={600} defaultValue={20} required /></label>
        <ErrorNote error={formError} />
        <div className="actions">
          {unknown ? <button type="button" onClick={() => {keys.refresh();dialog.current?.close();}}>刷新列表</button> :
            <button className="primary" disabled={creating}>{creating?'正在创建…':'创建'}</button>}
          <button type="button" disabled={creating} onClick={close}>取消</button>
        </div>
      </form>
      {step==='secret' && created && <div><p>请保存此密钥。退出此窗口后只能查看前缀。</p>
        <p className="muted">{created.name} · {created.groupName}</p>
        <label>完整密钥<input ref={keyField} readOnly autoComplete="off" spellCheck={false} value={created.secret} /></label>
        <div className="actions"><button onClick={copyKey}>复制密钥</button>
          {demoAllowed && <button onClick={demo} disabled={demoBusy || lastDemo.current===created.id}>{demoBusy?'模拟调用进行中…':lastDemo.current===created.id?'已发起模拟调用':'模拟调用一次'}</button>}</div>
        <div className="actions"><a href="/dashboard" target="_blank" rel="noreferrer">在新标签页看余额</a>
          <a href={'/usage?key_id='+created.id} target="_blank" rel="noreferrer">在新标签页看请求</a></div>
        <p role="status">{notice}</p>
        <label className="check"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />我已保存密钥</label>
        <div className="actions"><button className="primary" disabled={!saved} onClick={showGuide}>查看调用示例</button>
          <button onClick={close}>关闭</button></div>
      </div>}
      {step==='confirm' && <div><p>关闭后无法再次查看这把密钥的完整值。</p><div className="actions">
        <button ref={keep} onClick={() => setStep('secret')}>继续保存</button>
        <button className="danger" onClick={dismiss}>关闭并隐藏密钥</button></div></div>}
    </dialog>
    <dialog ref={revokeDialog} aria-label="撤销密钥" onClose={() => {revokeTrigger.current?.focus();setRevoke(undefined);}}>
      <h2>撤销密钥</h2><p>撤销后，使用「{revoke?.name}」的新请求将被拒绝。</p>
      <div className="actions"><button autoFocus onClick={() => revokeDialog.current?.close()}>取消</button>
        <button className="danger" onClick={() => {if (revoke) void changeKey(revoke,true);revokeDialog.current?.close();}}>确认撤销</button></div>
    </dialog>
  </>;
}

export function Usage({tz}:{tz:string}) {
  const [filter,setFilter] = useState({key_id:'',request_id:'',status:'',from:'',to:''});
  const [requestInput,setRequestInput] = useState('');
  const [cursors,setCursors] = useState<string[]>([]);
  const [copyNotice,setCopyNotice] = useState('');
  const query = new URLSearchParams();
  if (filter.key_id) query.set('key_id',filter.key_id);
  if (filter.request_id) query.set('request_id',filter.request_id);
  if (filter.status) query.set('status',filter.status);
  if (filter.from) query.set('fromDay',filter.from);
  if (filter.to) query.set('throughDay',filter.to);
  if (filter.from || filter.to) query.set('tz',tz);
  if (cursors.length) query.set('cursor',cursors.at(-1)!);
  const keys = useData<{items:KeyRow[]}>('/api/keys');
  const records = useData<UsagePage>('/api/usage?'+query,1200);
  useEffect(() => {
    const initial = new URLSearchParams(location.search);
    setRequestInput(initial.get('request_id') || '');
    setFilter(f => ({...f,key_id:initial.get('key_id')||'',request_id:initial.get('request_id')||'',status:initial.get('status')||''}));
  },[]);
  function update(name:keyof typeof filter,value:string) {
    setFilter(f => ({...f,[name]:value}));setCursors([]);
  }
  return <><Heading title="使用记录" description="按密钥和日期核对单次请求的预占、费用及 Token。" />
    <form className="request-search filters" onSubmit={e=>{
      e.preventDefault();
      setFilter({key_id:'',request_id:requestInput.trim(),status:'',from:'',to:''});
      setCursors([]); setCopyNotice('');
    }}>
      <label>按 OpenToken 请求 ID 查询<input type="search" value={requestInput} required
        placeholder="粘贴响应中的请求 ID" pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
        title="请输入完整的 OpenToken 请求 ID（UUID）" onChange={e=>setRequestInput(e.target.value.trim())} /></label>
      <button className="primary">查询请求</button>
    </form>
    <div className="filters">
      <label>密钥<select value={filter.key_id} onChange={e => update('key_id',e.target.value)}><option value="">全部密钥</option>
        {keys.data?.items.map(k => <option key={k.id} value={k.id}>{k.name} · {k.prefix}…</option>)}</select></label>
      <label>状态<select value={filter.status} onChange={e => update('status',e.target.value)}><option value="">全部状态</option>
        {['dispatched','review','settled','released'].map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></label>
      <label>开始日期（{tz}）<input type="date" value={filter.from} max={filter.to||undefined} onChange={e => update('from',e.target.value)} /></label>
      <label>结束日期<input type="date" value={filter.to} min={filter.from||undefined} onChange={e => update('to',e.target.value)} /></label>
      <button onClick={records.refresh}>刷新</button>
      <button onClick={() => {setFilter({key_id:'',request_id:'',status:'',from:'',to:''});setRequestInput('');setCopyNotice('');setCursors([]);}}>清空筛选</button>
    </div>
    <ErrorNote error={records.error || keys.error} />
    {records.data ? <section className="panel"><h2>请求明细</h2>
      {filter.request_id && <p className="muted">当前查询 <code>{filter.request_id}</code></p>}
      {records.data.items.length ? records.data.items.map(row => <details key={row.id} open={filter.request_id ? true : undefined} className="request-row">
        <summary><span>{new Date(row.createdAt).toLocaleString('zh-CN',{timeZone:tz})}</span><code>{row.model} · {row.prefix}…</code>
          <span className="badge" data-status={row.status}>{statusLabel(row.status)}</span>
          <strong data-testid="request-fee">{row.status==='released'?'无扣费':row.status==='settled'?money(row.chargedMicros):
            row.status==='review'?'待确认':'结算中'}</strong>
        </summary>
        <p>请求编号 <code>{row.id}</code></p>
        {row.upstreamRequestId && <p>上游请求编号 <code>{row.upstreamRequestId}</code></p>}
        <button onClick={async () => {
          try {await navigator.clipboard.writeText(row.id);setCopyNotice('已复制请求编号。');}
          catch {setCopyNotice('复制失败，可选中编号后手动复制。');}
        }}>复制请求编号</button>
        <dl className="metrics settlement">
          <div><dt>请求预占</dt><dd>{money(row.reservedMicros)}</dd></div>
          <div><dt>实际扣费</dt><dd>{row.status==='released' ? money('0') : money(row.chargedMicros)}</dd></div>
          <div><dt>释放预占</dt><dd>{money(row.releasedMicros)}</dd></div>
        </dl>
        {row.status==='settled' && <><p>标准费用 {money(row.standardMicros)} · 输入 {row.inputTokens} · 缓存读取 {row.cachedTokens} · 输出 {row.outputTokens}</p>
          {row.ledgerDeltaMicros!==null && <p>账本已入账，扣除 {money(String(-BigInt(row.ledgerDeltaMicros)))}</p>}</>}
        {row.status==='review' && <p className="review-note">费用待核对。预占额度暂时保留，核对完成后会显示最终扣费和释放金额。</p>}
        {(row.status==='reserved' || row.status==='dispatched') && <p className="muted">请求处理中，结算后会显示实际扣费和释放金额。</p>}
        {row.status==='released' && <p>本次请求已结束，预占额度已全部释放。</p>}
        <p className="muted">最近更新 {new Date(row.updatedAt).toLocaleString('zh-CN',{timeZone:tz})}</p>
      </details>) : <p>{filter.request_id ? '没有找到这笔请求。请核对当前账号和响应中的 OpenToken 请求 ID。' :
        <>没有符合条件的请求。可清空筛选，或按<a href="/keys#connection-guide">接入示例</a>发起首次调用。</>}</p>}
      <p role="status">{copyNotice}</p>
      <div className="actions"><button disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0,-1))}>上一页</button>
        <button disabled={!records.data.nextCursor} onClick={() => setCursors([...cursors,records.data!.nextCursor!])}>下一页</button></div>
    </section> : <Placeholder error={records.error} />}
  </>;
}

type CheckoutKind = 'credit'|'subscription';
type TestOrder = {
  id:string;kind:CheckoutKind;amountCents:number;state:string;subscriptionStatus:string|null;periodEnd:string|null;createdAt:string;
  refundedCents:number;refundPending:boolean;
};
type TestInvoice = {id:string;amountCents:number;reason:string;periodStart:string;periodEnd:string};
const centsLabel=(cents:number)=>money(String(BigInt(cents)*10000n));
const paymentStatus:Record<string,string> = {
  open:'待支付',paid:'已确认',expired:'已过期',active:'生效中',trialing:'试用中',
  past_due:'续费异常',unpaid:'未支付',incomplete:'待激活',incomplete_expired:'未激活',
  canceled:'已取消',paused:'已暂停',
};

function TestBilling({refreshWallet,tz}:{refreshWallet:()=>void;tz:string}) {
  const [busy,setBusy] = useState(false);
  const [feedback,setFeedback] = useState('');
  const [returned,setReturned] = useState<string|null>(null);
  const nonces = useRef<Partial<Record<string,string>>>({});
  useEffect(() => { setReturned(new URLSearchParams(location.search).get('checkout')); },[]);
  const {data,error,refresh} = useData<{enabled:boolean;orders:TestOrder[];canManage:boolean;invoices:TestInvoice[];
    rechargeOptions:number[];limits:{rpm:number;activeKeys:number}}>(
    '/api/billing',returned==='success' ? 8000 : 0);

  function checkoutNonce(kind:string) {
    let nonce = nonces.current[kind] ?? crypto.randomUUID();
    try {
      const key = 'opentoken:stripe-test:'+kind;
      const saved = sessionStorage.getItem(key);
      if (saved && /^[a-f0-9-]{36}$/.test(saved)) nonce = saved;
      sessionStorage.setItem(key,nonce);
    } catch { /* The request can still be retried in this page. */ }
    nonces.current[kind] = nonce;
    return nonce;
  }

  async function open(kind:CheckoutKind|'portal',amountCents?:number) {
    if (busy) return;
    setBusy(true); setFeedback('');
    const choice=amountCents===undefined || amountCents===500 ? kind : 'credit:'+amountCents;
    try {
      const result = kind==='portal' ? await api<{url:string}>('/api/billing/portal',{method:'POST'}) :
        await api<{url:string}>('/api/billing/checkout',{method:'POST',
          body:JSON.stringify({kind,nonce:checkoutNonce(choice),amountCents}),signal:AbortSignal.timeout(22000)});
      location.assign(result.url);
    } catch (error) {
      if (kind!=='portal' && error instanceof ApiError && error.status===409) {
        delete nonces.current[choice];
        try { sessionStorage.removeItem('opentoken:stripe-test:'+choice); } catch {}
      }
      setFeedback(error instanceof ApiError ? error.message : '连接 Stripe 超时。可重试同一结账请求。');
      setBusy(false);
    }
  }

  if (!data?.enabled) return null;
  return <section className="panel" aria-labelledby="test-billing-title">
    <h2 id="test-billing-title">Stripe 测试支付</h2>
    <div className="actions">
      {data.rechargeOptions.map(cents=><button key={cents} disabled={busy} onClick={()=>void open('credit',cents)}>
        测试充值 {centsLabel(cents)}
      </button>)}
      <button disabled={busy} onClick={()=>void open('subscription')}>测试 Pro · $10/月</button>
      {data.canManage && <button disabled={busy} onClick={()=>void open('portal')}>管理测试订阅</button>}
      <button onClick={()=>{refresh();refreshWallet();}}>刷新订单和余额</button>
    </div>
    <p>当前套餐：{data.limits.rpm===60?'Pro':'基础版'}，每分钟 {data.limits.rpm} 次调用，可用密钥 {data.limits.activeKeys} 把。</p>
    {returned==='success' && <p role="status">已从 Stripe 返回。到账以订单和钱包流水为准。</p>}
    {returned==='cancel' && <p role="status">结账尚未完成。可重开同一笔结账继续。</p>}
    <ErrorNote error={feedback || error} />
    {data.orders.length ? <div className="table-wrap"><table>
      <thead><tr><th>订单</th><th>金额</th><th>支付状态</th><th>订阅状态</th></tr></thead>
      <tbody>{data.orders.map(order=><tr key={order.id}>
        <td>{order.kind==='credit'?'测试充值':'测试订阅'}<br/><small>{new Date(order.createdAt).toLocaleString('zh-CN',{timeZone:tz})}</small></td>
        <td>{money(String(BigInt(order.amountCents)*10000n))}</td>
        <td>{paymentStatus[order.state] ?? '待确认'}
          {order.refundedCents>0 && <><br/><small>已退款 {centsLabel(order.refundedCents)}</small></>}
          {order.refundPending && <><br/><small>退款处理中</small></>}
        </td>
        <td>{order.subscriptionStatus ? paymentStatus[order.subscriptionStatus] ?? '待确认' : '—'}
          {order.periodEnd && <><br/><small>账期截止 {new Date(order.periodEnd).toLocaleDateString('zh-CN',{timeZone:tz})}</small></>}</td>
      </tr>)}</tbody>
    </table></div> : <p className="muted">还没有测试订单。</p>}
    {data.invoices.length>0 && <div className="table-wrap"><table>
      <thead><tr><th>订阅账单</th><th>金额</th><th>已付账期</th></tr></thead>
      <tbody>{data.invoices.map(invoice=><tr key={invoice.id}>
        <td>{invoice.reason==='subscription_cycle'?'续费':'开通'}</td>
        <td>{centsLabel(invoice.amountCents)}</td>
        <td>{new Date(invoice.periodStart).toLocaleDateString('zh-CN',{timeZone:tz})} 至 {new Date(invoice.periodEnd).toLocaleDateString('zh-CN',{timeZone:tz})}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

export function Redeem({tz}:{tz:string}) {
  const wallet = useData<CreditReceipt['wallet']>('/api/dashboard');
  const field = useRef<HTMLInputElement>(null);
  const [code,setCode] = useState('');
  const [receipt,setReceipt] = useState<CreditReceipt>();
  const [feedback,setFeedback] = useState('');
  const [busy,setBusy] = useState(false);
  const [kind,setKind] = useState('');
  const [cursors,setCursors] = useState<string[]>([]);
  const query = new URLSearchParams();
  if (kind) query.set('kind',kind);
  if (cursors.length) query.set('cursor',cursors.at(-1)!);
  const history = useData<WalletPage>('/api/wallet/entries?'+query);
  const balances = wallet.data;

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true); setFeedback(''); setReceipt(undefined);
    try {
      const result = await api<CreditReceipt>('/api/redeem',{
        method:'POST',body:JSON.stringify({code}),signal:AbortSignal.timeout(15000),
      });
      setReceipt(result); setCode(''); setKind(''); setCursors([]);
      wallet.replaceAndRefresh(result.wallet); history.refresh();
    } catch (error) {
      setFeedback(error instanceof ApiError && error.status<500 ? error.message :
        '提交结果暂未确认。可以用同一码重试，已到账的额度只会记一次。');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { if (feedback) field.current?.focus(); },[feedback]);

  return <><Heading title="兑换与流水" description="兑换试点额度，核对到账和已结算扣费。" />
    <section className="panel" aria-labelledby="redeem-balance"><h2 id="redeem-balance">余额</h2>
      {balances ? <dl className="metrics">
        <div><dt>可用余额</dt><dd>{money(balances.availableMicros)}</dd></div>
        <div><dt>账面余额</dt><dd>{money(balances.balanceMicros)}</dd></div>
        <div><dt>预占金额</dt><dd>{money(balances.heldMicros)}</dd></div>
        {balances.refundHeldMicros && balances.refundHeldMicros!=='0' && <div><dt>退款冻结</dt><dd>{money(balances.refundHeldMicros)}</dd></div>}
      </dl> : <p className="muted">{wallet.error ? '暂时无法读取余额。' : '正在读取余额…'}</p>}
      <ErrorNote error={wallet.error} />
      {wallet.error && <button onClick={wallet.refresh}>刷新余额</button>}
    </section>
    <TestBilling tz={tz} refreshWallet={()=>{wallet.refresh();history.refresh();}} />
    <section className="panel" aria-labelledby="redeem-title"><h2 id="redeem-title">兑换额度</h2>
      <form onSubmit={submit} action="/api/redeem" method="post" aria-busy={busy}>
        <div className="filters">
          <label>兑换码<input ref={field} name="code" type="password" value={code}
            autoComplete="off" autoCapitalize="none" spellCheck={false} required readOnly={busy} maxLength={128}
            aria-invalid={feedback ? true : undefined} aria-describedby={feedback ? 'redeem-feedback' : undefined}
            onChange={e=>{setCode(e.target.value);setFeedback('');}} /></label>
          <button className="primary" disabled={busy || !code.trim()}>{busy ? '正在兑换…' : '兑换'}</button>
        </div>
      </form>
      {feedback && <p className="error" id="redeem-feedback" role="alert">{feedback}</p>}
      <div role="status">{receipt && <>
        <p><strong>{receipt.replayed ? '该额度已到账' : '兑换成功'} · {money(receipt.receipt.amountMicros)}</strong></p>
        <p>收据编号 <code>{receipt.receipt.id}</code></p>
        <p className="muted">到账时间 {new Date(receipt.receipt.createdAt).toLocaleString('zh-CN',{timeZone:tz})}</p>
      </>}</div>
    </section>
    <section className="panel" aria-labelledby="wallet-history"><h2 id="wallet-history">钱包流水</h2>
      <div className="filters"><label>流水类型<select value={kind} onChange={e=>{setKind(e.target.value);setCursors([]);}}>
        <option value="">全部流水</option>{Object.entries(ledgerKind).map(([value,label])=>
          <option key={value} value={value}>{label}</option>)}
      </select></label><button onClick={()=>{history.refresh();wallet.refresh();}}>刷新余额与流水</button></div>
      <ErrorNote error={history.error} />
      {history.data ? history.data.items.length ? <>
        <div className="table-wrap"><table className="phone-records" aria-label="钱包流水"><thead><tr><th scope="col">时间</th><th scope="col">类型</th><th scope="col">金额</th><th scope="col">编号</th></tr></thead>
          <tbody>{history.data.items.map(item=><tr key={item.id}>
            <td data-label="时间">{new Date(item.createdAt).toLocaleString('zh-CN',{timeZone:tz})}</td>
            <td data-label="类型">{ledgerKind[item.kind]}</td>
            <td data-label="金额">{BigInt(item.deltaMicros)>0n ? '+'+money(item.deltaMicros) : '−'+money(String(-BigInt(item.deltaMicros)))}</td>
            <td data-label="编号" className="record-wide">{item.requestId ? <a href={'/usage?request_id='+item.requestId}><code>{item.requestId}</code></a> : <code>{item.id}</code>}</td>
          </tr>)}</tbody></table></div>
        <div className="actions"><button disabled={!cursors.length} onClick={()=>setCursors(cursors.slice(0,-1))}>上一页</button>
          <button disabled={!history.data.nextCursor} onClick={()=>setCursors([...cursors,history.data!.nextCursor!])}>下一页</button></div>
      </> : <p>{kind ? '没有符合筛选条件的流水。' : '还没有钱包流水。兑换额度或完成模型调用后会在这里显示。'}</p>
      : <p className="muted">{history.error ? '暂时无法读取流水。' : '正在读取流水…'}</p>}
    </section>
  </>;
}
