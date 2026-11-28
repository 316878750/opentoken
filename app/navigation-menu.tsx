'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export function NavigationMenu({children}:{children:ReactNode}) {
  const [ready,setReady] = useState(false);
  const [open,setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(()=>setReady(true),[]);
  return <div className="navigation-menu" onKeyDown={event=>{
    if (event.key==='Escape' && open && toggle.current?.getClientRects().length) {
      setOpen(false);
      toggle.current.focus();
    }
  }}>
    <button ref={toggle} className="menu-toggle" type="button" hidden={!ready}
      aria-controls="module-navigation" aria-expanded={open} onClick={()=>setOpen(!open)}>菜单</button>
    <div id="module-navigation">{children}</div>
  </div>;
}
