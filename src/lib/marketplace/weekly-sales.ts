/**
 * Deal feed (queue Batch 1): the admin's weekly count of what sells, by category. Opens
 * (deal_opens, status open) and full reports (analysis_purchases, complete) over the last
 * eight UK weeks (Monday to Sunday, the way every other weekly count here is made, see
 * src/lib/activity/week.ts), split Rent-to-rent / Buy-to-let. Pure, so the week edges and
 * the zero weeks are tested.
 */
import { recentWeeks, ukDay, ukWeekStart, weekLabel } from '../activity/week.ts';

export type SalesKind = 'rent' | 'sale';
export type SalesWhat = 'open' | 'report';

/** One thing sold: when, what kind of deal it was on, and whether it was an open or a full report. */
export interface SalesRow {
  at: string;
  kind: SalesKind;
  what: SalesWhat;
}

export interface CategoryCount {
  opens: number;
  reports: number;
}

export interface WeekSales {
  /** The week's Monday, YYYY-MM-DD (UK). */
  weekStart: string;
  /** "22 Sep". */
  label: string;
  rent: CategoryCount;
  sale: CategoryCount;
}

export const WEEKS_SHOWN = 8;
/** Zac's target: full reports sold a month (the admin line "reports this month vs 50 target"). */
export const MONTHLY_REPORT_TARGET = 50;

const emptyCount = (): CategoryCount => ({ opens: 0, reports: 0 });

/** The last `weeks` UK weeks, oldest first, every one shown (a quiet week is a row of zeros). */
export function weeklySales(rows: readonly SalesRow[], now: Date, weeks: number = WEEKS_SHOWN): WeekSales[] {
  const starts = recentWeeks(now, weeks);
  const out = new Map<string, WeekSales>(starts.map((w) => [w, { weekStart: w, label: weekLabel(w), rent: emptyCount(), sale: emptyCount() }]));
  for (const r of rows) {
    const t = new Date(r.at);
    if (Number.isNaN(t.getTime())) continue;
    const week = out.get(ukWeekStart(t));
    if (!week) continue; // before the eight weeks, or in the future
    const bucket = r.kind === 'rent' ? week.rent : week.sale;
    if (r.what === 'open') bucket.opens += 1;
    else bucket.reports += 1;
  }
  return starts.map((w) => out.get(w) as WeekSales);
}

export interface Totals {
  rent: CategoryCount;
  sale: CategoryCount;
}

/** The eight weeks added up. */
export function salesTotals(weeks: readonly WeekSales[]): Totals {
  const t: Totals = { rent: emptyCount(), sale: emptyCount() };
  for (const w of weeks) {
    t.rent.opens += w.rent.opens;
    t.rent.reports += w.rent.reports;
    t.sale.opens += w.sale.opens;
    t.sale.reports += w.sale.reports;
  }
  return t;
}

/** Full reports sold in the UK calendar month `now` falls in, against the target. */
export function reportsThisMonth(rows: readonly SalesRow[], now: Date, target: number = MONTHLY_REPORT_TARGET): { count: number; target: number; monthLabel: string } {
  const month = ukDay(now).slice(0, 7);
  let count = 0;
  for (const r of rows) {
    if (r.what !== 'report') continue;
    const t = new Date(r.at);
    if (!Number.isNaN(t.getTime()) && ukDay(t).slice(0, 7) === month) count += 1;
  }
  const monthLabel = new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { count, target, monthLabel };
}
