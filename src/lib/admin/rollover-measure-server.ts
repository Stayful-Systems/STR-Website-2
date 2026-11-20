import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { adminEmails } from '../admin';
import { loadSubscriptionEvents } from '../billing/churn-server';
import { COUNTED_KINDS, QUALIFYING_KINDS } from '../activity/kinds';
import { computeWeeklyActive, type WeeklyFacts } from '../activity/metrics';
import { rolloverMeasure, type MeasureGrantRow, type MeasureMember, type RolloverMeasure } from './rollover-measure';

/**
 * Batch 32, Phase 7: the reads behind "Plan credit rollover" on
 * /admin/weekly-active. The maths is rollover-measure.ts; this only fetches:
 *
 *   - the launch date (billing_settings plan_credit_rollover_from)
 *   - subscription_events (churn-server.ts, the churn report's own read)
 *   - the weekly-active facts (activity_weekly_facts, summed by metrics.ts
 *     computeWeeklyActive with its rule unchanged), over enough weeks to
 *     reach 12 weeks before the launch
 *   - every plan grant (credit_grants, kind 'plan'), for banked and rolled over
 *
 * Service role only; the page checks the admin session first. Never throws:
 * a part that cannot be read comes back null with a note. Only counts and
 * pence leave this file.
 */

const PAGE = 1000;
const MAX_ROWS = 50_000;
const WEEK = 7 * 86_400_000;

export type RolloverMeasureLoad = { ok: true; measure: RolloverMeasure; notes: string[] } | { ok: false; error: string };

async function launchAt(admin: ReturnType<typeof createAdminClient>): Promise<string | null> {
  const { data, error } = await admin.from('billing_settings').select('value').eq('key', 'plan_credit_rollover_from').maybeSingle();
  if (error || !data) return null;
  const v = (data as { value: unknown }).value;
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
}

/** 12 weeks before the launch up to now (12 weeks when not launched), at most a year. */
function weeksToRead(launch: string | null, now: Date): number {
  const since = launch ? Math.max(0, Math.ceil((now.getTime() - Date.parse(launch)) / WEEK)) : 0;
  return Math.min(52, 12 + since + 1);
}

async function weeklyMembers(now: Date, weeks: number): Promise<{ members: MeasureMember[] | null; note: string | null }> {
  const { data, error } = await createAdminClient().rpc('activity_weekly_facts', {
    p: { weeks, now: now.toISOString(), qualifying: QUALIFYING_KINDS, counted: COUNTED_KINDS },
  });
  if (error) return { members: null, note: `weekly-active facts unreadable: ${error.message}` };
  const report = computeWeeklyActive(data as WeeklyFacts, { adminEmails: adminEmails(), drillWeeks: weeks });
  // Keep only what the measure needs: no email or name goes further.
  return { members: report.members.map((m) => ({ id: m.id, weeks: m.weeks.map((w) => ({ week: w.week, active: w.active })) })), note: null };
}

async function planGrants(): Promise<{ grants: MeasureGrantRow[] | null; note: string | null }> {
  const admin = createAdminClient();
  const out: MeasureGrantRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await admin
      .from('credit_grants')
      .select('user_id, amount_pence, remaining_pence, created_at, plan_cycle, source_ref, expires_at')
      .eq('kind', 'plan')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { grants: null, note: `plan grants unreadable (schema.sql Batch 32 section not run?): ${error.message}` };
    const rows = (data ?? []) as MeasureGrantRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { grants: out, note: null };
}

export async function loadRolloverMeasure(now: Date = new Date()): Promise<RolloverMeasureLoad> {
  if (!hasServiceRole()) return { ok: false, error: 'Storage not configured' };
  try {
    const launch = await launchAt(createAdminClient());
    const [events, weekly, grants] = await Promise.all([loadSubscriptionEvents(), weeklyMembers(now, weeksToRead(launch, now)), planGrants()]);
    const notes = [weekly.note, grants.note].filter((n): n is string => n !== null);
    if (!launch) notes.unshift('No launch date yet (billing_settings plan_credit_rollover_from is set when schema.sql’s Batch 32 section runs): everything counts as before.');
    return { ok: true, measure: rolloverMeasure({ launchAt: launch, now, events, members: weekly.members, grants: grants.grants }), notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rollover-measure] read failed:', message);
    return { ok: false, error: message };
  }
}
