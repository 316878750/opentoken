'use client';

import { useState, type FormEvent } from 'react';
import type { AuditPage, OperationLog } from '@/lib/admin-logs';
import { useData } from '../../console';
import { ListPager } from '../list-controls';

const outcomes:Record<string,string> = {success:'成功',failure:'失败',rate_limited:'限流',unavailable:'身份服务不可用',denied:'拒绝或失败'};
const reasons:Record<string,string> = {authenticated:'身份已验证',credentials_or_account:'凭据或账号校验未通过',
  auth_rate_limit:'登录限流',auth_unavailable:'身份服务不可用',recorded:'变更已记录',rejected:'操作被拒绝',
  unknown:'结果待核对',unverified:'结果待核对',timeout:'请求超时',passed:'连接测试通过',failed:'操作失败',
  issued:'已签发',voided:'已作废',credited:'已入账',granted:'已获授权',role_required:'缺少后台权限'};
const actions:Record<string,string> = {
  'admin.page':'打开后台页面','admin.session':'检查后台会话','admin.role_change':'运维角色变更',
  'channel.create':'新增渠道','channel.edit':'编辑渠道','channel.probe_started':'开始渠道测试',
  'channel.probe_finished':'渠道测试结果','channel.enable':'启用渠道','channel.disable':'停用渠道','channel.rollback':'回退渠道',
  'model.create':'新增模型','model.state':'变更模型状态','model.group_create':'新增分组','model.group_rename':'重命名分组',
  'model.group_state':'变更分组状态','model.rate_publish':'发布费率',
  'redeem.issue':'签发兑换码','redeem.void':'作废兑换码','redeem.credit':'兑换码入账','user.state':'变更账号状态','user.role':'变更用户角色',
  'user.delete':'删除账号','user.invite_started':'开始签发邀请','user.invite_finished':'邀请签发结果',
  'user.invite_reconciled':'邀请核对','settings.publish':'发布系统设置','settings.rollback':'回退系统设置','other':'其他操作',
};
const detailLabels:Record<string,string> = {before:'变更前',after:'变更后',codeId:'兑换码 ID',channelId:'渠道 ID',
  operationId:'操作编号',receiptId:'钱包收据 ID',modelId:'模型 ID',groupId:'分组 ID',rateId:'费率 ID',versionId:'版本 ID',amountMicros:'金额（微美元）',
  elapsedMs:'耗时（毫秒）',revokedKeys:'已撤销密钥数'};
const uuidPattern = '[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';

function OperationDetails({event}:{event:OperationLog}) {
  return <><div>{event.targetId && <code>{event.targetId}</code>}</div>
    {Object.keys(event.details).length>0 && <details><summary>查看详情</summary><dl>
      {Object.entries(event.details).map(([field,value])=><div key={field}>
        <dt>{detailLabels[field]??field}</dt><dd><code>{typeof value==='string'?value:JSON.stringify(value)}</code></dd>
      </div>)}
    </dl></details>}
  </>;
}

export function AuditLog({screen,ownOnly,timeZone}:{timeZone:string;screen:'login-logs'|'operation-logs';ownOnly:boolean}) {
  const login = screen==='login-logs';
  const [filters,setFilters] = useState<Record<string,string>>({});
  const [cursors,setCursors] = useState<string[]>([]);
  const [rangeError,setRangeError] = useState('');
  const query = new URLSearchParams(filters);
  const cursor = cursors.at(-1);
  if (cursor) query.set('cursor',cursor);
  const audit = useData<AuditPage>('/api/admin/'+screen+'?'+query);
  const data = audit.error ? undefined : audit.data;

  function filter(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next:Record<string,string> = {};
    for (const [field,value] of new FormData(event.currentTarget)) {
      const text = String(value).trim();
      if (!text) continue;
      if (field==='from' || field==='to') {
        const time = new Date(text);
        if (!Number.isFinite(time.valueOf()) || time.getFullYear()<1 || time.getFullYear()>9999) {
          setRangeError('请输入有效的开始和结束时间。');
          return;
        }
        next[field] = time.toISOString();
      } else {
        next[field] = text.toLowerCase();
      }
    }
    if (next.from && next.to && next.from>=next.to) {
      setRangeError('开始时间须早于结束时间。');
      return;
    }
    setRangeError('');setFilters(next);setCursors([]);
  }

  return <section className="panel">
    <h1>{login?'登录日志':'操作日志'}</h1>
    {ownOnly && <p>可查看当前账号执行的操作。</p>}
    <form className="filters" onSubmit={filter} onReset={()=>{setFilters({});setCursors([]);setRangeError('');}}>
      <label>开始时间（浏览器本地）<input type="datetime-local" name="from"/></label>
      <label>结束时间（浏览器本地）<input type="datetime-local" name="to"/></label>
      <label>结果<select name="outcome"><option value="">全部</option>
        {(login?['success','failure','rate_limited','unavailable']:['success','denied'])
          .map(value=><option key={value} value={value}>{outcomes[value]}</option>)}
      </select></label>
      {login ? <>
        <label>用户 ID<input name="userId" maxLength={36} pattern={uuidPattern}/></label>
        <label>脱敏标识<input name="identifier" maxLength={12} pattern="[0-9a-fA-F]{12}"/></label>
      </> : <>
        {!ownOnly && <label>操作者 ID<input name="actorId" maxLength={36} pattern={uuidPattern}/></label>}
        <label>动作<select name="action"><option value="">全部</option>
          {Object.entries(actions).map(([value,label])=><option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>操作对象<input name="object" maxLength={64} pattern={'[a-zA-Z0-9][a-zA-Z0-9\\-]{0,63}'} placeholder="ID、模型或分组代号"/></label>
      </>}
      <label>请求编号<input name="requestId" maxLength={36} pattern={uuidPattern}/></label>
      <button className="primary">查询</button><button type="reset">重置筛选</button><button type="button" onClick={audit.refresh}>刷新</button>
    </form>
    {(rangeError || audit.error) && <p className="error" role="alert">{rangeError || audit.error}</p>}
    {!data && !audit.error && <p role="status">正在读取日志…</p>}
    {data?.items.length===0 && <p className="list-empty">{Object.keys(filters).length?'没有符合条件的日志，可重置筛选。':'暂无日志记录。'}</p>}
    {!!data?.items.length && <div className="table-wrap"><table className="phone-records" aria-label={login?'登录日志列表':'操作日志列表'}>
      <thead><tr><th scope="col">时间（{timeZone}）</th><th scope="col">{login?'用户与标识':'操作者'}</th>{!login && <th scope="col">动作</th>}
        <th scope="col">结果</th><th scope="col">原因</th>{!login && <th scope="col">对象与变更</th>}<th scope="col">请求编号</th></tr></thead>
      <tbody>{data.items.map(event=><tr key={event.requestId}>
        <td data-label="时间" className="record-wide"><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString('zh-CN',{timeZone,timeZoneName:'short'})}</time></td>
        {'identifier' in event ? <td data-label="用户与标识" className="record-wide">{event.userId && <><code>{event.userId}</code><br/></>}<code>{event.identifier}</code></td> :
          <><td data-label="操作者" className="record-wide">{event.source==='database'?'运维命令':<code>{event.actorId}</code>}</td><td data-label="动作">{actions[event.action]??event.action}</td></>}
        <td data-label="结果">{outcomes[event.outcome]??event.outcome}</td><td data-label="原因">{reasons[event.reason]??event.reason}</td>
        {'action' in event && <td data-label="对象与变更" className="record-wide"><OperationDetails event={event}/></td>}
        <td data-label="请求编号" className="record-wide"><code>{event.requestId}</code></td>
      </tr>)}</tbody>
    </table></div>}
    <ListPager page={cursors.length+1} count={data?.items.length}
      onPrevious={cursor?()=>setCursors(cursors.slice(0,-1)):undefined}
      onNext={data?.nextCursor?()=>setCursors([...cursors,data.nextCursor!]):undefined}/>
  </section>;
}
