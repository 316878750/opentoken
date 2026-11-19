import { NextRequest, NextResponse } from 'next/server';
import { appOrigin, endSession, sessionCookie, setSession } from '@/lib/session';

export async function POST(req: NextRequest) {
  const origin = appOrigin(req);
  if (!origin || req.headers.get('origin') !== origin) {
    return new NextResponse(null,{status:403});
  }
  await endSession(req.cookies.get(sessionCookie)?.value).catch(() => console.error('Supabase session revoke failed'));
  const res = NextResponse.redirect(new URL('/login',origin),303);
  setSession(res,origin);
  return res;
}
