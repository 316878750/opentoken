'use client';
import { useState, type FormEvent } from 'react';
import type { SettingsRead, SettingVersion } from '@/lib/admin-settings';
import { api } from '../../console';
import { ActionFeedback } from '../list-controls';

const endpoint = '/api/admin/settings';
const labels = {announcement:'站点公告',supportUrl:'支持链接（HTTPS）',timeZone:'默认展示时区',
  singleMicros:'运营单码上限（美元）',dailyMicros:'运营每日签发上限（美元）'};

function dollars(micros:string) {
  const raw = micros.padStart(7,'0');
  return (raw.slice(0,-6)+'.'+raw.slice(-6)).replace(/\.?0+$/,'') || '0';
}
function toMicros(input:string) {
  if (!/^\d{1,13}(\.\d{1,6})?$/.test(input)) throw new Error('请输入非负美元金额，最多六位小数。');
  const [whole,part=''] = input.split('.');
  return BigInt(whole+part.padEnd(6,'0')).toString();
}
function formValues(row:SettingVersion) {
  return {announcement:row.announcement,supportUrl:row.supportUrl,timeZone:row.timeZone,
    singleMicros:dollars(row.singleMicros),dailyMicros:dollars(row.dailyMicros)};
}
export function SettingsManager({initial}:{initial:SettingsRead}) {
  const [page,setPage] = useState(initial);
  const [fields,setFields] = useState(formValues(initial.current));
  const [reason,setReason] = useState('');
  const [restore,setRestore] = useState<number|null>(null);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [error,setError] = useState('');
  const editable = !!page.history;
  async function refresh() {
    const next = await api<SettingsRead>(endpoint);
    setPage(next);setFields(formValues(next.current));setReason('');setRestore(null);
  }
  async function run(work:()=>Promise<void>) {
    setBusy(true);setNotice('');setError('');
    try { await work(); } catch(error) { setError(error instanceof Error?error.message:'结果暂未确认，请重新加载。'); }
    finally { setBusy(false); }
  }
  function save(event:FormEvent) {
    event.preventDefault();
    void run(async()=>{
      const change = restore!==null ? {restoreVersion:restore} : {settings:{...fields,
        singleMicros:toMicros(fields.singleMicros),dailyMicros:toMicros(fields.dailyMicros)}};
      const saved = await api<{version:number}>(endpoint,{method:'POST',
        body:JSON.stringify({...change,expectedVersion:page.current.version,reason})});
      setNotice('版本 '+saved.version+' 已生效。');
      await refresh();
    });
  }
  return <><section className="panel"><h1>系统设置</h1><p>当前版本 {page.current.version}</p>
    <form onSubmit={save}>
      <fieldset disabled={!editable || busy || restore!==null}>
        {Object.entries(labels).map(([key,label])=>{
          const name = key as keyof typeof labels;
          const props = {value:fields[name],onChange:(e:{target:{value:string}})=>setFields({...fields,[name]:e.target.value})};
          return <label key={name}>{label}{name==='announcement'?<textarea {...props} maxLength={1000}/>:<input {...props}
            required={name!=='supportUrl'} type={name==='supportUrl'?'url':'text'} />}</label>;
        })}
      </fieldset>
      {editable && <><label>变更原因<input value={reason} maxLength={200} required onChange={e=>setReason(e.target.value)}/></label>
        {restore!==null && <p>将恢复版本 {restore} 的全部设置，并生成新版本。</p>}
        <button disabled={busy} className="primary">{restore===null?'发布设置':'确认回退到版本 '+restore}</button>
        {restore!==null && <button type="button" onClick={()=>setRestore(null)}>取消回退</button>}</>}
      <button type="button" disabled={busy} onClick={()=>void run(async()=>{await refresh();setNotice('已重新加载当前版本。');})}>重新加载</button>
    </form><ActionFeedback busy={busy} message={notice} error={error}/></section>
    {page.history && <section className="panel"><h2>设置版本</h2>{page.history.map(row=><details key={row.version}>
      <summary>版本 {row.version}</summary><dl>{Object.entries(formValues(row)).map(([key,value])=><div key={key}>
        <dt>{labels[key as keyof typeof labels]}</dt><dd>{value||'未设置'}</dd></div>)}</dl>
      {row.version<page.current.version && <button disabled={busy} onClick={()=>setRestore(row.version)}>选择此版本回退</button>}</details>)}
      {Number(page.history.at(-1)?.version)>0 && <button disabled={busy} onClick={()=>void run(async()=>{
        const older = await api<SettingsRead>(endpoint+'?before='+page.history!.at(-1)!.version);
        setPage({...page,history:[...page.history!,...older.history??[]]});
      })}>更早版本</button>}</section>}</>;
}
