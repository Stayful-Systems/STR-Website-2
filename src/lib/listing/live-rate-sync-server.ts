import 'server-only';
import { createAdminClient } from '../supabase/admin';
import type { MortgageRates } from '../apis/propertydata-parse';
import { rateToSync, syncSummary, type RateToSync } from './live-rate-sync';

/**
 * Write today's average into every profile that has not set its own rate
 * (public.sync_live_mortgage_rate). Returns the line for the market-warm log;
 * never throws, so a failure cannot stop the warm-up behind it.
 */
export async function syncLiveMortgageRate(rates: MortgageRates | null | undefined, now: Date, opts: { dry?: boolean } = {}): Promise<{ rate: RateToSync | null; line: string }> {
  const rate = rateToSync(rates, now);
  if (!rate || opts.dry) return { rate, line: syncSummary(rate, undefined, opts.dry === true) };
  try {
    const { data, error } = await createAdminClient().rpc('sync_live_mortgage_rate', { p_rate: rate.ratePct, p_as_of: rate.asOf });
    if (error) throw new Error(error.message);
    const r = (data ?? {}) as { profiles?: number; search_profiles?: number };
    return { rate, line: syncSummary(rate, { profiles: Number(r.profiles ?? 0), search_profiles: Number(r.search_profiles ?? 0) }) };
  } catch (err) {
    console.error('[market-warm] rate sync failed:', (err as Error)?.message ?? err);
    return { rate, line: syncSummary(rate, 'failed') };
  }
}
