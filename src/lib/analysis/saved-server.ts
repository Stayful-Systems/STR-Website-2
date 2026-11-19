import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { getBillingSettings } from '../credit/unit-costs';
import { analysisComplete, reusable } from './reuse';
import type { AnalysisResult } from '../types';

/**
 * Batch 29: is there a saved analysis a Full analysis of this deal would reuse
 * (deal-analysis.ts runDealAnalysis's latestSaved test: same deal, same
 * inputs, younger than analysis_reuse_days, with short-let figures)? Used at
 * the start of a purchase, so a saved one is held as saved (the starter pack's
 * bonus may pay for it, and it never counts toward the fresh-report cap).
 */
type Admin = ReturnType<typeof createAdminClient>;

interface Row {
  deal_id: string;
  analysed_at: string;
  result: { result?: Pick<AnalysisResult, 'shortLet'> } | null;
}

export async function savedAnalysisExists(admin: Admin, dealId: string, inputKey: string, reuseDays: number, now: Date = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - reuseDays * 86_400_000).toISOString();
  const { data, error } = await admin.from('deal_analyses').select('deal_id, analysed_at, result').eq('deal_id', dealId).eq('input_key', inputKey).gt('analysed_at', since).order('analysed_at', { ascending: false }).limit(1);
  if (error) {
    console.error('[saved-analysis] read failed:', error.message);
    return false;
  }
  const row = ((data ?? []) as Row[])[0];
  return Boolean(row && reusable(row.analysed_at, reuseDays, now) && analysisComplete(row.result?.result ?? null));
}

/**
 * The deals (of these) with a saved analysis young enough to reuse: the
 * "Report ready, opens instantly" badge. Read by deal only (a deal's inputs
 * come from its listing and rarely change; decided, Review R4 §9 D27); the
 * purchase itself checks the exact inputs, and so does Stayful
 * Intelligence's planner (si-actions/steps-server.ts savedOnOwnInputs), which
 * promises what the starter pack's fresh-report cap allows. Says nothing about the deal beyond that: no address, no figure.
 * Empty when unreadable.
 */
export async function reportReadyDealIds(dealIds: readonly string[], now: Date = new Date()): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = [...new Set(dealIds.filter(Boolean))];
  if (ids.length === 0 || !hasServiceRole()) return out;
  try {
    const reuseDays = (await getBillingSettings()).dealPricing.analysisReuseDays;
    const since = new Date(now.getTime() - reuseDays * 86_400_000).toISOString();
    // Review R4 (R4-09): every id, a page of 200 at a time (it used to read only the first 200).
    const admin = createAdminClient();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await admin.from('deal_analyses').select('deal_id, analysed_at, result').in('deal_id', ids.slice(i, i + 200)).gt('analysed_at', since);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Row[]) {
        if (reusable(r.analysed_at, reuseDays, now) && analysisComplete(r.result?.result ?? null)) out.add(r.deal_id);
      }
    }
  } catch (err) {
    console.warn('[saved-analysis] report-ready read failed:', err instanceof Error ? err.message : String(err));
  }
  return out;
}
