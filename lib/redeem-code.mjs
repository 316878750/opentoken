import { createHash, randomBytes } from 'node:crypto';

export const redeemCodePattern = /^otc_[A-Za-z0-9_-]{32}$/;

export function redeemCodeDigest(code) {
  return createHash('sha256').update(code).digest();
}

export function generateRedeemCode() {
  return 'otc_' + randomBytes(24).toString('base64url');
}

export function redeemAmountMicros(usd) {
  if (typeof usd !== 'string' || !/^\d{1,13}(\.\d{1,6})?$/.test(usd)) return null;
  const [whole,fraction=''] = usd.split('.');
  const micros = BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0'));
  return micros>0n && micros<=9_223_372_036_854_775_807n ? micros.toString() : null;
}
