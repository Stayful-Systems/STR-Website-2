/**
 * Batch 30: Home's "What's the biggest thing holding you back?" card. The
 * question left the quiz (it was the last of 33); it is asked once, on Home,
 * from the third day (billing_settings home_blocker_card_day), until it is
 * answered or "Not now" is tapped.
 *
 *   - Due when: day N since sign-up has come (UK days; the sign-up day is day 0),
 *     the member has no stored answer and no mark for it (the old quiz may have
 *     asked it), and has not dismissed the card.
 *   - After the starter pack's cards: while one of those is showing it waits
 *     (one prompt card on Home at a time).
 *   - One tap answers it through the quiz's own answerQuestion (a profile_answered);
 *     "Not now" stamps profile_quiz.blocker_card_dismissed_at and logs the
 *     record-only home_blocker_dismissed. Neither changes what "weekly active" means.
 *
 * Pure: no network, no database, no server-only.
 */
import { ukDay } from '../listing/live-rate-sync.ts';

export interface BlockerCardFacts {
  /** auth.users.created_at: the sign-up day. */
  signedUpAt: string | null;
  now: Date;
  /** billing_settings home_blocker_card_day (3). */
  cardDay: number;
  /** about_you.blocker, when answered. */
  blocker: string | null;
  /** profile_quiz.answered has a mark for the blocker question (a real answer or "Not sure"). */
  marked: boolean;
  /** profile_quiz.blocker_card_dismissed_at. */
  dismissedAt: string | null;
  /** A starter pack card (the early offer or "picks are back") is showing: this one waits. */
  packCardShowing: boolean;
}

/** UK calendar days from the sign-up day to now (0 on the day itself); null when the sign-up date is unreadable. */
export function daysSinceSignup(signedUpAt: string | null, now: Date): number | null {
  if (!signedUpAt) return null;
  const t = Date.parse(signedUpAt);
  if (!Number.isFinite(t)) return null;
  const a = Date.parse(`${ukDay(new Date(t))}T00:00:00Z`);
  const b = Date.parse(`${ukDay(now)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function blockerCardDue(f: BlockerCardFacts): boolean {
  if (f.blocker !== null || f.marked || f.dismissedAt) return false;
  if (f.packCardShowing) return false;
  const days = daysSinceSignup(f.signedUpAt, f.now);
  return days !== null && days >= f.cardDay;
}

export const BLOCKER_CARD_COPY = {
  title: 'What’s the biggest thing holding you back?',
  notNow: 'Not now',
  thanks: 'Thanks. I’ll help with that first.',
} as const;
