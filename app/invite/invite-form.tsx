'use client';

import { useEffect, useState, type FormEvent } from 'react';

export function InviteForm({pendingSetup}: {pendingSetup: boolean}) {
  const [token,setToken] = useState<string|null>();
  const [canRetry,setCanRetry] = useState(pendingSetup);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const canSetPassword = Boolean(token) || canRetry;

  useEffect(() => {
    const {hash} = window.location;
    if (hash) window.history.replaceState(window.history.state,'','/invite');
    const match = /^#token_hash=([a-f0-9]{56})$/.exec(hash);
    setToken(current => current===undefined ? match?.[1] ?? null : current);
  },[]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSetPassword || busy) return;
    const form = new FormData(event.currentTarget);
    const password = form.get('password');
    if (password!==form.get('confirmation')) {
      setError('两次输入的密码不一致。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/invite',{
        method:'POST',cache:'no-store',credentials:'same-origin',redirect:'error',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({token_hash:token ?? undefined,password}),signal:AbortSignal.timeout(35_000),
      });
      if (response.ok) {
        window.location.replace('/login');
        return;
      }
      const body = await response.json();
      setError(body.error?.message || '请求暂时无法完成，请稍后重试。');
      if (response.status===401 || response.status===409) {
        setToken(null);
        setCanRetry(response.status===409);
      }
    } catch {
      setError('未能确认密码设置结果。请尝试登录，或联系试点运营。');
    } finally {
      setBusy(false);
    }
  }

  return <div className="panel">
    <span className="badge">OpenToken</span>
    <div className="heading"><h1>设置试点账号密码</h1>
      {canSetPassword && <p>设置完成后，使用受邀邮箱和新密码登录。</p>}
    </div>
    {token===undefined && !canRetry && <p className="muted" role="status">正在读取邀请链接…</p>}
    {token===null && !canRetry && !error && <p>请打开试点运营提供的完整邀请链接。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {canSetPassword && <form action="/api/invite" method="post" onSubmit={submit}>
      <label>新密码<input type="password" name="password" autoComplete="new-password" minLength={12} maxLength={72} required /></label>
      <label>确认新密码<input type="password" name="confirmation" autoComplete="new-password" minLength={12} maxLength={72} required /></label>
      <button className="primary" type="submit" disabled={busy}>{busy ? '正在设置…' : '设置密码'}</button>
    </form>}
    <noscript><p>请启用 JavaScript 后重新打开邀请链接。</p></noscript>
    <p><a href="/login">前往登录</a></p>
  </div>;
}
