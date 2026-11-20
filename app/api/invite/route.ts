import type { NextRequest } from 'next/server';
import { completeInvite } from '@/lib/invite';
import { appOrigin, createAuthClient } from '@/lib/session';

export const runtime = 'nodejs';

export function POST(req: NextRequest) {
  return completeInvite(req,appOrigin(req),() => createAuthClient().auth);
}
