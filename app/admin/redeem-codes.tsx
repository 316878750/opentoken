'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AdminRedeemIssue, AdminRedeemPage, RedeemCodeStatus } from '@/lib/admin-redeem';
import { api, ApiError, money, useData } from '../console';
import { ActionFeedback, ListPager } from './list-controls';

const endpoint = '/api/admin/redeem-codes';
const statuses: Record<RedeemCodeStatus,string> = {active:'可兑换',expired:'已过期',voided:'已作废',redeemed:'已核销'};
type IssueInput = {amountUsd:string;expiresAt:string;operationId:string};

export function RedeemCodes({actorId,canWrite,timeZone}:{timeZone:string;actorId:string;canWrite:boolean}) {
  const [filter,setFilter] = useState('');
  const [cursors,setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const [pending,setPending] = useState<IssueInput>();
  const [restored,setRestored] = useState(false);
  const [secret,setSecret] = useState('');
  const [voiding,setVoiding] = useState('');
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('');
  const [error,setError] = useState('');
  const secretDialog = useRef<HTMLDialogElement>(null);
  const secretField = useRef<HTMLInputElement>(null);
  const issuing = useRef<AbortController>(null);
  const form = useRef<HTMLFormElement>(null);
  const storageKey = 'opentoken.admin.redeem.pending.'+actorId;
  const query = new URLSearchParams();
  if (filter) query.set('status',filter);
  if (cursor) query.set('cursor',cursor);
  const codes = useData<AdminRedeemPage>(endpoint+'?'+query);
  const page = codes.error ? undefined : codes.data;

  useEffect(() => {
    if (canWrite) {
      try {
        const stored = sessionStorage.getItem(storageKey);
        if (stored) {
          const draft = JSON.parse(stored);
          if (typeof draft?.amountUsd==='string' && typeof draft.expiresAt==='string' && typeof draft.operationId==='string') {
            setPending(draft);
          }
        }
      } catch { /* A restricted browser can still retry an in-memory application. */ }
    }
    setRestored(true);
  },[canWrite,storageKey]);

  useEffect(() => {
    const clear = () => {
      issuing.current?.abort();
      if (secretField.current) secretField.current.value = '';
      secretDialog.current?.close();
      setSecret('');
      setBusy(false);
    };
    window.addEventListener('pagehide',clear);
    return () => { window.removeEventListener('pagehide',clear); issuing.current?.abort(); };
  },[]);

  useEffect(() => { if (secret) secretDialog.current?.showModal(); },[secret]);

  function clearPending() {
    setPending(undefined);
    try { sessionStorage.removeItem(storageKey); } catch { /* Storage is optional. */ }
  }

  async function issue(input:IssueInput) {
    const controller = new AbortController();
    issuing.current = controller;
    setPending(input);
    try { sessionStorage.setItem(storageKey,JSON.stringify(input)); } catch { /* Keep the application in memory. */ }
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<AdminRedeemIssue>(endpoint,{method:'POST',body:JSON.stringify(input),
        signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])});
      if (controller.signal.aborted) return;
      clearPending();
      form.current?.reset();
      setFilter(''); setCursors([]); codes.refresh();
      if (result.code) setSecret(result.code);
      else setMessage(`签发记录 ${result.id} 已存在，当前状态为${statuses[result.status]}。`);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status<500) {
        if (failure.status!==401 && failure.status!==403) clearPending();
        setError(failure.message);
      } else {
        setError('签发结果未确认。请按同一申请编号核对。');
      }
    } finally {
      if (issuing.current===controller) { issuing.current = null; setBusy(false); }
    }
  }

  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restored || busy || pending) return;
    const fields = new FormData(event.currentTarget);
    const expiry = new Date(String(fields.get('expiresAt')));
    if (!Number.isFinite(expiry.getTime())) { setError('请选择有效期。'); return; }
    void issue({amountUsd:String(fields.get('amountUsd')).trim(),expiresAt:expiry.toISOString(),operationId:crypto.randomUUID()});
  }

  async function confirmVoid() {
    setBusy(true); setError(''); setMessage('');
    try {
      await api(endpoint+'/'+voiding+'/void',{method:'POST',signal:AbortSignal.timeout(12000)});
      setVoiding(''); setMessage('兑换码已作废。');
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : '作废结果未确认，请刷新列表核对。');
    } finally { setBusy(false); codes.refresh(); }
  }

  return <section className="panel" aria-labelledby="redeem-codes-title">
    <h1 id="redeem-codes-title">兑换码管理</h1>
    {canWrite && <form ref={form} className="filters" onSubmit={submit}>
      <label>面额（美元）<input name="amountUsd" required inputMode="decimal" maxLength={20} disabled={busy || !!pending}/></label>
      <label>有效期（本地时间）<input type="datetime-local" name="expiresAt" required disabled={busy || !!pending}/></label>
      {pending
        ? <button type="button" disabled={busy} onClick={()=>void issue(pending)}>核对签发结果</button>
        : <button className="primary" disabled={!restored || busy}>签发兑换码</button>}
    </form>}
    <ActionFeedback busy={busy} error={error} message={message}/>
    {voiding && <div role="group" aria-label="确认作废">
      <p>作废兑换码 {voiding} 后，持有人将无法兑换。</p>
      <button disabled={busy} onClick={()=>void confirmVoid()}>确认作废</button>{' '}
      <button disabled={busy} onClick={()=>setVoiding('')}>取消</button>
    </div>}
    <div className="filters">
      <label>状态<select value={filter} disabled={busy} onChange={event=>{setFilter(event.target.value);setCursors([]);setVoiding('');}}>
        <option value="">全部</option>
        {Object.entries(statuses).map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>
      <button disabled={busy || !filter} onClick={()=>{setFilter('');setCursors([]);setVoiding('');}}>重置筛选</button>
      <button disabled={busy} onClick={codes.refresh}>刷新</button>
    </div>
    {codes.error && <p className="error" role="alert">{codes.error}</p>}
    {!codes.error && !page && <p role="status">正在读取兑换码…</p>}
    {page && page.items.length===0 && <p className="list-empty">{filter?'没有符合条件的兑换码，可重置筛选。':'暂无兑换码记录。'}</p>}
    {page && page.items.length>0 && <div className="table-wrap">
      <table aria-label="兑换码记录">
        <thead><tr><th scope="col">记录编号</th><th scope="col">面额</th><th scope="col">状态</th>
          <th scope="col">有效期</th><th scope="col">核销收据</th>{canWrite && <th scope="col">签发账号</th>}
          {canWrite && <th scope="col">操作</th>}</tr></thead>
        <tbody>{page.items.map(row=><tr key={row.id}>
          <td>{row.id}</td><td>{money(row.amountMicros)}</td><td>{statuses[row.status]}</td>
          <td><time dateTime={row.expiresAt}>{new Date(row.expiresAt).toLocaleString('zh-CN',{timeZone,timeZoneName:'short'})}</time></td>
          <td>{row.receiptId??'—'}</td>{canWrite && <td>{row.issuedBy??'—'}</td>}
          {canWrite && <td>{row.status==='active' && <button disabled={busy || !!voiding}
            onClick={()=>{setVoiding(row.id);setError('');setMessage('');}}>作废</button>}</td>}
        </tr>)}</tbody>
      </table>
    </div>}
    <ListPager page={cursors.length+1} count={page?.items.length} disabled={busy}
      onPrevious={cursor?()=>{setVoiding('');setCursors(cursors.slice(0,-1));}:undefined}
      onNext={page?.nextCursor?()=>{setVoiding('');setCursors([...cursors,page.nextCursor!]);}:undefined}/>
    {cursors.length>1 && <button disabled={busy} onClick={()=>{setVoiding('');setCursors([]);}}>回到第一页</button>}
    <dialog ref={secretDialog} aria-labelledby="new-redeem-code-title" onClose={()=>setSecret('')}>
      {secret && <><h3 id="new-redeem-code-title">兑换码已签发</h3><p>明文只显示这一次。关闭前请复制保存。</p>
        <label>兑换码<input ref={secretField} value={secret} readOnly onFocus={event=>event.currentTarget.select()}/></label>
        <div className="actions"><button onClick={async()=>{
          try { await navigator.clipboard.writeText(secret); setMessage('已复制兑换码。'); }
          catch { secretField.current?.select(); }
        }}>复制兑换码</button><button onClick={()=>secretDialog.current?.close()}>关闭</button></div></>}
    </dialog>
  </section>;
}
