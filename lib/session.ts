import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { digest, userId } from './data';

export const sessionCookie = 'model_gateway_demo';
export const sessionSeconds = 8 * 60 * 60;

function equal(a: string, b: string) {
  const sha = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(sha(a),sha(b));
}

export function validLogin(email: string, password: string) {
  return email.trim().toLowerCase() === (process.env.DEMO_EMAIL || 'demo@example.test').toLowerCase() &&
    equal(password,process.env.DEMO_PASSWORD || 'local-demo-only');
}

export async function newSession() {
  const payload = `${Math.floor(Date.now()/1000)+sessionSeconds}.${randomBytes(16).toString('hex')}`;
  return payload + '.' + (await digest('session',payload)).toString('base64url');
}

export async function sessionUser(value: string | undefined) {
  const match = /^(\d{10})\.([0-9a-f]{32})\.([a-zA-Z0-9_-]{43})$/.exec(value || '');
  if (!match || Number(match[1]) <= Math.floor(Date.now()/1000)) return null;
  const expected = (await digest('session',match[1]+'.'+match[2])).toString('base64url');
  return equal(match[3],expected) ? userId : null;
}
