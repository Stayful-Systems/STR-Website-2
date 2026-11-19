import 'server-only';
import type { BtlLooker } from '../btl/view';
import { offerPricingFor } from '../analysis/offers-server';
import { offerLabel } from '../analysis/offers';

/**
 * For a page of deal cards: which are open to the member's account (and for
 * what), and which they can open a Full analysis of (Batch 10's Opened and
 * Analysed badges, and the price on the Full analysis button).
 *
 * Opens are the account's (a team member's owner's). Analyses are read
 * through the member's own client, so saved_searches' RLS decides what is
 * theirs to see: their own, and their team's. A report from before Full
 * analyses (the metered report run from a deal) counts when it is linked to
 * the member's own pipeline row for the deal.
 */
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import type { createSupabaseServerClient } from '../supabase/server';
import { payerFor } from '../team';
import { getBillingSettings } from '../credit/unit-costs';
import { quoterFor } from '../credit/quote-server';
import { reportReadyDealIds } from '../analysis/saved-server';
import { openCreditBase } from '../credit/deal-pricing';
import type { FinanceDefaults } from '../listing/deal';
import type { DealCard } from './grid';
import { cardView, NOT_OPENED, type CardState, type CardView } from './card-view';
import { freeStandoutOpens } from '../standout/saved-server';
import { cardDisplayFor } from './card-display';
import type { TailoringProfile } from '../tailoring/profile';
import { showsAsBtl } from '../btl/view';
import { btlBenchmarkBand, type CashBand } from '../btl/deal';
import type { Benchmark } from '../btl/benchmark';
import { readBtlBenchmark, readBtlSettingsCached } from '../btl/settings-server';

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

const CHUNK = 150;

export async function cardStatesFor(supabase: ServerClient, userId: string, payerId: string, dealIds: string[]): Promise<Map<string, CardState>> {
  const out = new Map<string, CardState>(dealIds.map((id) => [id, { ...NOT_OPENED }]));
  if (dealIds.length === 0 || !hasServiceRole()) return out;
  const admin = createAdminClient();
  for (let i = 0; i < dealIds.length; i += CHUNK) {
    const ids = dealIds.slice(i, i + CHUNK);
    const [opens, reports, deals] = await Promise.all([
      admin.from('deal_opens').select('deal_id, charged_base_pence, transaction_id, verified_via').eq('user_id', payerId).eq('status', 'open').in('deal_id', ids),
      // A missing column (schema.sql not run yet) reads as no analyses.
      supabase.from('saved_searches').select('id, user_id, deal_id').in('deal_id', ids),
      admin.from('marketplace_deals').select('id, canonical_url').in('id', ids),
    ]);
    if (opens.error) console.error('[card-state] opens read failed:', opens.error.message);
    for (const r of (opens.data ?? []) as { deal_id: string; charged_base_pence: number | string | null; transaction_id: number | null; verified_via: string | null }[]) {
      const s = out.get(r.deal_id);
      if (s) Object.assign(s, { opened: true, openPaidBasePence: openCreditBase(r) });
    }
    if (!reports.error) {
      const rows = (reports.data ?? []) as { id: string; user_id: string; deal_id: string }[];
      // The member's own first, then the team's.
      rows.sort((a, b) => Number(b.user_id === userId) - Number(a.user_id === userId));
      for (const r of rows) {
        const s = out.get(r.deal_id);
        if (s && !s.reportId) s.reportId = r.id;
      }
    }
    // Reports from before: linked to the member's own pipeline row for the deal.
    const urlToDeal = new Map(((deals.data ?? []) as { id: string; canonical_url: string }[]).map((d) => [d.canonical_url, d.id]));
    const missing = [...urlToDeal.entries()].filter(([, id]) => !out.get(id)?.reportId).map(([url]) => url);
    if (missing.length > 0) {
      const { data: rows } = await admin.from('checked_listings').select('canonical_url, analysed_report_id').eq('user_id', userId).in('canonical_url', missing).not('analysed_report_id', 'is', null);
      const linked = ((rows ?? []) as { canonical_url: string; analysed_report_id: string }[]).filter((r) => urlToDeal.has(r.canonical_url));
      if (linked.length > 0) {
        const { data: readable } = await supabase.from('saved_searches').select('id').in('id', linked.map((r) => r.analysed_report_id));
        const ok = new Set(((readable ?? []) as { id: string }[]).map((r) => r.id));
        for (const r of linked) {
          const s = out.get(urlToDeal.get(r.canonical_url)!);
          if (s && !s.reportId && ok.has(r.analysed_report_id)) s.reportId = r.analysed_report_id;
        }
      }
    }
  }
  return out;
}

/**
 * Every card's view for this member, from one read of each kind (cardView,
 * src/lib/marketplace/card-view.ts). Batch 25: a deal Stayful Intelligence
 * saved for the account shows its Quick look free, as opening it is.
 */
export async function cardViewsFor(input: { supabase: ServerClient; userId: string; adminUser: boolean; cards: DealCard[]; finance?: Partial<FinanceDefaults> | null; cashBuyer?: boolean; btl?: BtlLooker | null; tailoring?: TailoringProfile | null }): Promise<Map<string, CardView>> {
  const { payerId } = await payerFor(input.userId);
  const ids = input.cards.map((c) => c.id);
  const [settings, quoter, states, offers, free, ready, benches] = await Promise.all([getBillingSettings(), quoterFor(payerId, input.adminUser), cardStatesFor(input.supabase, input.userId, payerId, ids), offerPricingFor(input.userId, input.adminUser), input.adminUser ? Promise.resolve(new Set<string>()) : freeStandoutOpens(payerId, ids), reportReadyDealIds(ids), btlBenchesFor(input.cards, input.btl ?? null)]);
  // Batch 30: the rate and range-end lines, the same for every card of this member.
  const display = cardDisplayFor(input.tailoring ?? null, input.cashBuyer === true);
  // Batch 22: each card priced with this member's offers (the welcome price on their revealed deals).
  // Batch 29: a saved analysis shows "Report ready" and is priced as a saved one (the pack's bonus may pay).
  return new Map(
    input.cards.map((c) => [
      c.id,
      cardView({ card: c, state: states.get(c.id) ?? NOT_OPENED, admin: input.adminUser, pricing: offers.pricing(c.id, false), offerNote: offerLabel(offers.offer(c.id, false)?.offer), ladder: settings.dealOpenLadder, finance: input.finance ?? null, cashBuyer: input.cashBuyer, lowEntry: settings.lowEntry, label: quoter.label, labelDue: quoter.labelDue, reportReady: ready.has(c.id), freeOpen: free.has(c.id), btl: input.btl ?? null, btlBench: benches.get(c.id) ?? null, display }),
    ]),
  );
}

/**
 * Review R4 (R4-28): the benchmark each card shown as Buy to let is judged against for this member (where they search,
 * the band holding their Buying cash, else the deal's own band), so the card can say "Compared across the UK" or
 * "Few deals to compare" before Open. Area-level figures only: nothing about the home. Empty on any failure.
 */
async function btlBenchesFor(cards: readonly DealCard[], looker: BtlLooker | null): Promise<Map<string, Benchmark>> {
  const out = new Map<string, Benchmark>();
  const centre = looker?.centre ?? null;
  const shown = looker && centre ? cards.filter((c) => c.btl && showsAsBtl(c, looker)) : [];
  if (shown.length === 0 || !hasServiceRole()) return out;
  try {
    const admin = createAdminClient();
    const { settings } = await readBtlSettingsCached(admin);
    const theirs = btlBenchmarkBand(looker?.cash ?? null, settings.bands);
    const byBand = new Map<CashBand, Promise<Benchmark | null>>();
    for (const c of shown) {
      const band = theirs ?? c.btl?.band ?? null;
      if (!band) continue;
      if (!byBand.has(band)) byBand.set(band, readBtlBenchmark(admin, centre!, band).catch(() => null));
      const bm = await byBand.get(band)!;
      if (bm) out.set(c.id, bm);
    }
  } catch (err) {
    console.warn('[card-state] buy-to-let benchmark unreadable:', (err as Error)?.message ?? err);
  }
  return out;
}
