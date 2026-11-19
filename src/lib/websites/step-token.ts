/**
 * Batch 31: the step token that joins a website's two form steps.
 *
 * Step 1 saves the landlord's contact details and answers with this token;
 * step 2 sends it back with the address. It proves the caller is the browser
 * that did step 1, for THIS lead on THIS website, for the next 30 minutes, so
 * nobody can run a report (or save an address) against a lead id they guessed.
 *
 * Built on src/lib/crypto/sign.ts (expiringPayload / verifyExpiring), with a
 * purpose prefix on the signed id so a signature made for anything else the
 * signer signs (a deal photo, say) can never pass as a step token:
 *
 *   signed id   website-step:<lead id>:<website id>
 *   token       <lead id>.<website id>.<expiry, unix seconds>.<signature>
 *
 * The token travels in a POST body only. It is never put in a URL, a cookie,
 * a header or a log line (step-token.test.ts and the route pins hold that).
 *
 * `key` is for tests; left out, the signing key comes from the environment
 * exactly as the other signed links do, and no key means no token (fail closed).
 *
 * Server-side only by use, but pure by construction: no network, no database.
 */
import { signWith, signPayload, verifyExpiring, verifyExpiringFromEnv, expiringPayload } from '../crypto/sign.ts';

/** The purpose prefix on the signed id. */
export const STEP_TOKEN_PURPOSE = 'website-step:';

/** A step token is good for 30 minutes. */
export const STEP_TOKEN_TTL_SECONDS = 30 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Anything longer is not ours: the real thing is about 120 characters. */
const MAX_TOKEN_LENGTH = 300;

export interface StepTokenOptions {
  /** Tests only. */
  now?: Date;
  /** Tests only: an explicit key instead of the environment's. */
  key?: string;
}

export interface StepTokenClaims {
  leadId: string;
  websiteId: string;
}

function idOf(leadId: string, websiteId: string): string {
  return `${STEP_TOKEN_PURPOSE}${leadId}:${websiteId}`;
}

/** A token for this lead on this website, or null when it cannot be made (bad ids, no signing key). */
export function issueStepToken(claims: StepTokenClaims, opts: StepTokenOptions = {}): string | null {
  if (!UUID.test(claims.leadId) || !UUID.test(claims.websiteId)) return null;
  const now = opts.now ?? new Date();
  const exp = Math.floor(now.getTime() / 1000) + STEP_TOKEN_TTL_SECONDS;
  const payload = expiringPayload(idOf(claims.leadId, claims.websiteId), exp);
  const signature = opts.key !== undefined ? signWith(opts.key, payload) : signPayload(payload);
  if (!signature) return null;
  return `${claims.leadId}.${claims.websiteId}.${exp}.${signature}`;
}

/**
 * The lead and website a token was issued for, or null when it is malformed,
 * tampered with, expired, or signed for another purpose. Never throws, and
 * never says why: the route answers every refusal the same way.
 */
export function readStepToken(token: unknown, opts: StepTokenOptions = {}): StepTokenClaims | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [leadId, websiteId, exp, signature] = parts;
  if (!UUID.test(leadId) || !UUID.test(websiteId) || !/^\d{1,12}$/.test(exp) || !signature) return null;
  const id = idOf(leadId, websiteId);
  const now = opts.now ?? new Date();
  const ok = opts.key !== undefined ? verifyExpiring(opts.key, id, exp, signature, now) : verifyExpiringFromEnv(id, exp, signature, now);
  return ok ? { leadId, websiteId } : null;
}
