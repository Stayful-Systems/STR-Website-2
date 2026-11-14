import 'server-only';

import { createAdminClient } from '../supabase/admin';
import { queueFunnelSync } from '../crm/monday-funnel/queue-server';

/**
 * Batch 20, Part C: coming back. Called by src/lib/activity/log.ts after a
 * new engaging action is written (Batch 9's weekly-active kinds, or engaging
 * by email or text: ./rules.ts): the member leaves Re-engage and their daily
 * picks restart with the next run. Kept on its own, with nothing but the
 * database and the Monday queue, so the activity log imports nothing heavier.
 */

// One warning a minute, so a missing column (schema not run) does not fill the logs.
let warnedAt = 0;

/**
 * An engaging action: out of Re-engage and daily picks back on, at once.
 * One guarded update (it writes only a member who was marked), then Monday
 * hears within ten minutes. Never throws.
 */
export async function cameBack(userId: string): Promise<void> {
  try {
    // Batch 29: a pack pause ends here too, noted on Home ("They're back on").
    await resumePackPause(userId);
    const { data, error } = await createAdminClient()
      .from('profiles')
      .update({ reengage_since: null, picks_paused_inactive_at: null, picks_paused_inactive_email_at: null })
      .eq('id', userId)
      .or('reengage_since.not.is.null,picks_paused_inactive_at.not.is.null')
      .select('id');
    if (error) {
      if (Date.now() - warnedAt > 60_000) {
        warnedAt = Date.now();
        console.warn('[inactivity] came-back clear failed (schema not run?):', error.message);
      }
      return;
    }
    if ((data?.length ?? 0) > 0) await queueFunnelSync(userId, 'came_back');
  } catch {
    /* never in the way of the action itself */
  }
}

/**
 * Batch 29, section D: a pack-only member whose picks were paused while they
 * were away (picks_paused_reason 'pack') is back: picks on from the next run,
 * and pack_picks_back_at stamped for Home's one-off note. One guarded update
 * (nothing for anyone else). Called from AppShell after a visit and from
 * cameBack. No email, no Monday sync (the pack pause is not Batch 20's
 * Re-engage). Never throws.
 */
export async function resumePackPause(userId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient()
      .from('profiles')
      .update({ picks_paused_inactive_at: null, picks_paused_inactive_email_at: null, picks_paused_reason: null, pack_picks_back_at: now.toISOString() })
      .eq('id', userId)
      .eq('picks_paused_reason', 'pack')
      .not('picks_paused_inactive_at', 'is', null)
      .select('id');
    if (error) {
      if (Date.now() - warnedAt > 60_000) {
        warnedAt = Date.now();
        console.warn('[inactivity] pack resume failed (schema.sql Batch 29 section not run?):', error.message);
      }
      return false;
    }
    return (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
