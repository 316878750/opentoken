export function ListPager({page,count,onPrevious,onNext,disabled=false}:{
  page:number;count?:number;onPrevious?:()=>void;onNext?:()=>void;disabled?:boolean;
}) {
  return <div className="list-pager">
    <span aria-live="polite">第 {page} 页{count!==undefined && ` · 本页 ${count} 条`}</span>
    <div className="actions">
      <button type="button" disabled={disabled || !onPrevious} onClick={onPrevious}>上一页</button>
      <button type="button" disabled={disabled || !onNext} onClick={onNext}>下一页</button>
    </div>
  </div>;
}

export function ActionFeedback({busy,message,error}:{busy:boolean;message?:string;error?:string}) {
  return <>
    {error && <p className="error" role="alert">{error}</p>}
    {(busy || message) && <p className={busy?'feedback-pending':'feedback-result'} role="status">
      {busy?'正在处理，请稍候…':message}</p>}
  </>;
}
