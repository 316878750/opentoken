import { createHash } from 'node:crypto';

export const redeemCodePattern = /^otc_[A-Za-z0-9_-]{32}$/;

export function redeemCodeDigest(code) {
  return createHash('sha256').update(code).digest();
}
