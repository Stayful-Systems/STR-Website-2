import 'server-only';

/**
 * Deal feed (queue Batch 1): finds the opens due a stale-deal credit and grants it. One
 * function (grantStaleCredit) does a grant, for the hourly cron and for the admin button
 * alike; the cron calls it for each due open, the button for one open with the time
 * window ignored. The credit ledger (src/lib/credit/ledger.ts) is called, never changed.
 *
 * Logs carry an open id and pence only: never an address or a listing.
 */
import { grant } from '../credit/ledger';
import { chunk, type Admin } from './server';
import { readDealFeedSettings } from './deal-feed-settings-server';
import { STALE_REASONS, settleStale, stalePence, staleRunMode, type LedgerRow, type StaleDeps, type StaleGrantOutcome } from './stale-credit';
import type { DealFeedSettings } from './deal-feed-settings';

/** The cron looks this far back for deals that went; an older one is the admin button's. */
export const STALE_LOOKBACK_DAYS = 30;
const OPEN_COLUMNS = 'id, user_id, deal_id, status, opened_at, transaction_id, stale_credit_at';

interface OpenRow {
  id: string;
  user_id: string;
  deal_id: string;
  status: string;
  opened_at: string;
  transaction_id: number | null;
  stale_credit_at: string | null;
}

interface GoneDeal {
  id: string;
  status: string;
  retired_reason: string | null;
  retired_at: string | null;
}

/** What the member was actually debited for this open and its completed full reports. */
async function spentOn(admin: Admin, open: OpenRow): Promise<number> {
  const debitIds: number[] = [];
  if (open.transaction_id !== null) debitIds.push(Number(open.transaction_id));
  const { data: purchases } = await admin.from('analysis_purchases').select('transaction_ids').eq('user_id', open.user_id).eq('deal_id', open.deal_id).eq('status', 'complete');
  for (const p of (purchases ?? []) as { transaction_ids: (number | string)[] | null }[]) for (const t of p.transaction_ids ?? []) debitIds.push(Number(t));
  if (debitIds.length === 0) return 0;
  const ids = [...new Set(debitIds)];
  const [debits, refunds] = await Promise.all([
    admin.from('credit_transactions').select('id, user_id, kind, amount_pence, metadata').in('id', ids).eq('kind', 'debit'),
    admin.from('credit_transactions').select('id, user_id, kind, amount_pence, metadata').eq('kind', 'refund').in('metadata->>refund_of', ids.map(String)),
  ]);
  if (debits.error || refunds.error) throw new Error('ledger unreadable');
  return stalePence([...((debits.data ?? []) as LedgerRow[]), ...((refunds.data ?? []) as LedgerRow[])], ids, open.user_id);
}

async function dealOf(admin: Admin, dealId: string): Promise<GoneDeal | null> {
  const { data } = await admin.from('marketplace_deals').select('id, status, retired_reason, retired_at').eq('id', dealId).maybeSingle();
  return (data as GoneDeal | null) ?? null;
}

function depsFor(admin: Admin): StaleDeps {
  return {
    spentPence: (open) => spentOn(admin, open as OpenRow),
    async grant(userId, pence, sourceRef, description) {
      await grant(userId, 'adjustment', pence, { sourceRef, description });
    },
    async stamp(openId, pence, atIso) {
      const { error } = await admin.from('deal_opens').update({ stale_credit_at: atIso, stale_credit_pence: pence }).eq('id', openId).is('stale_credit_at', null);
      if (error) console.error(`[stale-credit] open ${openId}: stamp failed:`, error.code ?? 'error');
      return !error;
    },
  };
}

/** Grants the credit for one open if it is due. `dry` works out the amount and writes nothing. */
export async function grantStaleCredit(admin: Admin, open: OpenRow, deal: GoneDeal, settings: DealFeedSettings, opts: { ignoreWindow?: boolean; dry?: boolean; now?: Date } = {}): Promise<StaleGrantOutcome> {
  const out = await settleStale(depsFor(admin), open, deal, settings, opts);
  if (out.ok && out.granted) console.info(`[stale-credit] open ${open.id}: ${out.pence} credited back`);
  if (!out.ok && out.code === 'failed') console.error(`[stale-credit] open ${open.id}: failed`);
  return out;
}

/** The admin button: one open id, the time window ignored, the switch not needed. */
export async function grantStaleCreditById(admin: Admin, openId: string): Promise<StaleGrantOutcome> {
  if (!/^[0-9a-f-]{36}$/i.test(openId)) return { ok: false, code: 'missing' };
  const { data, error } = await admin.from('deal_opens').select(OPEN_COLUMNS).eq('id', openId).maybeSingle();
  if (error || !data) return { ok: false, code: error ? 'failed' : 'missing' };
  const open = data as unknown as OpenRow;
  const deal = await dealOf(admin, open.deal_id);
  if (!deal) return { ok: false, code: 'missing' };
  return grantStaleCredit(admin, open, deal, await readDealFeedSettings(), { ignoreWindow: true });
}

export interface StaleRunSummary {
  dry: boolean;
  enabled: boolean;
  days: number;
  lookbackDays: number;
  /** Open rows read for deals that went in the look-back. */
  considered: number;
  /** Due and, on a real run, credited. */
  due: number;
  credited: number;
  /** Total pence credited (or, on a dry run, that would be). */
  pence: number;
  failed: number;
  /** Open ids and pence only. */
  rows: { openId: string; pence: number }[];
  ms?: number;
}

export async function runStaleCredits(admin: Admin, opts: { dry: boolean; now?: Date }): Promise<StaleRunSummary> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const settings = await readDealFeedSettings();
  const summary: StaleRunSummary = { dry: opts.dry, enabled: settings.staleCreditEnabled, days: settings.staleCreditDays, lookbackDays: STALE_LOOKBACK_DAYS, considered: 0, due: 0, credited: 0, pence: 0, failed: 0, rows: [] };
  // A real run does nothing while the switch is off; a dry run lists what it would do, so it can be read before the switch is turned on.
  if (staleRunMode(settings, opts.dry) === 'skip') return summary;
  const since = new Date(now.getTime() - STALE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: gone, error } = await admin.from('marketplace_deals').select('id, status, retired_reason, retired_at').eq('status', 'retired').in('retired_reason', [...STALE_REASONS]).gte('retired_at', since).limit(5000);
  if (error) {
    console.error('[stale-credit] gone deals unreadable:', error.code ?? 'error');
    summary.failed += 1;
    return summary;
  }
  const deals = new Map(((gone ?? []) as GoneDeal[]).map((d) => [d.id, d]));
  for (const some of chunk([...deals.keys()], 150)) {
    const { data, error: openErr } = await admin.from('deal_opens').select(OPEN_COLUMNS).in('deal_id', some).eq('status', 'open').is('stale_credit_at', null);
    if (openErr) {
      // Without the Deal feed block the column is not there yet: nothing to do, and nothing wrong.
      console.error('[stale-credit] opens unreadable:', openErr.code ?? 'error');
      summary.failed += 1;
      return summary;
    }
    for (const open of (data ?? []) as unknown as OpenRow[]) {
      summary.considered += 1;
      const deal = deals.get(open.deal_id);
      if (!deal) continue;
      const out = await grantStaleCredit(admin, open, deal, settings, { dry: opts.dry, now });
      if (!out.ok) {
        if (out.code === 'failed') summary.failed += 1;
        continue;
      }
      summary.due += 1;
      if (out.granted) summary.credited += 1;
      summary.pence += out.pence;
      if (out.pence > 0) summary.rows.push({ openId: open.id, pence: out.pence });
    }
  }
  summary.ms = Date.now() - started;
  return summary;
}
