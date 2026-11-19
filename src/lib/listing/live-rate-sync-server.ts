import 'server-only';
import { createAdminClient } from '../supabase/admin';
import type { MortgageRates } from '../apis/propertydata-parse';
import { QUIZ_V2_BACKFILL_DONE_KEY, rateToSync, syncPlan, syncSummary, type RateToSync } from './live-rate-sync';

type Admin = ReturnType<typeof createAdminClient>;

/** Review R4 (R4-33): the quiz v2 backfill's "done" stamp, or null when it is missing or unreadable (the sync then waits). Reads only. */
export async function readBackfillStamp(admin: Admin): Promise<string | null> {
  const { data, error } = await admin.from('billing_settings').select('value').eq('key', QUIZ_V2_BACKFILL_DONE_KEY).maybeSingle();
  if (error) {
    console.warn('[market-warm] backfill stamp unreadable:', error.message);
    return null;
  }
  const v = (data as { value?: unknown } | null)?.value;
  return typeof v === 'string' ? v : null;
}

/**
 * Write today's average into every profile that has not set its own rate
 * (public.sync_live_mortgage_rate). Returns the line for the market-warm log;
 * never throws, so a failure cannot stop the warm-up behind it. Review R4
 * (R4-33): nothing is written until the quiz v2 backfill has stamped
 * billing_settings.quiz_v2_backfill_done_at; the reason is logged and returned.
 * The dry run reads the stamp and writes nothing.
 */
export async function syncLiveMortgageRate(rates: MortgageRates | null | undefined, now: Date, opts: { dry?: boolean } = {}): Promise<{ rate: RateToSync | null; line: string }> {
  const rate = rateToSync(rates, now);
  if (!rate) return { rate, line: syncSummary(rate, undefined, opts.dry === true) };
  let stamp: string | null = null;
  try {
    stamp = await readBackfillStamp(createAdminClient());
  } catch (err) {
    console.warn('[market-warm] backfill stamp unreadable:', (err as Error)?.message ?? err);
  }
  const plan = syncPlan(rate, stamp);
  if (!plan.sync) {
    if (!opts.dry) console.warn(`[market-warm] rate sync ${plan.line}`);
    return { rate, line: plan.line ?? syncSummary(rate) };
  }
  if (opts.dry) return { rate, line: syncSummary(rate, undefined, true) };
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
