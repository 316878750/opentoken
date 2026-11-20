'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

type Rate = {groupId:string;groupName:string;model:string;inputMicros:string;cacheMicros:string;outputMicros:string;multiplierBps:number;upstream:'mock'|'openai'|'compatible';streaming:boolean};
type KeyRow = {id:string;name:string;prefix:string;status:string;groupName:string;rpm:number;capMicros:string|null};
type RequestRow = {id:string;prefix:string;model:string;status:string;reservedMicros:string;releasedMicros:string|null;standardMicros:string|null;
  chargedMicros:string|null;ledgerDeltaMicros:string|null;inputTokens:number|null;cachedTokens:number|null;outputTokens:number|null;createdAt:string;updatedAt:string;upstreamRequestId:string|null};
type Wallet = {balanceMicros:string;heldMicros:string;availableMicros:string;asOf:string;activeKeys:number;
  requests:number;todayRequests:number;tokens:string;todayTokens:string;chargedMicros:string;standardMicros:string;
  todayChargedMicros:string;reviewCount:number};
type UsagePage = {items:RequestRow[];nextCursor:string|null};
type WalletEntry = {id:string;kind:'redemption'|'usage';deltaMicros:string;requestId:string|null;createdAt:string};
type WalletPage = {items:WalletEntry[];nextCursor:string|null};
type CreditReceipt = {receipt:{id:string;amountMicros:string;createdAt:string};replayed:boolean;
  wallet:Pick<Wallet,'balanceMicros'|'heldMicros'|'availableMicros'>};

class ApiError extends Error {
  constructor(public status:number, message:string, public requestId?:string) { super(message); }
}

async function api<T>(url:string, options:RequestInit = {}): Promise<T> {
  const response = await fetch(url,{ ...options,cache:'no-store',headers:{
    ...options.headers,...(options.body ? {'Content-Type':'application/json'} : {}),
  } });
  const data = await response.json();
  if (!response.ok) {
    if (response.status===401 && url.startsWith('/api/') && url!=='/api/session/login') {
      location.replace('/login?redirect='+location.pathname);
    }
    throw new ApiError(response.status,data.error?.message || '暂时无法完成操作。',data.error?.request_id);
  }
  return data;
}

function useData<T>(url:string, interval = 0) {
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

function money(micros: string | null) {
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

export function Login() {
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
      location.replace(destination && ['/dashboard','/pricing','/keys','/usage','/redeem'].includes(destination) ? destination : '/dashboard');
    } catch (error) {
      setError(error instanceof ApiError ? error.message : '登录请求暂时无法完成。');
      setBusy(false);
    }
  }
  return <main className="login"><form className="panel" action="/api/session/login" method="post" onSubmit={submit}>
    <span className="badge">OpenToken</span><Heading title="登录控制台" description="使用受邀账号查看模型接入和请求费用。" />
    <label>邮箱<input type="email" name="email" autoComplete="username" required /></label>
    <label>密码<input type="password" name="password" autoComplete="current-password" required /></label>
    <ErrorNote error={error} /><button className="primary" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
  </form></main>;
}

export function Dashboard() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const {data,error,refresh} = useData<Wallet>('/api/dashboard?tz='+encodeURIComponent(tz),1200);
  return <><Heading title="概览" description="核对可用额度、预占和已结算费用。" />
    <div className="actions"><a className="action primary" href="/keys">管理密钥</a><a className="action" href="/usage">查看使用记录</a>
      <a className="action" href="/redeem">兑换额度</a>
      <button type="button" onClick={refresh}>刷新数据</button></div>
    <ErrorNote error={error} />
    {data ? <><section className="panel" aria-labelledby="wallet-title"><h2 id="wallet-title">余额</h2>
      <dl className="metrics">
        <div><dt>可用余额</dt><dd data-testid="available">{money(data.availableMicros)}</dd></div>
        <div><dt>账面余额</dt><dd data-testid="balance">{money(data.balanceMicros)}</dd></div>
        <div><dt>预占金额</dt><dd data-testid="held">{money(data.heldMicros)}</dd></div>
      </dl>
      <p className="muted">{data.heldMicros!=='0' ? '预占额度暂留给处理中或待核对的请求。' : '当前没有预占额度。'}</p>
      <small className="muted">更新于 {new Date(data.asOf).toLocaleTimeString('zh-CN')}</small>
      {data.reviewCount>0 && <p><a href="/usage?status=review">查看 {data.reviewCount} 笔待核对请求</a></p>}
    </section>
    <section className="panel"><h2>用量与已结算费用</h2>
      <dl className="metrics">
        <div><dt>今日 / 累计请求</dt><dd>{data.todayRequests} / {data.requests}</dd></div>
        <div><dt>今日 / 累计计费 Token</dt><dd>{data.todayTokens} / {data.tokens}</dd></div>
        <div><dt>启用密钥</dt><dd>{data.activeKeys}</dd></div>
        <div><dt>今日实际扣费</dt><dd>{money(data.todayChargedMicros)}</dd></div>
        <div><dt>累计实际扣费</dt><dd>{money(data.chargedMicros)}</dd></div>
        <div><dt>累计标准费用</dt><dd>{money(data.standardMicros)}</dd></div>
      </dl>
    </section></> : <Placeholder error={error} />}
  </>;
}

export function Pricing() {
  const {data,error,refresh} = useData<{rates:Rate[]}>('/api/catalog');
  return <><Heading title="模型价格" description="当前分组费率。单价按每百万 Token 计。" />
    <ErrorNote error={error} />{error && <button onClick={refresh}>重试</button>}
    {data ? <section className="panel table-wrap"><table><thead><tr>
      <th>模型</th><th>分组</th><th>输入</th><th>缓存读取</th><th>输出</th><th>倍率</th><th>请求方式</th>
    </tr></thead><tbody>{data.rates.map(r => <tr key={r.groupId+r.model}><td><code>{r.model}</code> · {r.upstream==='mock'?'模拟':r.upstream==='compatible'?'兼容上游':'OpenAI'}</td><td>{r.groupName}</td>
      <td>{money(r.inputMicros)}</td><td>{money(r.cacheMicros)}</td><td>{money(r.outputMicros)}</td><td>{r.multiplierBps/10000}×</td>
      <td>{r.streaming?'流式 / 非流式':'非流式'}</td></tr>)}</tbody></table></section>
      : <Placeholder error={error} />}
  </>;
}

type NewKey = {id:string;secret:string;name:string;groupId:string;groupName:string};
type Step = 'form' | 'secret' | 'confirm';

export function Keys() {
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
  const groups = [...new Map(catalog.data?.rates.map(rate => [rate.groupId,rate])).values()];
  const demoAllowed = catalog.data?.rates.some(rate=>rate.groupId===created?.groupId && rate.model==='mock-text');
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
      <button ref={open} className="primary" disabled={!catalog.data?.rates.length}
        onClick={() => { clear(); dialog.current?.showModal(); nameField.current?.focus(); }}>创建密钥</button>
      <button onClick={() => {keys.refresh();catalog.refresh();}}>刷新列表</button>
    </div>
    <ErrorNote error={keys.error || catalog.error || pageError} />
    <section className="panel"><h2>接入地址</h2><p><code>{endpoint}</code></p>
      <button onClick={async () => {try { await navigator.clipboard.writeText(endpoint); setPageError(''); setNotice('已复制接入地址。'); }
        catch {setPageError('复制失败，可选中地址后手动复制。');}}}>复制接入地址</button>
      <p className="muted">密钥只能使用所属分组的模型。可用模型及流式支持见 <a href="/pricing">模型价格</a>。</p>
      {!created && notice && <p role="status">{notice}</p>}
    </section>
    {keys.data ? <section className="panel table-wrap"><h2>密钥列表</h2>
      {keys.data.items.length ? <table><thead><tr><th>名称与前缀</th><th>分组</th><th>状态</th><th>额度 / RPM</th><th>操作</th></tr></thead>
        <tbody>{keys.data.items.map(row => <tr key={row.id}><td>{row.name}<br/><code>{row.prefix}…</code></td><td>{row.groupName}</td>
          <td><span className="badge">{statusLabel(row.status)}</span></td><td>{row.capMicros===null?'不限':money(row.capMicros)} / {row.rpm}</td>
          <td>{row.status!=='revoked' && <div className="actions"><button onClick={() => void changeKey(row)}>{row.status==='active'?'停用':'恢复'}</button>
            <button onClick={e => { revokeTrigger.current=e.currentTarget; setRevoke(row); revokeDialog.current?.showModal(); }}>撤销</button></div>}</td></tr>)}</tbody></table>
        : <p>还没有密钥。创建一把密钥即可发起第一次调用。</p>}</section> : <Placeholder error={keys.error} />}
    <dialog ref={dialog} aria-labelledby="key-title" onCancel={event => {event.preventDefault();close();}}
      onClose={() => {clear();open.current?.focus();}}>
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
        <div className="actions"><button className="primary" disabled={!saved} onClick={dismiss}>完成</button>
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

export function Usage() {
  const [filter,setFilter] = useState({key_id:'',request_id:'',status:'',from:'',to:''});
  const [cursors,setCursors] = useState<string[]>([]);
  const [copyNotice,setCopyNotice] = useState('');
  const query = new URLSearchParams();
  if (filter.key_id) query.set('key_id',filter.key_id);
  if (filter.request_id) query.set('request_id',filter.request_id);
  if (filter.status) query.set('status',filter.status);
  if (filter.from) query.set('from',new Date(filter.from+'T00:00:00').toISOString());
  if (filter.to) {
    const end = new Date(filter.to+'T00:00:00');
    end.setDate(end.getDate()+1); query.set('to',end.toISOString());
  }
  if (cursors.length) query.set('cursor',cursors.at(-1)!);
  const keys = useData<{items:KeyRow[]}>('/api/keys');
  const records = useData<UsagePage>('/api/usage?'+query,1200);
  useEffect(() => {
    const initial = new URLSearchParams(location.search);
    setFilter(f => ({...f,key_id:initial.get('key_id')||'',request_id:initial.get('request_id')||'',status:initial.get('status')||''}));
  },[]);
  function update(name:keyof typeof filter,value:string) {
    setFilter(f => ({...f,[name]:value}));setCursors([]);
  }
  return <><Heading title="使用记录" description="按密钥和日期核对单次请求的预占、费用及 Token。" />
    {filter.request_id && <p className="muted">已定位请求 <code>{filter.request_id}</code></p>}
    <div className="filters">
      <label>密钥<select value={filter.key_id} onChange={e => update('key_id',e.target.value)}><option value="">全部密钥</option>
        {keys.data?.items.map(k => <option key={k.id} value={k.id}>{k.name} · {k.prefix}…</option>)}</select></label>
      <label>状态<select value={filter.status} onChange={e => update('status',e.target.value)}><option value="">全部状态</option>
        {['dispatched','review','settled','released'].map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></label>
      <label>开始日期<input type="date" value={filter.from} max={filter.to||undefined} onChange={e => update('from',e.target.value)} /></label>
      <label>结束日期<input type="date" value={filter.to} min={filter.from||undefined} onChange={e => update('to',e.target.value)} /></label>
      <button onClick={records.refresh}>刷新</button>
      <button onClick={() => {setFilter({key_id:'',request_id:'',status:'',from:'',to:''});setCursors([]);}}>清空筛选</button>
    </div>
    <ErrorNote error={records.error || keys.error} />
    {records.data ? <section className="panel"><h2>请求明细</h2>
      {records.data.items.length ? records.data.items.map(row => <details key={row.id} className="request-row">
        <summary><span>{new Date(row.createdAt).toLocaleString('zh-CN')}</span><code>{row.model} · {row.prefix}…</code>
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
        <p>{row.status==='settled' || row.status==='released' ? '原预占' : '预占'} {money(row.reservedMicros)}</p>
        {row.releasedMicros!==null && <p>释放预占 {money(row.releasedMicros)}</p>}
        {row.status==='settled' && <><p>标准费用 {money(row.standardMicros)} · 输入 {row.inputTokens} · 缓存读取 {row.cachedTokens} · 输出 {row.outputTokens}</p>
          {row.ledgerDeltaMicros!==null && <p>账本已入账，扣除 {money(String(-BigInt(row.ledgerDeltaMicros)))}</p>}</>}
        {row.status==='review' && <p className="muted">这次请求的费用仍在核对，预留额度会在核对完成后更新。</p>}
        <p className="muted">最近更新 {new Date(row.updatedAt).toLocaleString('zh-CN')}</p>
      </details>) : <p>没有符合条件的请求。可清空筛选，或在创建密钥后运行模拟调用。</p>}
      <p role="status">{copyNotice}</p>
      <div className="actions"><button disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0,-1))}>上一页</button>
        <button disabled={!records.data.nextCursor} onClick={() => setCursors([...cursors,records.data!.nextCursor!])}>下一页</button></div>
    </section> : <Placeholder error={records.error} />}
  </>;
}

export function Redeem() {
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
      </dl> : <p className="muted">{wallet.error ? '暂时无法读取余额。' : '正在读取余额…'}</p>}
      <ErrorNote error={wallet.error} />
      {wallet.error && <button onClick={wallet.refresh}>刷新余额</button>}
    </section>
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
        <p className="muted">到账时间 {new Date(receipt.receipt.createdAt).toLocaleString('zh-CN')}</p>
      </>}</div>
    </section>
    <section className="panel" aria-labelledby="wallet-history"><h2 id="wallet-history">钱包流水</h2>
      <div className="filters"><label>流水类型<select value={kind} onChange={e=>{setKind(e.target.value);setCursors([]);}}>
        <option value="">全部流水</option><option value="redemption">额度到账</option><option value="usage">模型扣费</option>
      </select></label><button onClick={()=>{history.refresh();wallet.refresh();}}>刷新余额与流水</button></div>
      <ErrorNote error={history.error} />
      {history.data ? history.data.items.length ? <>
        <div className="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>金额</th><th>编号</th></tr></thead>
          <tbody>{history.data.items.map(item=><tr key={item.id}>
            <td>{new Date(item.createdAt).toLocaleString('zh-CN')}</td>
            <td>{item.kind==='redemption' ? '额度到账' : '模型扣费'}</td>
            <td>{item.kind==='redemption' ? '+'+money(item.deltaMicros) : '−'+money(String(-BigInt(item.deltaMicros)))}</td>
            <td>{item.requestId ? <a href={'/usage?request_id='+item.requestId}><code>{item.requestId}</code></a> : <code>{item.id}</code>}</td>
          </tr>)}</tbody></table></div>
        <div className="actions"><button disabled={!cursors.length} onClick={()=>setCursors(cursors.slice(0,-1))}>上一页</button>
          <button disabled={!history.data.nextCursor} onClick={()=>setCursors([...cursors,history.data!.nextCursor!])}>下一页</button></div>
      </> : <p>{kind ? '没有符合筛选条件的流水。' : '还没有钱包流水。兑换额度或完成模型调用后会在这里显示。'}</p>
      : <p className="muted">{history.error ? '暂时无法读取流水。' : '正在读取流水…'}</p>}
    </section>
  </>;
}
