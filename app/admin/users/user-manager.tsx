'use client';

import { useState, type FormEvent } from 'react';
import type { AdminUser, AdminUserPage } from '@/lib/admin-users';
import { api, ApiError, money, useData } from '../../console';

const endpoint = '/api/admin/users';
const roleNames = {system_admin:'系统管理员',operator:'运营人员',auditor:'审计员'};
const statuses = {active:'正常',pending:'待验证',suspended:'已停用',auth_blocked:'身份服务已限制',deleted:'已删除'};
type EditKind = 'state'|'role'|'delete';

export function UserManager({timeZone}:{timeZone:string}) {
  const [filters,setFilters] = useState({search:'',status:''});
  const [cursors,setCursors] = useState<string[]>([]);
  const [editor,setEditor] = useState<{kind:EditKind;user:AdminUser}|null>(null);
  const [inviting,setInviting] = useState(false);
  const [inviteEmail,setInviteEmail] = useState('');
  const [operationId,setOperationId] = useState('');
  const [inviteLink,setInviteLink] = useState('');
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [error,setError] = useState('');
  const query = new URLSearchParams();
  if (filters.search) query.set('search',filters.search);
  if (filters.status) query.set('status',filters.status);
  const cursor = cursors.at(-1);
  if (cursor) query.set('cursor',cursor);
  const users = useData<AdminUserPage>(endpoint+'?'+query);
  const data = users.error ? undefined : users.data;

  function filter(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setFilters({search:String(fields.get('search')).trim(),status:String(fields.get('status'))});
    setCursors([]); setEditor(null);
  }

  function clearInvite() {
    setInviting(false); setInviteEmail(''); setOperationId(''); setInviteLink('');
  }

  function openEditor(kind:EditKind,user:AdminUser) {
    clearInvite(); setEditor({kind,user}); setError(''); setNotice('');
  }

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true); setError(''); setNotice('');
    try {
      if (editor) {
        const {kind,user} = editor;
        const reason = fields.get('reason');
        const payload = kind==='state' ? {suspended:!user.suspended,expectedRevision:user.revision,reason}
          : kind==='role' ? {role:fields.get('role') || null,expectedRole:user.role,reason}
          : {confirmation:fields.get('confirmation'),expectedRevision:user.revision,expectedRole:user.role,reason};
        await api(endpoint+'/'+user.id+'/'+kind,{method:'POST',body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
        setEditor(null); setNotice(kind==='delete' ? '该 OpenToken 账号已删除。' : '用户变更已保存。');
      } else if (inviting) {
        const id = operationId || crypto.randomUUID();
        setOperationId(id);
        const result = await api<{link:string}>(endpoint+'/invitations',{
          method:'POST',body:JSON.stringify({email:inviteEmail,operationId:id}),signal:AbortSignal.timeout(18000),
        });
        setInviteLink(result.link); setNotice('邀请链接已签发。');
      }
    } catch (failure) {
      if (failure instanceof ApiError) {
        if (['user_state_changed','user_role_changed','user_deleted'].includes(failure.code ?? '')) setEditor(null);
        if (failure.code==='invite_failed') setOperationId('');
        setError(failure.requestId ? failure.message+' 请求编号 '+failure.requestId : failure.message);
      } else {
        setError('结果暂未确认，请核对当前状态。');
      }
    } finally {
      setBusy(false); users.refresh();
    }
  }

  return <>
    <section className="panel">
      <h1>用户管理</h1>
      <form className="filters" onSubmit={filter}>
        <label>{data?.canWrite ? '邮箱前缀或用户 ID' : '用户 ID'}<input name="search" maxLength={254}/></label>
        <label>账号状态<select name="status"><option value="">在册账号</option>
          {Object.entries(statuses).filter(([value])=>value!=='deleted' || data?.canWrite || filters.status==='deleted')
            .map(([value,label])=><option key={value} value={value}>{label}</option>)}
        </select></label>
        <button disabled={busy}>查询</button>
        <button type="button" disabled={busy} onClick={users.refresh}>刷新</button>
        {data?.canInvite && <button type="button" className="primary" disabled={busy} onClick={()=>{
          setEditor(null); setInviting(true); setError(''); setNotice('');
        }}>邀请用户</button>}
      </form>
      {data && !data.canInvite && <p>此环境尚未配置邀请服务。</p>}
      {users.error && <p className="error" role="alert">{users.error}</p>}
      {!data && !users.error && <p>正在读取用户…</p>}
      {data?.items.length===0 && <p>没有符合条件的用户。</p>}
      {!!data?.items.length && <div className="table-wrap"><table>
        <thead><tr><th>账号</th><th>状态</th><th>后台角色</th>{data.canWrite && <><th>钱包</th><th>操作</th></>}</tr></thead>
        <tbody>{data.items.map(user=><tr key={user.id}>
          <td>{user.email ?? '邮箱不可用'}<br/><code>{user.id}</code></td>
          <td>{statuses[user.status]}<br/>{user.deletedAt
            ? <time dateTime={user.deletedAt}>{new Date(user.deletedAt).toLocaleString('zh-CN',{timeZone,timeZoneName:'short'})}</time>
            : user.emailConfirmed?'邮箱已验证':'邮箱待验证'}</td>
          <td>{user.role ? roleNames[user.role] : '普通用户'}</td>
          {data.canWrite && <><td>{user.wallet ? <>
            余额 {money(user.wallet.balanceMicros)}<br/>
            用量预占 {money(user.wallet.heldMicros)}<br/>
            退款冻结 {money(user.wallet.refundHeldMicros)}
          </> : '尚未开户'}</td><td>{user.status==='deleted' ? '已归档' : data.actorId===user.id ? '当前账号' : <>
            <button disabled={busy || !!inviteLink || user.status==='auth_blocked'} onClick={()=>openEditor('state',user)}>{user.suspended?'恢复':'停用'}</button>{' '}
            <button disabled={busy || !!inviteLink} onClick={()=>openEditor('role',user)}>变更角色</button>{' '}
            <button className="danger" disabled={busy || !!inviteLink} onClick={()=>openEditor('delete',user)}>删除</button>
          </>}</td></>}
        </tr>)}</tbody>
      </table></div>}
      <div className="actions">
        <button disabled={busy || !cursors.length} onClick={()=>{setCursors(old=>old.slice(0,-1));setEditor(null);}}>上一页</button>
        <button disabled={busy || !data?.nextCursor} onClick={()=>{
          if (data?.nextCursor) { setCursors(old=>[...old,data.nextCursor!]);setEditor(null); }
        }}>下一页</button>
      </div>
    </section>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {data?.canWrite && editor && <form className="panel" key={editor.kind+editor.user.id} onSubmit={submit}>
      <h2>{editor.kind==='delete' ? '删除 OpenToken 账号' : editor.kind==='role' ? '变更后台角色'
        : editor.user.suspended ? '恢复账号' : '停用账号'}</h2>
      <p>{editor.user.email ?? editor.user.id}</p>
      <fieldset disabled={busy}>
        {editor.kind==='role' && <label>后台角色<select name="role" defaultValue={editor.user.role??''}>
          <option value="">普通用户</option>
          {Object.entries(roleNames).map(([role,name])=><option key={role} value={role}
            disabled={editor.user.status!=='active' && role!==editor.user.role}>{name}</option>)}
        </select></label>}
        {editor.kind==='state' && <p>{editor.user.suspended
          ? '用户可重新登录，原来有效的 API 密钥将恢复。'
          : '控制台和 API 将停止接收此账号的新请求。已受理的调用仍会结算。'}</p>}
        {editor.kind==='delete' && <>
          <p className="error">删除后无法恢复，API 密钥与后台角色将撤销。钱包、订单和历史账单会保留。</p>
          <p>目标用户 ID <code>{editor.user.id}</code></p>
          <label>输入目标用户 ID 确认删除<input name="confirmation" required maxLength={36} autoComplete="off" spellCheck={false}/></label>
        </>}
        <label>变更原因<input name="reason" required minLength={3} maxLength={160}/></label>
        <div className="actions"><button className={editor.kind==='delete'?'danger':'primary'}>
          {editor.kind==='delete'?'确认删除':'确认变更'}</button><button type="button" onClick={()=>setEditor(null)}>取消</button></div>
      </fieldset>
    </form>}
    {data?.canInvite && inviting && <section className="panel">
      <h2>邀请普通用户</h2>
      {inviteLink ? <>
        <p>链接只显示一次。请通过私密渠道交给收件人，关闭后无法再次查看。</p>
        <label>邀请链接<input readOnly value={inviteLink} onFocus={event=>event.currentTarget.select()}/></label>
        <div className="actions"><button onClick={async()=>{
          try { await navigator.clipboard.writeText(inviteLink); setNotice('链接已复制。'); }
          catch { setError('复制未完成，请手动选中并复制链接。'); }
        }}>复制链接</button><button onClick={clearInvite}>关闭</button></div>
      </> : <form onSubmit={submit}>
        <label>收件邮箱<input type="email" required maxLength={254} disabled={busy} value={inviteEmail}
          onChange={event=>{setInviteEmail(event.target.value);setOperationId('');}}/></label>
        {operationId && <p>邀请编号 <code>{operationId}</code></p>}
        <div className="actions"><button className="primary" disabled={busy}>{operationId?'核对邀请':'签发链接'}</button>
          <button type="button" disabled={busy} onClick={clearInvite}>取消</button></div>
      </form>}
    </section>}
  </>;
}
