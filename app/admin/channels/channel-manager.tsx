'use client';

import { useState, type FormEvent } from 'react';
import { api, ApiError, useData } from '../../console';

const endpoint = '/api/admin/channels';
const statusLabels:Record<string,string> = {pending:'测试中',passed:'通过',auth_failed:'鉴权失败',model_unavailable:'模型不可用',
  timeout:'超时',upstream_unavailable:'上游不可用',unverified:'结果待确认'};
type Pair = {model:string;group:string};
type TestModel = {upstreamModel:string;responseModel?:string;streaming:boolean;tokenField:'max_tokens'|'max_completion_tokens'};
type Binding = Pair & TestModel;
type Policy = {priority:number;weight:number;automaticFailover:boolean;standbyChannelId?:string;failoverThreshold?:number;
  failoverCooldownSeconds?:number;autoPublishModels:string[];autoPublishGroup?:string;discoveryIntervalMinutes?:number};
type Draft = {name:string;credentialRef:string;notes?:string;bindings:Binding[];policy:Policy;testModel?:TestModel};
type Version = {id:string;name:string;type:string;bindings:Pair[];probes:{binding:number;status:string;elapsedMs:number|null}[];
  publishedAt:string|null;endpoint?:string|null;credentialAvailable?:boolean;credentialRef?:string;policy?:Policy;testModel?:TestModel};
type Channel = {id:string;enabled:boolean;active:Version|null;draft:Version|null;history:Version[]};
type ChannelData = {items:Channel[];canWrite:boolean;options?:Pair[];credentials?:{ref:string;type:string;endpoint:string;available:boolean}[];
  legacy?:(Pair & {status:'managed'|'ready'|'mismatch';credentialRegistered:boolean})[]};

function emptyBinding():Binding { return {model:'',group:'',upstreamModel:'',streaming:false,tokenField:'max_tokens'}; }
function emptyDraft():Draft {
  return {name:'',credentialRef:'',bindings:[],policy:{priority:0,weight:100,automaticFailover:false,autoPublishModels:[]}};
}
const tested = (version:Version,index:number)=>version.probes.find(probe=>probe.binding===index);

export function ChannelManager({timeZone}:{timeZone:string}) {
  const channels = useData<ChannelData>(endpoint);
  const data = channels.error ? undefined : channels.data;
  const [search,setSearch] = useState('');
  const [status,setStatus] = useState('');
  const [type,setType] = useState('');
  const [selectedId,setSelected] = useState('');
  const [editing,setEditing] = useState<string|null>(null);
  const [draft,setDraft] = useState<Draft>(emptyDraft);
  const [reason,setReason] = useState('');
  const [rollbackId,setRollbackId] = useState('');
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [error,setError] = useState('');
  const selected = data?.items.find(item=>item.id===selectedId);
  const availableCredentials = data?.credentials ?? [];
  const chosenCredential = availableCredentials.find(item=>item.ref===draft.credentialRef);
  const currentDraft = selected?.draft;
  const otherPublished = selected?.active?.id!==currentDraft?.id ? selected?.active : null;
  const rollbackVersion = selected?.history.find(version=>version.id===rollbackId);

  function openDraft(channel?:Channel) {
    const previous = channel?.draft as (Version & Draft)|null|undefined;
    setSelected(channel?.id??'');
    setEditing(channel?.id??'');
    setDraft(previous ? {name:previous.name,credentialRef:previous.credentialRef,bindings:previous.bindings,
      policy:previous.policy,notes:previous.notes,testModel:previous.testModel} : emptyDraft());
    setError(''); setNotice('');
  }

  function updateBinding(index:number,patch:Partial<Binding>) {
    setDraft(old=>({...old,bindings:old.bindings.map((value,position)=>position===index?{...value,...patch}:value)}));
  }

  async function post<T>(path:string,input:object):Promise<T|undefined> {
    setBusy(true); setError(''); setNotice('');
    try { return await api<T>(endpoint+path,{method:'POST',body:JSON.stringify(input),signal:AbortSignal.timeout(65000)}); }
    catch (failure) { setError(failure instanceof ApiError ? failure.message : '操作结果暂未确认，请刷新核对。'); }
    finally { setBusy(false); channels.refresh(); }
  }

  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = {...draft,policy:{...draft.policy},bindings:draft.bindings.map(row=>({...row,
      responseModel:row.responseModel?.trim()||undefined}))};
    const result = await post<{id:string}>(editing ? '/'+editing+'/versions' : '',input);
    if (result) { setSelected(result.id); setEditing(null); setNotice('渠道草稿已保存。'); }
  }

  async function probe(versionId:string,binding:number) {
    const result = await post<{status:string;elapsedMs:number}>('/'+selectedId+'/test',{versionId,binding});
    if (result) setNotice(`连接测试${statusLabels[result.status]} · ${result.elapsedMs} ms`);
  }

  async function change(action:'enable'|'disable'|'rollback',versionId?:string) {
    if (reason.trim().length<3) { setError('请填写至少三个字的变更原因。'); return; }
    const result = await post<{enabled:boolean}>('/'+selectedId+'/'+action,{versionId,reason:reason.trim()});
    if (result) { setReason(''); setRollbackId(''); setNotice({enable:'渠道已启用。',disable:'渠道已停用。',rollback:'渠道已回退。'}[action]); }
  }

  const filtered = data?.items.filter(channel=>{
    const version = channel.active ?? channel.draft;
    const text = [channel.id,version?.name,...(version?.bindings.flatMap(pair=>[pair.model,pair.group])??[])].join(' ').toLowerCase();
    return (!status || status===(channel.enabled?'enabled':channel.active?'disabled':'draft')) && (!type || type===version?.type) &&
      text.includes(search.trim().toLowerCase());
  });
  const policy = draft.policy;

  return <>
    <section className="panel">
      <h1>渠道管理</h1>
      <div className="filters">
        <label>关键词<input value={search} onChange={event=>setSearch(event.target.value)} placeholder="名称、模型或分组"/></label>
        <label>类型<select value={type} onChange={event=>setType(event.target.value)}><option value="">全部</option>
          <option value="official">官方 OpenAI</option><option value="compatible">OpenAI 兼容</option></select></label>
        <label>状态<select value={status} onChange={event=>setStatus(event.target.value)}><option value="">全部</option>
          <option value="draft">草稿</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select></label>
        {data?.canWrite && <button className="primary" disabled={busy} onClick={()=>openDraft()}>新增渠道</button>}
        <button onClick={channels.refresh}>刷新</button>
      </div>
      {channels.error && <p className="error" role="alert">{channels.error}</p>}
      {!data && !channels.error && <p>正在读取渠道…</p>}
      {filtered?.length===0 && <p>没有符合条件的渠道。</p>}
      {!!filtered?.length && <div className="table-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>状态</th><th>生效绑定</th><th>操作</th></tr></thead>
        <tbody>{filtered.map(channel=>{const version=channel.active??channel.draft;return <tr key={channel.id}>
          <td>{version?.name}</td><td>{version?.type==='official'?'官方 OpenAI':'OpenAI 兼容'}</td>
          <td>{channel.enabled?'已启用':channel.active?'已停用':'草稿'}</td><td>{channel.enabled ? channel.active?.bindings.length : 0}</td>
          <td><button disabled={busy} onClick={()=>{setSelected(channel.id);setEditing(null);setRollbackId('');setReason('');}}>详情</button></td>
        </tr>;})}</tbody></table></div>}
      {!!data?.legacy?.length && <details><summary>旧环境配置比对</summary><ul>{data.legacy.map(item=><li key={item.model+':'+item.group}>
        {item.model} · {item.group} · {{managed:'已接管',ready:'模型与费率一致',mismatch:'模型或费率有差异'}[item.status]} ·
        {item.credentialRegistered?'已登记同一密钥引用':'待登记匹配的密钥引用'}</li>)}</ul></details>}
    </section>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}

    {editing!==null && data?.canWrite && <form className="panel" onSubmit={save}>
      <h2>{editing?'编辑渠道草稿':'新增渠道'}</h2>
      <div className="filters"><label>名称<input required maxLength={80} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
        <label>已登记密钥<select required value={draft.credentialRef} onChange={e=>setDraft({...draft,credentialRef:e.target.value})}>
          <option value="">请选择</option>{availableCredentials.map(item=><option key={item.ref} disabled={!item.available} value={item.ref}>
            {item.ref} · {item.type==='official'?'官方 OpenAI':'OpenAI 兼容'}</option>)}</select></label>
      </div>
      {chosenCredential && <p>请求地址 {chosenCredential.endpoint}</p>}
      <label>备注<input maxLength={300} value={draft.notes??''} onChange={e=>setDraft({...draft,notes:e.target.value})}/></label>
      <label>独立测试模型 ID（可选）<input value={draft.testModel?.upstreamModel??''} onChange={e=>setDraft({...draft,
        testModel:e.target.value?{upstreamModel:e.target.value,streaming:false,
          tokenField:chosenCredential?.type==='official'?'max_completion_tokens':'max_tokens'}:undefined})}/></label>
      <h3>模型与分组绑定</h3>
      {draft.bindings.map((row,index)=><fieldset key={index}><legend>绑定 {index+1}</legend><div className="filters">
        <label>对外模型与分组<select required value={row.model?row.model+':'+row.group:''} onChange={event=>{
          const [model,group] = event.target.value.split(':'); updateBinding(index,{model,group});
        }}><option value="">请选择</option>{data.options?.map(pair=><option key={pair.model+':'+pair.group} value={pair.model+':'+pair.group}>{pair.model} · {pair.group}</option>)}</select></label>
        <label>供应商模型 ID<input required value={row.upstreamModel} onChange={e=>updateBinding(index,{upstreamModel:e.target.value})}/></label>
        <label>返回模型 ID（可选）<input value={row.responseModel??''} onChange={e=>updateBinding(index,{responseModel:e.target.value})}/></label>
        <label>输出上限字段<select value={row.tokenField} onChange={e=>updateBinding(index,{tokenField:e.target.value==='max_tokens'?'max_tokens':'max_completion_tokens'})}>
          <option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
        <label><input type="checkbox" checked={row.streaming} onChange={e=>updateBinding(index,{streaming:e.target.checked})}/> 支持流式</label>
        <button type="button" onClick={()=>setDraft({...draft,bindings:draft.bindings.filter((_,i)=>i!==index)})}>移除绑定</button>
      </div></fieldset>)}
      <button type="button" disabled={draft.bindings.length>=20} onClick={()=>setDraft({...draft,bindings:[...draft.bindings,{
        ...emptyBinding(),tokenField:chosenCredential?.type==='official'?'max_completion_tokens':'max_tokens'}]})}>添加绑定</button>
      <details><summary>分流、自动切换和模型上线策略</summary>
        <p>可提前配置策略。当前运行模式为单路由。</p>
        <div className="filters"><label>优先级<input type="number" min={0} max={1000} value={policy.priority}
          onChange={e=>setDraft({...draft,policy:{...policy,priority:Number(e.target.value)}})}/></label>
          <label>流量权重<input type="number" min={1} max={100} value={policy.weight}
          onChange={e=>setDraft({...draft,policy:{...policy,weight:Number(e.target.value)}})}/></label>
          <label><input type="checkbox" checked={policy.automaticFailover} onChange={e=>setDraft({...draft,policy:{...policy,automaticFailover:e.target.checked}})}/> 自动切换策略</label>
          <label>候选渠道<select value={policy.standbyChannelId??''} onChange={e=>setDraft({...draft,policy:{...policy,standbyChannelId:e.target.value||undefined}})}>
            <option value="">未配置</option>{data.items.filter(item=>item.id!==editing).map(item=><option key={item.id} value={item.id}>{(item.active??item.draft)?.name}</option>)}</select></label>
          {policy.automaticFailover && <><label>连续失败次数<input type="number" min={1} max={20} value={policy.failoverThreshold??3}
            onChange={e=>setDraft({...draft,policy:{...policy,failoverThreshold:Number(e.target.value)}})}/></label>
            <label>切换冷却时间（秒）<input type="number" min={10} max={3600} value={policy.failoverCooldownSeconds??60}
              onChange={e=>setDraft({...draft,policy:{...policy,failoverCooldownSeconds:Number(e.target.value)}})}/></label></>}
          <label>自动上线分组<select value={policy.autoPublishGroup??''} onChange={e=>setDraft({...draft,
            policy:{...policy,autoPublishGroup:e.target.value||undefined,autoPublishModels:[]}})}>
            <option value="">未配置</option>{[...new Set(draft.bindings.map(row=>row.group).filter(Boolean))].map(group=><option key={group} value={group}>{group}</option>)}</select></label>
          {policy.autoPublishGroup && <label>目录检查间隔（分钟）<input type="number" min={5} max={1440} value={policy.discoveryIntervalMinutes??60}
            onChange={e=>setDraft({...draft,policy:{...policy,discoveryIntervalMinutes:Number(e.target.value)}})}/></label>}
        </div>
        {[...new Set(draft.bindings.filter(row=>row.group===policy.autoPublishGroup).map(row=>row.upstreamModel).filter(Boolean))].map(model=>
          <label key={model}><input type="checkbox" checked={policy.autoPublishModels.includes(model)} onChange={e=>setDraft({...draft,
            policy:{...policy,autoPublishModels:e.target.checked?[...policy.autoPublishModels,model]:policy.autoPublishModels.filter(item=>item!==model)}})}/>{model}</label>)}
      </details>
      <div className="actions"><button className="primary" disabled={busy}>保存草稿</button>
        <button type="button" disabled={busy} onClick={()=>setEditing(null)}>取消</button></div>
    </form>}

    {selected && currentDraft && editing===null && <section className="panel">
      <h2>{currentDraft.name}</h2>
      <p>当前生效版本 {selected.enabled ? selected.active?.id : '无'}</p>
      <p>草稿版本 {currentDraft.id}{currentDraft.endpoint && <> · {currentDraft.endpoint}</>}</p>
      {otherPublished && <>
        <h3>{selected.enabled?'当前生效绑定':'上次生效绑定'}</h3>
        <ul>{otherPublished.bindings.map((item,index)=>{
          const result = tested(otherPublished,index);
          return <li key={item.model+':'+item.group}>
            {item.model} · {item.group} · {result ? statusLabels[result.status] : '未测试'}{' '}
            {data?.canWrite && <button disabled={busy || !otherPublished.credentialAvailable}
              onClick={()=>void probe(otherPublished.id,index)}>重新测试生效版本绑定</button>}
          </li>;
        })}</ul>
      </>}
      {currentDraft.testModel && data?.canWrite && <button disabled={busy} onClick={()=>void probe(currentDraft.id,-1)}>测试 {currentDraft.testModel.upstreamModel}</button>}
      <ul>{currentDraft.bindings.map((item,index)=>{const result=tested(currentDraft,index);return <li key={item.model+':'+item.group}>
        {item.model} · {item.group} · {result ? statusLabels[result.status] : '未测试'}{result?.elapsedMs!=null && ` · ${result.elapsedMs} ms`}{' '}
        {data?.canWrite && <button disabled={busy} onClick={()=>void probe(currentDraft.id,index)}>测试绑定</button>}
      </li>;})}</ul>
      {data?.canWrite && <><button disabled={busy} onClick={()=>openDraft(selected)}>编辑或轮换密钥</button>
        <div className="filters"><label>变更原因<input maxLength={160} value={reason} onChange={e=>setReason(e.target.value)}/></label>
          <button disabled={busy || !currentDraft.credentialAvailable || !currentDraft.bindings.length ||
            currentDraft.bindings.some((_,index)=>tested(currentDraft,index)?.status!=='passed')}
            onClick={()=>void change('enable',currentDraft.id)}>启用该草稿版本</button>
          {selected.enabled && <button disabled={busy} onClick={()=>void change('disable')}>停用渠道</button>}
          {!selected.enabled && selected.active && selected.active.id!==currentDraft.id && selected.active.credentialAvailable &&
            <button disabled={busy} onClick={()=>void change('enable',selected.active?.id)}>恢复上次生效版本</button>}
        </div>
        {selected.enabled && <div className="filters"><label>回退版本<select value={rollbackId} onChange={e=>setRollbackId(e.target.value)}>
          <option value="">请选择</option>{selected.history.filter(v=>v.id!==selected.active?.id && v.credentialAvailable).map(v=>
            <option key={v.id} value={v.id}>{v.name} · {v.id.slice(0,8)} · {new Date(v.publishedAt!).toLocaleString('zh-CN',{timeZone,timeZoneName:'short'})}</option>)}</select></label>
          <button disabled={busy || !rollbackId} onClick={()=>void change('rollback',rollbackId)}>回退</button></div>}
        {rollbackVersion && <ul>{rollbackVersion.bindings.map((item,index)=><li key={item.model+':'+item.group}>
          {item.model} · {item.group}{' '}<button disabled={busy} onClick={()=>void probe(rollbackVersion.id,index)}>重新测试回退绑定</button>
        </li>)}</ul>}
      </>}
    </section>}
  </>;
}
