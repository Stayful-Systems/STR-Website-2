/**
 * Deal feed (queue Batch 1): light duplicate matching across portals. The same
 * home is often on Rightmove, OnTheMarket and Zoopla at once; the grid shows it
 * once. Pure, so the rule is tested rather than trusted.
 *
 * A live row is a duplicate of an EARLIER-seen live row (first_seen_at, then
 * canonical_url as the tie-break) when either:
 *   - both have a UPRN and the UPRNs are equal (and both are sales, or both rentals:
 *     the same property for sale and to rent is two different deals), or
 *   - kind, bedrooms, property type and the full postcode are all equal and the
 *     price is within `pct` percent of the earlier row's price.
 * A missing value never matches (no bedrooms, no type, no price, only an outcode).
 *
 * Known cost: a new-build block can have several flats with the same postcode,
 * beds, type and price. Switching deal_dedupe_enabled off undoes it at once.
 */

export interface DupeRow {
  canonical_url: string;
  kind: string;
  uprn?: string | null;
  bedrooms: number | null;
  raw_type: string | null;
  /** The full postcode ("YO24 1AB"); an outcode or area alone is not enough to match on. */
  postcode?: string | null;
  price_amount: number | string | null;
  first_seen_at: string;
}

const FULL_POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}$/;

/** "yo24  1ab" → "YO24 1AB"; null when it is not a full postcode. */
export function fullPostcode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');
  const spaced = `${s.slice(0, -3)} ${s.slice(-3)}`;
  return FULL_POSTCODE.test(spaced) ? spaced : null;
}

function uprnOf(r: Pick<DupeRow, 'uprn'>): string | null {
  const u = typeof r.uprn === 'string' ? r.uprn.trim() : '';
  return u === '' ? null : u;
}

function typeOf(r: Pick<DupeRow, 'raw_type'>): string | null {
  const t = (r.raw_type ?? '').trim().toLowerCase();
  return t === '' ? null : t;
}

function priceOf(r: Pick<DupeRow, 'price_amount'>): number | null {
  if (r.price_amount === null || r.price_amount === undefined || r.price_amount === '') return null;
  const n = Number(r.price_amount);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The first-seen order: earlier first; a tie goes to the smaller canonical_url so it is always the same row. */
export function seenBefore(a: Pick<DupeRow, 'first_seen_at' | 'canonical_url'>, b: Pick<DupeRow, 'first_seen_at' | 'canonical_url'>): boolean {
  const ta = Date.parse(a.first_seen_at);
  const tb = Date.parse(b.first_seen_at);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta < tb;
  return a.canonical_url < b.canonical_url;
}

/** Whether `other` (the earlier row) is a twin of `row` under the rule above. */
export function isTwin(row: DupeRow, other: DupeRow, pct: number): boolean {
  if (other.canonical_url === row.canonical_url || other.kind !== row.kind) return false;
  const u = uprnOf(row);
  if (u !== null && u === uprnOf(other)) return true;
  const pc = fullPostcode(row.postcode);
  const type = typeOf(row);
  const price = priceOf(row);
  const otherPrice = priceOf(other);
  if (pc === null || type === null || price === null || otherPrice === null || row.bedrooms === null) return false;
  if (pc !== fullPostcode(other.postcode) || type !== typeOf(other) || row.bedrooms !== other.bedrooms) return false;
  return Math.abs(price - otherPrice) <= (pct / 100) * otherPrice + 1e-9;
}

/**
 * The canonical_url of the earliest-seen live row that `row` duplicates, or null when it
 * is the original (or has no twin). `liveRows` may include the row itself.
 */
export function findDupe(row: DupeRow, liveRows: readonly DupeRow[], pct: number): string | null {
  let best: DupeRow | null = null;
  for (const other of liveRows) {
    if (!seenBefore(other, row) || !isTwin(row, other, pct)) continue;
    if (best === null || seenBefore(other, best)) best = other;
  }
  return best?.canonical_url ?? null;
}

/**
 * Every live row's duplicate pointer (null for an original). Buckets rows so a pool of
 * thousands is not compared pairwise: by UPRN, and by kind|beds|type|postcode.
 */
export function planDupes(liveRows: readonly DupeRow[], pct: number): Map<string, string | null> {
  const byUprn = new Map<string, DupeRow[]>();
  const byKey = new Map<string, DupeRow[]>();
  const push = (m: Map<string, DupeRow[]>, k: string, r: DupeRow) => {
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  };
  const attrKey = (r: DupeRow): string | null => {
    const pc = fullPostcode(r.postcode);
    const type = typeOf(r);
    return pc && type && r.bedrooms !== null ? `${r.kind}|${r.bedrooms}|${type}|${pc}` : null;
  };
  for (const r of liveRows) {
    const u = uprnOf(r);
    if (u) push(byUprn, `${r.kind}|${u}`, r);
    const k = attrKey(r);
    if (k) push(byKey, k, r);
  }
  const out = new Map<string, string | null>();
  for (const r of liveRows) {
    const u = uprnOf(r);
    const k = attrKey(r);
    const candidates = [...(u ? (byUprn.get(`${r.kind}|${u}`) ?? []) : []), ...(k ? (byKey.get(k) ?? []) : [])];
    out.set(r.canonical_url, findDupe(r, candidates, pct));
  }
  return out;
}

/** Only the rows whose pointer changes: what to write. `current` is each row's stored dupe_of. */
export function dupeChanges(plan: ReadonlyMap<string, string | null>, current: ReadonlyMap<string, string | null>): { canonical_url: string; dupe_of: string | null }[] {
  const out: { canonical_url: string; dupe_of: string | null }[] = [];
  for (const [url, next] of plan) if ((current.get(url) ?? null) !== next) out.push({ canonical_url: url, dupe_of: next });
  return out;
}
