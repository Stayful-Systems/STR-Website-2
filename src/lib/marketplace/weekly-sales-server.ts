import 'server-only';

/**
 * Deal feed (queue Batch 1): reads the rows weeklySales counts. Opens and completed full
 * reports from the first day of the oldest week shown (and of this month, if earlier), each
 * given its deal's kind. Counts only: nothing here is shown with an address.
 */
import { addDays, recentWeeks } from '../activity/week';
import { londonDayStart } from '../leads/search';
import { chunk, type Admin } from './server';
import { WEEKS_SHOWN, type SalesRow } from './weekly-sales';

const PAGE_LIMIT = 20000;

export async function loadSalesRows(admin: Admin, now: Date): Promise<SalesRow[] | null> {
  const first = recentWeeks(now, WEEKS_SHOWN)[0];
  const month = `${now.toISOString().slice(0, 7)}-01`;
  const from = (londonDayStart(addDays(first < month ? first : month, -1)) ?? new Date(now.getTime() - 70 * 24 * 3600 * 1000)).toISOString();
  const [opens, reports] = await Promise.all([
    admin.from('deal_opens').select('deal_id, opened_at').eq('status', 'open').gte('opened_at', from).limit(PAGE_LIMIT),
    admin.from('analysis_purchases').select('deal_id, completed_at, created_at').eq('kind', 'full_analysis').eq('status', 'complete').gte('created_at', from).limit(PAGE_LIMIT),
  ]);
  if (opens.error || reports.error) {
    console.error('[deal-feed] weekly counts unreadable:', (opens.error ?? reports.error)?.code ?? 'error');
    return null;
  }
  const o = (opens.data ?? []) as { deal_id: string; opened_at: string }[];
  const r = (reports.data ?? []) as { deal_id: string | null; completed_at: string | null; created_at: string }[];
  const ids = [...new Set([...o.map((x) => x.deal_id), ...r.map((x) => x.deal_id).filter((x): x is string => Boolean(x))])];
  const kinds = new Map<string, 'rent' | 'sale'>();
  for (const some of chunk(ids, 150)) {
    const { data, error } = await admin.from('marketplace_deals').select('id, kind').in('id', some);
    if (error) {
      console.error('[deal-feed] deal kinds unreadable:', error.code ?? 'error');
      return null;
    }
    for (const d of (data ?? []) as { id: string; kind: string }[]) kinds.set(d.id, d.kind === 'rent' ? 'rent' : 'sale');
  }
  const rows: SalesRow[] = [];
  for (const x of o) {
    const kind = kinds.get(x.deal_id);
    if (kind) rows.push({ at: x.opened_at, kind, what: 'open' });
  }
  for (const x of r) {
    const kind = x.deal_id ? kinds.get(x.deal_id) : undefined;
    if (kind) rows.push({ at: x.completed_at ?? x.created_at, kind, what: 'report' });
  }
  return rows;
}
