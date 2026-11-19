import { NextRequest, NextResponse } from 'next/server';
import { sessionCookie } from '@/lib/session';

export function POST(req: NextRequest) {
  if (req.headers.get('origin') !== 'http://' + req.headers.get('host')) {
    return new NextResponse(null,{status:403});
  }
  const res = NextResponse.redirect(new URL('/login',req.url),303);
  res.cookies.set(sessionCookie,'',{path:'/',httpOnly:true,sameSite:'strict',maxAge:0});
  return res;
}
