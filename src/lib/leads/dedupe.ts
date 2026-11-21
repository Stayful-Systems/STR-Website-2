/**
 * Batch 21 (C3, D10): the two windows the lead store keys on.
 *
 *   - A prospect who submits the same funnel for the same property with the
 *     same email inside REUSE_WINDOW_MS is the same enquiry: the first lead is
 *     reused (its report resent if it ran, run once if it is still queued),
 *     never a second lead and a second charge.
 *   - A queued lead is claimed with a lease before its report is run, so two
 *     drains (or the funnel and the drain) cannot both run and charge it. A
 *     lease is `updated_at` moved to now; a lead touched inside
 *     QUEUED_LEASE_MS is left alone, which also covers a run killed mid-way.
 *
 * Pure: no network, no database, no server-only.
 */

export const REUSE_WINDOW_MS = 60 * 60 * 1000;
export const QUEUED_LEASE_MS = 5 * 60 * 1000;

/** Leads created at or after this are candidates for reuse. */
export function reuseSince(now: Date): string {
  return new Date(now.getTime() - REUSE_WINDOW_MS).toISOString();
}

/** A queued lead last touched before this may be claimed. */
export function leaseCutoff(now: Date): string {
  return new Date(now.getTime() - QUEUED_LEASE_MS).toISOString();
}

// ── Batch 35: the same landlord, by sheet row or website form ─────────────
//
// Same owner (the caller scopes by owner) + same postcode + (same email or
// same phone), inside a window of days: the later one joins the earlier lead.
// Separate from the one-hour website reuse above, which is untouched.

export const DAY_MS = 24 * 60 * 60 * 1000;

export type LandlordKey = {
  postcode: string | null | undefined;
  email: string | null | undefined;
  phone: string | null | undefined;
  /** When it arrived (a Date, an ISO string or epoch ms). */
  at: Date | string | number;
};

function postcodeKey(v: string | null | undefined): string | null {
  const t = (v ?? '').replace(/\s+/g, '').toUpperCase();
  return t || null;
}
function emailKey(v: string | null | undefined): string | null {
  const t = (v ?? '').trim().toLowerCase();
  return t || null;
}
function phoneKey(v: string | null | undefined): string | null {
  const t = (v ?? '').replace(/[^0-9+]/g, '');
  if (!t) return null;
  // 07… and +447… and 00447… are one number.
  if (t.startsWith('+44')) return '0' + t.slice(3);
  if (t.startsWith('0044')) return '0' + t.slice(4);
  if (t.startsWith('44') && t.length >= 12) return '0' + t.slice(2);
  return t;
}
function ms(at: Date | string | number): number {
  return at instanceof Date ? at.getTime() : new Date(at).getTime();
}

/** Both must have a postcode; then a shared email or a shared phone, within the window. */
export function sameLandlord(a: LandlordKey, b: LandlordKey, windowDays: number): boolean {
  const pa = postcodeKey(a.postcode);
  if (!pa || pa !== postcodeKey(b.postcode)) return false;
  const ta = ms(a.at);
  const tb = ms(b.at);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  if (Math.abs(ta - tb) > windowDays * DAY_MS) return false;
  const ea = emailKey(a.email);
  const pha = phoneKey(a.phone);
  return (ea !== null && ea === emailKey(b.email)) || (pha !== null && pha === phoneKey(b.phone));
}

/** Leads created at or after this are candidates to join. */
export function sameLandlordSince(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export type LandlordLeadRow = {
  id: string;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  created_at: string;
};

/**
 * The newest row that is the same landlord as `cand` (arriving at `now`) inside
 * the window. The store loads one owner's recent, un-archived rows; this picks.
 */
export function pickSameLandlord(
  rows: readonly LandlordLeadRow[],
  cand: Pick<LandlordKey, 'postcode' | 'email' | 'phone'>,
  days: number,
  now: Date,
): LandlordLeadRow | null {
  const since = sameLandlordSince(now, days).getTime();
  let best: LandlordLeadRow | null = null;
  for (const r of rows) {
    const t = new Date(r.created_at).getTime();
    if (!Number.isFinite(t) || t < since) continue;
    if (!sameLandlord({ ...cand, at: now }, { postcode: r.postcode, email: r.email, phone: r.phone, at: r.created_at }, days)) continue;
    if (!best || t > new Date(best.created_at).getTime()) best = r;
  }
  return best;
}
