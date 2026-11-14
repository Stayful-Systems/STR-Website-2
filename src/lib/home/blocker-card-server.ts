import 'server-only';
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { getBillingSettings } from '../credit/unit-costs';
import { blockerCardDue } from './blocker-card';
import type { ProfileSummary } from '../profile/server';

/**
 * Whether Home shows the "What's holding you back?" card to this member now
 * (blocker-card.ts has the rule). Reads only; never throws: an unreadable
 * state shows nothing. `packCardShowing`: a starter pack card is on Home.
 */
export async function blockerCardShown(userId: string, signedUpAt: string | null, summary: Pick<ProfileSummary, 'answers' | 'quiz'> | null, packCardShowing: boolean, now: Date = new Date()): Promise<boolean> {
  if (!summary || !hasServiceRole()) return false;
  try {
    const [settings, row] = await Promise.all([getBillingSettings(), createAdminClient().from('profile_quiz').select('blocker_card_dismissed_at').eq('user_id', userId).maybeSingle()]);
    // A missing column (schema.sql not run yet) reads as not dismissed; the card still waits for its day.
    const dismissedAt = (row.data as { blocker_card_dismissed_at?: string | null } | null)?.blocker_card_dismissed_at ?? null;
    return blockerCardDue({ signedUpAt, now, cardDay: settings.lifecycle.homeBlockerCardDay, blocker: summary.answers.about.blocker, marked: Boolean(summary.quiz.answered.blocker), dismissedAt, packCardShowing });
  } catch (err) {
    console.warn('[home] blocker card not read:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** "Not now": stamped once; the card never shows again. */
export async function dismissBlockerCard(userId: string, now: Date = new Date()): Promise<void> {
  if (!hasServiceRole()) return;
  const admin = createAdminClient();
  const { error } = await admin.from('profile_quiz').update({ blocker_card_dismissed_at: now.toISOString() }).eq('user_id', userId).is('blocker_card_dismissed_at', null);
  if (error) console.error('[home] blocker card dismissal not saved:', error.message);
}
