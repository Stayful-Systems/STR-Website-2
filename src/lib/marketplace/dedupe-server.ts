import 'server-only';

/**
 * Deal feed (queue Batch 1): keeps marketplace_deals.dupe_of up to date. Run at the end
 * of the sweep and of the hourly recheck, so a new twin is marked within the hour and a
 * twin whose original has gone comes back. The pointers are kept whether or not
 * deal_dedupe_enabled is on, so /admin/deals can show how many would be hidden before
 * the switch is turned on; only the grid query (queries.ts) honours the switch.
 *
 * Never logs an address: counts only.
 */
import { chunk, type Admin } from './server';
import { dupeChanges, fullPostcode, planDupes, type DupeRow } from './dedupe';

const PAGE = 1000;
const SNAPSHOT_CHUNK = 150;
const WRITE_BATCH = 20;
/** One run writes at most this many changes; the next hour carries on, so a first run on a big pool is bounded. */
const MAX_WRITES = 1500;

export interface DupeRefresh {
  /** Live rows read. */
  live: number;
  /** Pointers written this run. */
  changed: number;
  /** Live rows now pointing at an earlier twin (hidden when the switch is on). */
  hidden: number;
  /** Set when nothing was done: 'schema' when the Deal feed block has not been run. */
  skipped?: 'schema' | 'error';
}

interface LiveRow {
  canonical_url: string;
  kind: string;
  postcode_area: string | null;
  bedrooms: number | null;
  raw_type: string | null;
  price_amount: number | string | null;
  first_seen_at: string;
  uprn: string | null;
  dupe_of: string | null;
}

const isMissingColumn = (e: { code?: string; message?: string } | null): boolean => Boolean(e && (e.code === '42703' || e.code === 'PGRST204' || /does not exist|could not find/i.test(e.message ?? '')));

export async function refreshDupes(admin: Admin, pct: number, tag = 'marketplace-dedupe'): Promise<DupeRefresh> {
  const live: LiveRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('marketplace_deals')
      .select('canonical_url, kind, postcode_area, bedrooms, raw_type, price_amount, first_seen_at, uprn, dupe_of')
      .eq('status', 'live')
      .order('canonical_url', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingColumn(error)) return { live: 0, changed: 0, hidden: 0, skipped: 'schema' };
      console.error(`[${tag}] live read failed:`, error.code ?? 'error');
      return { live: 0, changed: 0, hidden: 0, skipped: 'error' };
    }
    live.push(...((data ?? []) as unknown as LiveRow[]));
    if ((data?.length ?? 0) < PAGE) break;
  }

  // The full postcode is only in the stored listing, so it is read for the rows that have
  // a possible twin (same kind, beds, type and postcode area) and no others.
  const groups = new Map<string, LiveRow[]>();
  for (const r of live) {
    if (r.postcode_area === null || r.bedrooms === null || !r.raw_type || r.price_amount === null) continue;
    const k = `${r.kind}|${r.bedrooms}|${r.raw_type.trim().toLowerCase()}|${r.postcode_area}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const needPostcode = [...groups.values()].filter((g) => g.length > 1).flat().map((r) => r.canonical_url);
  const postcodes = new Map<string, string | null>();
  for (const some of chunk(needPostcode, SNAPSHOT_CHUNK)) {
    const { data, error } = await admin.from('sourced_listings').select('canonical_url, postcode:snapshot->>postcode').in('canonical_url', some);
    if (error) {
      console.error(`[${tag}] postcodes unreadable:`, error.code ?? 'error');
      continue;
    }
    for (const r of (data ?? []) as unknown as { canonical_url: string; postcode: string | null }[]) postcodes.set(r.canonical_url, fullPostcode(r.postcode));
  }

  const rows: DupeRow[] = live.map((r) => ({ canonical_url: r.canonical_url, kind: r.kind, uprn: r.uprn, bedrooms: r.bedrooms, raw_type: r.raw_type, postcode: postcodes.get(r.canonical_url) ?? null, price_amount: r.price_amount, first_seen_at: r.first_seen_at }));
  const plan = planDupes(rows, pct);
  const changes = dupeChanges(plan, new Map(live.map((r) => [r.canonical_url, r.dupe_of])));
  let changed = 0;
  const todo = changes.slice(0, MAX_WRITES);
  for (const batch of chunk(todo, WRITE_BATCH)) {
    const results = await Promise.all(batch.map((c) => admin.from('marketplace_deals').update({ dupe_of: c.dupe_of }).eq('canonical_url', c.canonical_url).eq('status', 'live')));
    for (const res of results) {
      if (res.error) console.error(`[${tag}] pointer write failed:`, res.error.code ?? 'error');
      else changed += 1;
    }
  }
  // Pointers from rows that are no longer live (retired, back to pending) are cleared by the retire itself (retireDeal) or here.
  const stale = await admin.from('marketplace_deals').update({ dupe_of: null }).not('dupe_of', 'is', null).neq('status', 'live');
  if (stale.error) console.error(`[${tag}] stale pointer clear failed:`, stale.error.code ?? 'error');
  const hidden = [...plan.values()].filter((v) => v !== null).length;
  return { live: live.length, changed, hidden };
}

/** Live deals currently marked as a duplicate of an earlier one; null when the column is not there yet. */
export async function hiddenDuplicateCount(admin: Admin): Promise<number | null> {
  const { count, error } = await admin.from('marketplace_deals').select('canonical_url', { count: 'exact', head: true }).eq('status', 'live').not('dupe_of', 'is', null);
  return error ? null : (count ?? 0);
}
