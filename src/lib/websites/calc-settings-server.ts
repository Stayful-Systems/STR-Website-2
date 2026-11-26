import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { AD_CALC_REPORTS_PER_DAY_KEY, DEFAULT_AD_CALC_REPORTS_PER_DAY, parseAdCalcReportsPerDay } from './settings';

/**
 * Batch 55 (Part A): the calculator sites' per-day report limit (ad_calc_reports_per_day).
 * Service role only; with no service role, or when the read fails, the default (a bot guard, so
 * the default is safe). Never throws.
 */
export async function readAdCalcReportsPerDay(): Promise<number> {
  if (!hasServiceRole()) return DEFAULT_AD_CALC_REPORTS_PER_DAY;
  try {
    const { data, error } = await createAdminClient().from('billing_settings').select('value').eq('key', AD_CALC_REPORTS_PER_DAY_KEY).maybeSingle();
    if (error) {
      console.error('[websites] calculator limit read failed, using the default:', error.code ?? 'error');
      return DEFAULT_AD_CALC_REPORTS_PER_DAY;
    }
    return parseAdCalcReportsPerDay((data as { value?: unknown } | null)?.value);
  } catch {
    return DEFAULT_AD_CALC_REPORTS_PER_DAY;
  }
}
