/**
 * Batch 37: the link token for the export page (/t/export/<token>).
 *
 * The zip is built from a normal render of the customer's website, so the render
 * route must only answer the server that asked for it. The token proves that: it
 * names one transfer, is good for 15 minutes, and is an HMAC-SHA256 over
 * `${transferId}.${exp}`.
 *
 *   token   <transfer id>.<expiry, unix seconds>.<signature, base64url>
 *
 * The key comes from the environment exactly as the other signed links do
 * (src/lib/crypto/sign.ts: DEALS_PHOTO_SECRET, else INTERNAL_API_SECRET, 16+
 * characters; step-token.ts uses the same source). No key means no token: sign
 * returns null and verify returns null. `key` is for tests.
 *
 * The token is never logged. Verification compares in constant time and never
 * says why it refused.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** A token is good for 15 minutes. */
export const TRANSFER_TOKEN_TTL_SECONDS = 15 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKEN_LENGTH = 200;

export interface TransferTokenOptions {
  /** Tests only: an explicit key instead of the environment's. */
  key?: string;
}

function keyFromEnv(): string | null {
  const key = process.env.DEALS_PHOTO_SECRET || process.env.INTERNAL_API_SECRET;
  return key && key.length >= 16 ? key : null;
}

const macOf = (key: string, transferId: string, exp: number): string => createHmac('sha256', key).update(`${transferId}.${exp}`).digest('base64url');

/** A token for this transfer, or null when it cannot be made (bad id, no key). */
export function signTransferToken(transferId: string, now: Date, opts: TransferTokenOptions = {}): string | null {
  if (!UUID.test(transferId)) return null;
  const key = opts.key !== undefined ? opts.key : keyFromEnv();
  if (!key) return null;
  const exp = Math.floor(now.getTime() / 1000) + TRANSFER_TOKEN_TTL_SECONDS;
  return `${transferId}.${exp}.${macOf(key, transferId, exp)}`;
}

/** The transfer id a token was issued for, or null (malformed, tampered, expired, no key). Never throws. */
export function verifyTransferToken(token: unknown, now: Date, opts: TransferTokenOptions = {}): string | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [transferId, expRaw, signature] = parts;
  if (!UUID.test(transferId) || !/^\d{1,12}$/.test(expRaw) || !signature) return null;
  const key = opts.key !== undefined ? opts.key : keyFromEnv();
  if (!key) return null;
  const exp = Number(expRaw);
  const expected = Buffer.from(macOf(key, transferId, exp));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (exp * 1000 < now.getTime()) return null;
  return transferId;
}
