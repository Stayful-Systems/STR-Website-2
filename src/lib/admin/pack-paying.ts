import { csvCell } from '../api/csv.ts';

/**
 * Batch 29, section F: "Pack → paying" on /admin/weekly-active. Pure: the
 * facts come from public.pack_paying_facts (one row per granted starter pack
 * buyer), the page and the CSV both read what this file works out.
 *
 * Cohorts are UK sign-up weeks (Monday). The columns, per cohort:
 *   1 bought       bought the pack
 *   2 firstWeek    active (a weekly-active day) in their first 7 UK days from sign-up
 *   3 contacted    moved a deal to Contacted or later within 30 days of the pack
 *   4 ranDown      their balance ran down to the £5 line (low_credit_pence) within 45 days of the pack
 *   5 paidAfterRun paid again within 14 days of step 4 (as a share of step 4)
 *   6 paid60       paid again within 60 days of the pack: the headline
 *   7 third        paid a third time (the pack, then two more payments) so far
 *   8 cost         raw data cost per pack-only member (never paid again): average, p90, max
 * "Paid again" is a top-up (chosen or automatic) or a plan's paid invoice.
 *
 * A column says "too early" until its window has closed for the cohort's
 * latest buyer: 7 days from sign-up (2), 30 days from the pack (3), 45 (4),
 * 59 (5: 45 + 14), 60 (6, 7 and who counts as pack-only for 8). The total row
 * adds up only the cohorts whose window has closed.
 */

export interface PackFact {
  u: string;
  email: string | null;
  excluded: boolean;
  signedUpAt: string;
  /** The UK Monday of the sign-up week (YYYY-MM-DD). */
  weekStart: string;
  packAt: string;
  campaign: string | null;
  content: string | null;
  firstWeekActive: boolean;
  contactedAt: string | null;
  ranDownAt: string | null;
  /** Further payments after the pack, oldest first. */
  paid: string[];
  /** Raw data cost so far, pence (may be fractional). */
  rawCostPence: number;
}

export interface PackPayingTargets {
  headlineFloorPct: number;
  headlineTargetPct: number;
  rundownPaidFloorPct: number;
  rundownPaidTargetPct: number;
  costTargetPence: number;
  costCeilingPence: number;
}

export type Rag = 'green' | 'amber' | 'red';

export interface Share {
  count: number;
  base: number;
  /** Whole-percent share, or null when the base is 0. */
  pct: number | null;
}

/** null: too early (the window has not closed for the latest buyer). */
export type Cell = Share | null;

export interface CostCell {
  members: number;
  averagePence: number | null;
  p90Pence: number | null;
  maxPence: number | null;
  /** Some buyer could still pay again (under 60 days): pack-only so far. */
  soFar: boolean;
}

export interface CohortRow {
  weekStart: string;
  bought: number;
  firstWeek: Cell;
  contacted: Cell;
  ranDown: Cell;
  paidAfterRun: Cell;
  paid60: Cell;
  third: Cell;
  cost: CostCell;
}

export interface PackPayingReport {
  cohorts: CohortRow[];
  total: CohortRow;
  buyers: number;
  smallNumbers: boolean;
  headlineRag: Rag | null;
  rundownRag: Rag | null;
  costRag: Rag | null;
  campaigns: string[];
  contents: string[];
}

export const SMALL_NUMBERS = 50;
const DAY = 86_400_000;
export const WINDOWS = { firstWeek: 7, contacted: 30, ranDown: 45, paidAfterRunDays: 14, paidAfterRun: 59, paid60: 60, third: 60, packOnly: 60 } as const;

/** The value used for an untagged buyer in the ad filter. */
export const UNTAGGED = 'none';

function t(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return Date.parse(iso);
}

function share(count: number, base: number): Share {
  return { count, base, pct: base > 0 ? Math.round((count / base) * 100) : null };
}

/** The 90th percentile (nearest rank). */
export function p90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.9 * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

/** Higher is better: green at or above target, amber at or above floor, red below. */
export function ragHigher(pct: number | null, floor: number, target: number): Rag | null {
  if (pct === null) return null;
  return pct >= target ? 'green' : pct >= floor ? 'amber' : 'red';
}

/** Lower is better: green at or under target, amber at or under ceiling, red above. */
export function ragLower(pence: number | null, target: number, ceiling: number): Rag | null {
  if (pence === null) return null;
  return pence <= target ? 'green' : pence <= ceiling ? 'amber' : 'red';
}

/** One buyer's columns, each null while its window is still open for them. */
export function buyerColumns(f: PackFact, now: Date) {
  const n = now.getTime();
  const pack = t(f.packAt);
  const signed = t(f.signedUpAt);
  const closed = (from: number, days: number) => Number.isFinite(from) && from + days * DAY <= n;
  const paid = f.paid.map(t).filter(Number.isFinite).sort((a, b) => a - b);
  const ran = t(f.ranDownAt);
  const ranDown = Number.isFinite(ran) && ran <= pack + WINDOWS.ranDown * DAY;
  return {
    firstWeek: closed(signed, WINDOWS.firstWeek) ? f.firstWeekActive : null,
    contacted: closed(pack, WINDOWS.contacted) ? Number.isFinite(t(f.contactedAt)) && t(f.contactedAt) <= pack + WINDOWS.contacted * DAY : null,
    ranDown: closed(pack, WINDOWS.ranDown) ? ranDown : null,
    paidAfterRun: closed(pack, WINDOWS.paidAfterRun) ? (ranDown ? paid.some((p) => p >= ran && p <= ran + WINDOWS.paidAfterRunDays * DAY) : null) : undefined,
    paid60: closed(pack, WINDOWS.paid60) ? paid.some((p) => p <= pack + WINDOWS.paid60 * DAY) : null,
    third: closed(pack, WINDOWS.third) ? paid.length >= 2 : null,
    /** Never paid again (so far, or for good once 60 days have passed). */
    packOnly: paid.length === 0,
    packOnlySettled: closed(pack, WINDOWS.packOnly),
  };
}

function cohortRow(weekStart: string, facts: readonly PackFact[], now: Date): CohortRow {
  const cols = facts.map((f) => buyerColumns(f, now));
  const cell = (key: 'firstWeek' | 'contacted' | 'ranDown' | 'paid60' | 'third'): Cell => {
    if (cols.some((c) => c[key] === null)) return null;
    return share(cols.filter((c) => c[key] === true).length, cols.length);
  };
  // Step 5: of those who ran down, who paid again within 14 days of it (closed once 59 days have passed for every buyer).
  const afterRun: Cell = cols.some((c) => c.paidAfterRun === undefined) ? null : share(cols.filter((c) => c.paidAfterRun === true).length, cols.filter((c) => c.ranDown === true).length);
  return { weekStart, bought: facts.length, firstWeek: cell('firstWeek'), contacted: cell('contacted'), ranDown: cell('ranDown'), paidAfterRun: afterRun, paid60: cell('paid60'), third: cell('third'), cost: costCell(facts, cols) };
}

function costCell(facts: readonly PackFact[], cols: ReturnType<typeof buyerColumns>[]): CostCell {
  const costs = facts.filter((_, i) => cols[i].packOnly).map((f) => Math.max(0, Number(f.rawCostPence) || 0));
  const soFar = cols.some((c) => c.packOnly && !c.packOnlySettled);
  if (costs.length === 0) return { members: 0, averagePence: null, p90Pence: null, maxPence: null, soFar };
  return { members: costs.length, averagePence: costs.reduce((a, b) => a + b, 0) / costs.length, p90Pence: p90(costs), maxPence: Math.max(...costs), soFar };
}

function addCells(cells: Cell[], baseOf: (c: Share) => number = (c) => c.base): Cell {
  const closed = cells.filter((c): c is Share => c !== null);
  if (closed.length === 0) return null;
  return share(
    closed.reduce((s, c) => s + c.count, 0),
    closed.reduce((s, c) => s + baseOf(c), 0),
  );
}

export interface PackFilter {
  campaign?: string | null;
  content?: string | null;
}

/** Matches the ad filter: a value, UNTAGGED ("none") for no tag, or anything when unset. */
export function matchesFilter(f: Pick<PackFact, 'campaign' | 'content'>, filter: PackFilter): boolean {
  const ok = (value: string | null, want: string | null | undefined) => !want || (want === UNTAGGED ? !value : value === want);
  return ok(f.campaign, filter.campaign) && ok(f.content, filter.content);
}

/** The buyers the section counts: never an excluded account (the page's own list, or "Exclude from metrics"). */
export function countedFacts(facts: readonly PackFact[], excluded: ReadonlySet<string>, filter: PackFilter): PackFact[] {
  return facts.filter((f) => !f.excluded && !excluded.has(f.u) && matchesFilter(f, filter));
}

export function packPayingReport(all: readonly PackFact[], opts: { excluded: ReadonlySet<string>; filter: PackFilter; targets: PackPayingTargets; now: Date }): PackPayingReport {
  const visible = all.filter((f) => !f.excluded && !opts.excluded.has(f.u));
  const tags = (key: 'campaign' | 'content') => [...new Set(visible.map((f) => f[key]).filter((v): v is string => Boolean(v)))].sort();
  const facts = countedFacts(all, opts.excluded, opts.filter);
  const byWeek = new Map<string, PackFact[]>();
  for (const f of facts) byWeek.set(f.weekStart, [...(byWeek.get(f.weekStart) ?? []), f]);
  const cohorts = [...byWeek.entries()].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)).map(([week, rows]) => cohortRow(week, rows, opts.now));
  const cols = facts.map((f) => buyerColumns(f, opts.now));
  const total: CohortRow = {
    weekStart: 'All',
    bought: facts.length,
    firstWeek: addCells(cohorts.map((c) => c.firstWeek)),
    contacted: addCells(cohorts.map((c) => c.contacted)),
    ranDown: addCells(cohorts.map((c) => c.ranDown)),
    paidAfterRun: addCells(cohorts.map((c) => c.paidAfterRun)),
    paid60: addCells(cohorts.map((c) => c.paid60)),
    third: addCells(cohorts.map((c) => c.third)),
    cost: costCell(facts, cols),
  };
  const targets = opts.targets;
  return {
    cohorts,
    total,
    buyers: facts.length,
    smallNumbers: facts.length < SMALL_NUMBERS,
    headlineRag: ragHigher(total.paid60?.pct ?? null, targets.headlineFloorPct, targets.headlineTargetPct),
    rundownRag: ragHigher(total.paidAfterRun?.pct ?? null, targets.rundownPaidFloorPct, targets.rundownPaidTargetPct),
    costRag: ragLower(total.cost.averagePence, targets.costTargetPence, targets.costCeilingPence),
    campaigns: tags('campaign'),
    contents: tags('content'),
  };
}

/** The facts function's rows, read defensively (numbers as strings, missing arrays). */
export function parsePackFacts(raw: unknown): PackFact[] {
  if (!Array.isArray(raw)) return [];
  const out: PackFact[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r.u !== 'string' || typeof r.pack_at !== 'string') continue;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
    out.push({
      u: r.u,
      email: str(r.email),
      excluded: r.excluded === true,
      signedUpAt: str(r.signed_up_at) ?? r.pack_at,
      weekStart: (str(r.week_start) ?? r.pack_at).slice(0, 10),
      packAt: r.pack_at,
      campaign: str(r.campaign),
      content: str(r.content),
      firstWeekActive: r.first_week_active === true,
      contactedAt: str(r.contacted_at),
      ranDownAt: str(r.ran_down_at),
      paid: Array.isArray(r.paid) ? (r.paid as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      rawCostPence: Math.max(0, Number(r.raw_cost) || 0),
    });
  }
  return out;
}

export const PACK_CSV_COLUMNS = ['userId', 'email', 'signUpWeek', 'packAt', 'utmCampaign', 'utmContent', 'firstWeekActive', 'contactedWithin30Days', 'ranDownWithin45Days', 'paidWithin14DaysOfRunDown', 'paidAgainWithin60Days', 'paidThirdTime', 'paymentsAfterPack', 'packOnly', 'rawCostPence'] as const;

/** One row per counted buyer, as filtered on the page. A column still in its window is "too early". */
export function packPayingCsv(facts: readonly PackFact[], now: Date): string {
  const v = (x: boolean | null | undefined) => (x === null || x === undefined ? 'too early' : x);
  const lines = [PACK_CSV_COLUMNS.join(',')];
  for (const f of facts) {
    const c = buyerColumns(f, now);
    const row = [f.u, f.email, f.weekStart, f.packAt, f.campaign ?? UNTAGGED, f.content ?? UNTAGGED, v(c.firstWeek), v(c.contacted), v(c.ranDown), c.paidAfterRun === null ? 'n/a' : v(c.paidAfterRun), v(c.paid60), v(c.third), f.paid.length, c.packOnly, Math.round(f.rawCostPence * 100) / 100];
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
