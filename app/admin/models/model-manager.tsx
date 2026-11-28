'use client';

import { useState, type FormEvent } from 'react';
import type { AdminModelCatalog } from '@/lib/admin-models';
import { api, ApiError, money, useData } from '../../console';

const endpoint = '/api/admin/models';
const slug = '[a-z0-9][a-z0-9\\-]*';
const pricePattern = '[0-9]{1,9}([.][0-9]{1,6})?';
type Rate = AdminModelCatalog['models'][number]['rates'][number];
type RateDraft = {model:string;group:string;current:Rate|undefined};
type StateChange = {kind:'state'|'group-state';code:string;enabled:boolean};
type Editor = {kind:'create'|'group-create'} | {kind:'group-rename';code:string;name:string} |
  {kind:'rate-publish';draft:RateDraft} | StateChange;

function decimal(micros:string|undefined) {
  if (micros===undefined) return '';
  const amount = BigInt(micros);
  const fractional = String(amount%1_000_000n).padStart(6,'0').replace(/0+$/,'');
  return String(amount/1_000_000n)+(fractional ? '.'+fractional : '');
}

export function ModelManager({timeZone}:{timeZone:string}) {
  const catalog = useData<AdminModelCatalog>(endpoint);
  const data = catalog.error ? undefined : catalog.data;
  const [selectedModel,setSelectedModel] = useState('');
  const [selectedGroup,setSelectedGroup] = useState('');
  const [editor,setEditor] = useState<Editor|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const model = data?.models.find(item=>item.code===selectedModel) ?? data?.models[0];
  const group = data?.groups.find(item=>item.code===selectedGroup) ?? data?.groups[0];
  const rates = model?.rates.filter(item=>item.group===group?.code) ?? [];
  const current = rates.find(item=>!item.closedAt);
  const binding = model?.bindings.find(item=>item.group===group?.code);
  const editableRate = model && group && (model.canManageState || current?.canPublish);

  function open(next:Editor) { setEditor(next); setError(''); setNotice(''); }

  async function save(action:Editor['kind'],payload:object) {
    setBusy(true); setError(''); setNotice('');
    try {
      await api<{id:string}>(endpoint+'/'+action,{method:'POST',body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
      if (action==='create' && 'code' in payload) setSelectedModel(String(payload.code));
      if (action==='group-create' && 'code' in payload) setSelectedGroup(String(payload.code));
      setEditor(null);
      setNotice(action==='rate-publish' ? '新费率已发布。新请求使用此版本。' : '变更已保存。');
    } catch (failure) {
      const incident = failure instanceof ApiError ? failure.requestId : undefined;
      const message = failure instanceof ApiError ? failure.message : '操作结果暂未确认，请刷新核对。';
      if (failure instanceof ApiError && failure.code==='model_rate_changed') setEditor(null);
      setError(incident ? message+' 请求编号 '+incident : message);
    } finally {
      setBusy(false); catalog.refresh();
    }
  }

  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || busy) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    switch (editor.kind) {
      case 'create':
        void save(editor.kind,{code:fields.code,maxContextTokens:Number(fields.context),maxOutputTokens:Number(fields.output)});
        break;
      case 'group-create':
        void save(editor.kind,{code:fields.code,name:fields.name});
        break;
      case 'group-rename':
        void save(editor.kind,{code:editor.code,name:fields.name});
        break;
      case 'state':
      case 'group-state':
        void save(editor.kind,{code:editor.code,enabled:editor.enabled,reason:fields.reason});
        break;
      case 'rate-publish': {
        const {model,group,current} = editor.draft;
        void save(editor.kind,{model,group,expectedRateId:current?.id??null,inputUsd:fields.inputUsd,cachedUsd:fields.cachedUsd,
          outputUsd:fields.outputUsd,multiplierBps:Number(fields.multiplierBps),reason:fields.reason});
        break;
      }
    }
  }

  return <>
    <section className="panel">
      <h1>模型管理</h1>
      <div className="filters">
        <label>对外模型<select value={model?.code??''} disabled={busy} onChange={event=>{setSelectedModel(event.target.value);setEditor(null);}}>
          {data?.models.map(row=><option key={row.code} value={row.code}>{row.code} · {row.enabled?'已启用':'已下架'}</option>)}
        </select></label>
        <label>定价分组<select value={group?.code??''} disabled={busy} onChange={event=>{setSelectedGroup(event.target.value);setEditor(null);}}>
          {data?.groups.map(row=><option key={row.code} value={row.code}>{row.name} · {row.code}</option>)}
        </select></label>
        {data?.canWrite && <><button disabled={busy} onClick={()=>open({kind:'create'})}>新增模型</button>
          <button disabled={busy} onClick={()=>open({kind:'group-create'})}>新增分组</button></>}
        <button disabled={busy} onClick={catalog.refresh}>刷新</button>
      </div>
      {catalog.error && <p className="error" role="alert">{catalog.error}</p>}
      {!data && !catalog.error && <p>正在读取模型…</p>}
      {data && !data.canWrite && <p>当前账号可查看模型、分组和费率。</p>}
      {model && <>
        <h2>{model.code}</h2>
        <p>模型{model.enabled?'已启用':'已下架'} · 上下文上限 {model.maxContextTokens.toLocaleString('zh-CN')} · 输出上限 {model.maxOutputTokens} Token</p>
        {data?.canWrite && model.canManageState && <button disabled={busy}
          onClick={()=>open({kind:'state',code:model.code,enabled:!model.enabled})}>{model.enabled?'下架模型':'上架模型'}</button>}
      </>}
      {group && <>
        <h2>{group.name}</h2>
        <p>分组 {group.code} · {group.enabled?'已启用':'已停用'}</p>
        <p>{binding
          ? <>上游模型 <code>{binding.upstreamModel}</code> · {binding.effective?'渠道就绪':'渠道未就绪'} · {binding.streaming?'支持流式':'非流式'}</>
          : current && !current.canPublish ? '此组合的费率由系统或环境配置维护。' : '此组合尚无已发布的渠道绑定。'}
          {' '}<a href="/admin/channels">查看渠道管理</a></p>
        {data?.canWrite && <div className="filters">
          <button disabled={busy} onClick={()=>open({kind:'group-rename',code:group.code,name:group.name})}>修改分组名称</button>
          <button disabled={busy} onClick={()=>open({kind:'group-state',code:group.code,enabled:!group.enabled})}>
            {group.enabled?'停用分组':'启用分组'}</button>
          {editableRate && model && <button className="primary" disabled={busy} onClick={()=>open({kind:'rate-publish',
            draft:{model:model.code,group:group.code,current}})}>发布费率</button>}
        </div>}
      </>}
    </section>
    {notice && <p role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {data?.canWrite && editor && <form className="panel" key={editor.kind} onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend>{{create:'新增模型','group-create':'新增分组','group-rename':'修改分组名称',state:'确认模型状态',
          'group-state':'确认分组状态','rate-publish':'发布费率'}[editor.kind]}</legend>
        {(editor.kind==='create' || editor.kind==='group-create') &&
          <label>代号<input name="code" required pattern={slug} maxLength={editor.kind==='create'?64:40}/></label>}
        {editor.kind==='create' && <div className="filters">
          <label>上下文上限<input name="context" type="number" required min={128} max={5000000} defaultValue={8192}/></label>
          <label>输出上限<input name="output" type="number" required min={1} max={128} defaultValue={128}/></label>
        </div>}
        {(editor.kind==='group-create' || editor.kind==='group-rename') &&
          <label>分组名称<input name="name" required maxLength={80} defaultValue={editor.kind==='group-rename'?editor.name:''}/></label>}
        {(editor.kind==='state' || editor.kind==='group-state') &&
          <p>{editor.enabled ? '启用' : '停用'} <strong>{editor.code}</strong>{editor.enabled ? '。'
            : '。相关模型将停止接收新请求，已发出的请求与历史账单仍可核对。'}</p>}
        {editor.kind==='rate-publish' && <>
          <p>{editor.draft.model} · {editor.draft.group} · USD / 百万 Token</p>
          <div className="filters">
            <label>输入<input name="inputUsd" required inputMode="decimal" pattern={pricePattern} defaultValue={decimal(editor.draft.current?.inputMicros)}/></label>
            <label>缓存读取<input name="cachedUsd" required inputMode="decimal" pattern={pricePattern} defaultValue={decimal(editor.draft.current?.cacheMicros)}/></label>
            <label>输出<input name="outputUsd" required inputMode="decimal" pattern={pricePattern} defaultValue={decimal(editor.draft.current?.outputMicros)}/></label>
            <label>倍率（10,000 = 1×）<input name="multiplierBps" type="number" required min={1} max={100000}
              defaultValue={editor.draft.current?.multiplierBps??10000}/></label>
          </div>
        </>}
        {(editor.kind==='state' || editor.kind==='group-state' || editor.kind==='rate-publish') &&
          <label>变更原因<input name="reason" required minLength={3} maxLength={160}/></label>}
        <div className="filters"><button className="primary" type="submit">{busy?'提交中…':'确认提交'}</button>
          <button type="button" onClick={()=>setEditor(null)}>取消</button></div>
      </fieldset>
    </form>}
    {model && group && <section className="panel">
      <h2>费率版本</h2>
      {rates.length===0 ? <p>暂无费率。</p> : <div className="table-wrap"><table>
        <caption>每百万 Token 的基础价格</caption>
        <thead><tr><th>版本</th><th>状态</th><th>输入</th><th>缓存读取</th><th>输出</th><th>倍率</th><th>发布时间</th></tr></thead>
        <tbody>{rates.map(rate=><tr key={rate.id}><td><code title={rate.id}>{rate.id.slice(0,8)}</code></td>
          <td>{rate.closedAt?'历史':'当前'}</td><td>{money(rate.inputMicros)}</td><td>{money(rate.cacheMicros)}</td>
          <td>{money(rate.outputMicros)}</td><td>{rate.multiplierBps/10000}×</td>
          <td><time dateTime={rate.createdAt}>{new Date(rate.createdAt).toLocaleString('zh-CN',{timeZone,timeZoneName:'short'})}</time></td>
        </tr>)}</tbody>
      </table></div>}
    </section>}
  </>;
}
