import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { getBillingSettings } from '../credit/unit-costs';
import { parsePackFacts, type PackFact, type PackPayingTargets } from './pack-paying';

/**
 * Batch 29, section F: the starter pack buyers' facts for "Pack → paying"
 * (public.pack_paying_facts, one read) and the green / amber / red lines from
 * billing_settings. Never throws: unreadable is { ok: false }.
 */
export async function loadPackPaying(): Promise<{ ok: true; facts: PackFact[]; targets: PackPayingTargets } | { ok: false; error: string }> {
  if (!hasServiceRole()) return { ok: false, error: 'Storage not configured' };
  try {
    const lifecycle = (await getBillingSettings()).lifecycle;
    const { data, error } = await createAdminClient().rpc('pack_paying_facts', { p: { low_credit_pence: lifecycle.lowCreditPence } });
    if (error) return { ok: false, error: `pack facts unreadable (schema.sql Batch 29 section not run?): ${error.message}` };
    return {
      ok: true,
      facts: parsePackFacts(data),
      targets: {
        headlineFloorPct: lifecycle.packPayingHeadlineFloorPct,
        headlineTargetPct: lifecycle.packPayingHeadlineTargetPct,
        rundownPaidFloorPct: lifecycle.packPayingRundownPaidFloorPct,
        rundownPaidTargetPct: lifecycle.packPayingRundownPaidTargetPct,
        costTargetPence: lifecycle.packCostTargetPence,
        costCeilingPence: lifecycle.packCostCeilingPence,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
