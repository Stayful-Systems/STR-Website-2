import 'server-only';

import { cache } from 'react';
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { getBalance } from './ledger';
import { getBillingSettings } from './unit-costs';
import { allocate, allocateSteps, priceLabel, type DealAnalysisDue, type DealPricing, type GrantLite, type PriceLabel, type Quote } from './deal-pricing';
import { analysisSteps as dueSteps, bonusPaysFor } from './pack-rules';

/**
 * Prices as one member will pay them. Reads the payer's live grants once per
 * request (React `cache`), then every price on the page — the card buttons,
 * the deal sheet, the stage reminder, the Usage page — is walked against the
 * same grants, in the same order and at the same frozen rates as the ledger
 * takes them (`allocate`, src/lib/credit/deal-pricing.ts).
 *
 * `payerId` is the account that pays: a team member's owner.
 */
export interface Quoter {
  admin: boolean;
  pricing: DealPricing;
  /** Base pence the balance covers after open reservations. */
  spendableBasePence: number;
  grants: GrantLite[];
  /**
   * Batch 29: `action` is the ledger action the charge goes under (with its
   * meta, e.g. { reused: true }). The starter pack's restricted bonus is only
   * walked for an action it pays for (pack-rules.ts); no action is treated as
   * one it does not, as the database treats an unknown action.
   */
  quote(basePence: number, action?: string | null, meta?: { reused?: unknown }): Quote;
  label(basePence: number, action?: string | null, meta?: { reused?: unknown }): PriceLabel;
  /** A Full analysis purchase: the open (a deal open), then the analysis (saved or fresh), then PMI, walked in that order. */
  quoteDue(due: Pick<DealAnalysisDue, 'openBasePence' | 'analysisBasePence' | 'pmiBasePence'>, opts?: { saved?: boolean }): Quote;
  labelDue(due: Pick<DealAnalysisDue, 'openBasePence' | 'analysisBasePence' | 'pmiBasePence'>, opts?: { saved?: boolean }): PriceLabel;
}

/** The base pence a quote may count on for an action: the restricted bonus only for the actions it pays for. */
function spendableForQuote(spendable: number, grants: readonly GrantLite[], bonusOk: boolean): number {
  if (bonusOk) return spendable;
  const restrictedBase = grants.reduce((n, g) => (g.restricted ? n + g.remainingPence / (g.spendRate || 1) : n), 0);
  return Math.max(0, spendable - restrictedBase);
}


async function readGrants(payerId: string): Promise<GrantLite[]> {
  if (!hasServiceRole()) return [];
  const { data, error } = await createAdminClient()
    .from('credit_grants')
    .select('id, kind, priority, remaining_pence, spend_rate, expires_at, created_at, scope, scope_lifted_at')
    .eq('user_id', payerId)
    .gt('remaining_pence', 0)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
  if (error) {
    console.error('[credit] grants read for a quote failed:', error.message);
    return [];
  }
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    priority: Number(r.priority) || 3,
    remainingPence: Number(r.remaining_pence) || 0,
    spendRate: Number(r.spend_rate) || 1,
    expiresAt: (r.expires_at as string | null) ?? null,
    createdAt: String(r.created_at ?? ''),
    restricted: r.scope === 'pack_bonus' && !r.scope_lifted_at,
  }));
}

export const quoterFor = cache(async (payerId: string, admin: boolean): Promise<Quoter> => {
  const [settings, grants, balance] = await Promise.all([
    getBillingSettings(),
    admin ? Promise.resolve([] as GrantLite[]) : readGrants(payerId),
    admin ? Promise.resolve(null) : getBalance(payerId).catch(() => null),
  ]);
  const spendable = balance?.spendableBasePence ?? 0;
  return {
    admin,
    pricing: settings.dealPricing,
    spendableBasePence: spendable,
    grants,
    quote: (basePence, action, meta) => allocate(grants, basePence, undefined, { bonusOk: bonusPaysFor(action, meta) }),
    label: (basePence, action, meta) => {
      const ok = bonusPaysFor(action, meta);
      return priceLabel(allocate(grants, basePence, undefined, { bonusOk: ok }), { admin, spendableBasePence: spendableForQuote(spendable, grants, ok) });
    },
    quoteDue: (due, opts = {}) => allocateSteps(grants, dueSteps(due, Boolean(opts.saved))),
    labelDue: (due, opts = {}) => {
      const steps = dueSteps(due, Boolean(opts.saved));
      const q = allocateSteps(grants, steps);
      // Enough after open holds: the whole purchase from everything, and the steps the bonus may not pay from the rest.
      const nonBonus = steps.reduce((n, x) => (x.bonusOk ? n : n + x.basePence), 0);
      const enough = spendable + 0.0001 >= q.basePence && spendableForQuote(spendable, grants, false) + 0.0001 >= nonBonus;
      return priceLabel(q, { admin, spendableBasePence: enough ? q.basePence : q.basePence - 1 });
    },
  };
});
