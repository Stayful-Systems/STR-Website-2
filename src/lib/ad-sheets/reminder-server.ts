import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { SHEET_SETTING_KEYS, parseSheetSettings } from './settings.ts';
import { staleNewByOwner, type ReminderLead } from './reminder.ts';

/**
 * Batch 35 (Phase 11): who has leads waiting at New, for the daily email's one
 * line. Service role only; reads `leads` (user_id in the recipients, not
 * archived, stage New, older than the setting) and the one billing_settings row.
 * Writes nothing and sends nothing. A failure logs a table name and the
 * database's error code at most (never a lead) and gives no line.
 */

type Admin = SupabaseClient;
const CHUNK = 100;
const PAGE = 1000;
const MAX_ROWS = 20_000;

/** Recipients with at least one stale lead, mapped to the count, plus the age the wording uses. Empty on any failure. */
export async function staleNewLeadsFor(admin: Admin, ownerIds: readonly string[], now: Date = new Date()): Promise<{ counts: Map<string, number>; ageDays: number }> {
  const none = { counts: new Map<string, number>(), ageDays: 0 };
  if (ownerIds.length === 0) return none;
  const { data: setting, error: sErr } = await admin.from('billing_settings').select('key, value').eq('key', SHEET_SETTING_KEYS.reminderAgeDays);
  if (sErr) {
    console.warn('[ad-sheets] billing_settings failed:', sErr.code ?? 'error');
    return none;
  }
  const ageDays = parseSheetSettings((setting ?? []) as { key: string; value: unknown }[]).reminderAgeDays;
  const cutoff = new Date(now.getTime() - ageDays * 86_400_000).toISOString();
  const leads: ReminderLead[] = [];
  for (let i = 0; i < ownerIds.length; i += CHUNK) {
    const ids = ownerIds.slice(i, i + CHUNK);
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await admin
        .from('leads')
        .select('id, user_id, stage, created_at')
        .in('user_id', ids)
        .is('archived_at', null)
        .or('stage.is.null,stage.eq.new')
        .lt('created_at', cutoff)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        console.warn('[ad-sheets] leads failed:', error.code ?? 'error');
        return none;
      }
      const rows = (data ?? []) as { user_id: string; stage: string | null; created_at: string }[];
      for (const r of rows) leads.push({ ownerId: r.user_id, stage: r.stage, createdAt: r.created_at, archived: false });
      if (rows.length < PAGE) break;
    }
  }
  const counts = new Map<string, number>();
  for (const [id, n] of staleNewByOwner(leads, ownerIds, now, ageDays)) if (n > 0) counts.set(id, n);
  return { counts, ageDays };
}
