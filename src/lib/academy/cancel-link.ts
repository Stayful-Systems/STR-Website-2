/**
 * The Academy reminder email's one-tap cancel link (Batch 31a, Zac's Q4).
 * Stripe portal links expire within minutes, so the email carries our own
 * signed link instead: `/api/billing/academy/cancel?t=<sub>.<exp>.<sig>`,
 * valid until the trial ends, which opens a fresh portal "cancel this
 * subscription" flow without signing in. Signed with the key in
 * src/lib/crypto/sign.ts (DEALS_PHOTO_SECRET, else INTERNAL_API_SECRET); the
 * signed id is namespaced so no other signed URL can stand in for it.
 *
 * `…With` take the key explicitly (tested); the others read it from the env.
 */
import { expiringPayload, signPayload, signWith, verifyExpiring, verifyExpiringFromEnv } from '../crypto/sign.ts';
import { siteUrl } from '../url.ts';

export const ACADEMY_CANCEL_PATH = '/api/billing/academy/cancel';

const SUB_ID = /^sub_[A-Za-z0-9]{1,250}$/;

function signedId(subscriptionId: string): string {
  return `academy-cancel:${subscriptionId}`;
}

function expSeconds(trialEndsAt: Date): number {
  return Math.floor(trialEndsAt.getTime() / 1000);
}

function parse(token: string | null | undefined): { subId: string; exp: string; sig: string } | null {
  if (!token || token.length > 400) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [subId, exp, sig] = parts;
  if (!SUB_ID.test(subId) || !/^\d{1,12}$/.test(exp) || !sig) return null;
  return { subId, exp, sig };
}

export function academyCancelTokenWith(key: string, subscriptionId: string, trialEndsAt: Date): string {
  const exp = expSeconds(trialEndsAt);
  return `${subscriptionId}.${exp}.${signWith(key, expiringPayload(signedId(subscriptionId), exp))}`;
}

export function verifyAcademyCancelTokenWith(key: string, token: string | null | undefined, now: Date = new Date()): { subId: string } | null {
  const t = parse(token);
  if (!t) return null;
  return verifyExpiring(key, signedId(t.subId), t.exp, t.sig, now) ? { subId: t.subId } : null;
}

/** The token signed with the configured key, or null when no signing key is set. */
export function academyCancelToken(subscriptionId: string, trialEndsAt: Date): string | null {
  const exp = expSeconds(trialEndsAt);
  const sig = signPayload(expiringPayload(signedId(subscriptionId), exp));
  return sig ? `${subscriptionId}.${exp}.${sig}` : null;
}

/**
 * The link for the reminder email. Without a signing key it falls back to
 * Account → Billing (sign in, then Manage or cancel), so the email always has
 * a working way to cancel.
 */
export function academyCancelUrl(subscriptionId: string, trialEndsAt: Date): string {
  const token = academyCancelToken(subscriptionId, trialEndsAt);
  return token ? `${siteUrl(ACADEMY_CANCEL_PATH)}?t=${encodeURIComponent(token)}` : siteUrl('/account/billing');
}

/** The trial subscription a link is for, or null when it is malformed, forged or past the trial end. */
export function verifyAcademyCancelToken(token: string | null | undefined, now: Date = new Date()): { subId: string } | null {
  const t = parse(token);
  if (!t) return null;
  return verifyExpiringFromEnv(signedId(t.subId), t.exp, t.sig, now) ? { subId: t.subId } : null;
}
