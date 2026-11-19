/**
 * Stayful Academy trial rules (Batch 31a). Buying the Academy (a one-off
 * Stripe payment) gives 3 months of Intelligence Pro free on the card the
 * buyer paid with, starting when the purchase is linked to an account; then
 * the Pro price monthly unless they cancel, with a reminder 7 days before the
 * first charge.
 *
 * Pure: no Supabase, Stripe or 'server-only', so node:test imports it and the
 * linking code (link.ts), webhook, credit sweep, reminder cron and admin all
 * decide the same way. Every figure lives in ACADEMY_FACTS; Stayful
 * Intelligence's knowledge placeholders read them from here too.
 */
import { monthSlotAt, monthSlots, type MonthSlot } from '../stripe/annual.ts';

export const ACADEMY_FACTS = {
  /** The trial's length (Stripe `trial_period_days`), counted from linking. */
  trialDays: 90,
  /** The trial is credited as this many monthly slots (the last ends at the trial end). */
  trialMonths: 3,
  /** The reminder email goes out from this many days before the first charge… */
  reminderDaysBefore: 7,
  /** …waiting for a free daily email slot, but no later than this many days before (sent anyway). */
  reminderLatestDaysBefore: 5,
  /** Admin flags a purchase still unlinked this many days after payment. */
  chaseUnlinkedDays: 14,
} as const;

const DAY_MS = 86_400_000;

/** The form an email is stored and compared in: trimmed, lower-case. */
export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * An email shown on a page anyone with the URL can open: the first letter of
 * the name, then the domain ("j•••@gmail.com"). Never the full address.
 */
export function maskEmail(email: string): string {
  const key = emailKey(email);
  const at = key.lastIndexOf('@');
  if (at < 1 || at === key.length - 1) return '•••';
  return `${key[0]}•••${key.slice(at)}`;
}

/** The trial's end for a trial starting at `start`: start + trialDays (as Stripe counts `trial_period_days`). */
export function academyTrialEnd(start: Date): Date {
  return new Date(start.getTime() + ACADEMY_FACTS.trialDays * DAY_MS);
}

/** The credit grant key (source_ref) of one trial month: `trial:<subscription>:<YYYY-MM of the slot's start>`. */
export function trialSlotKey(subscriptionId: string, slotKey: string): string {
  return `trial:${subscriptionId}:${slotKey}`;
}

/** The trial's monthly credit slots (trialMonths of them, the last ending at `trialEnd`). */
export function trialSlots(trialStart: Date, trialEnd: Date): MonthSlot[] {
  return monthSlots(trialStart, trialEnd, ACADEMY_FACTS.trialMonths);
}

/**
 * The trial month `now` falls in (slot 0, 1 or 2), or null before the trial
 * starts or once it has ended. The webhook grants slot 0 on the £0 trial
 * invoice; the daily credit sweep grants whatever slot is due, keyed with
 * trialSlotKey, so a replay is refused by the grant's unique key.
 */
export function trialMonthDue(trialStart: Date, trialEnd: Date, now: Date): MonthSlot | null {
  return monthSlotAt(trialStart, trialEnd, now, ACADEMY_FACTS.trialMonths);
}

// ── Linking a purchase to an account ──

export type LinkBy = 'auto' | 'admin';

export interface LinkPurchaseFacts {
  email: string;
  /** The Stripe customer the buyer paid as (the saved card lives on it). */
  stripeCustomerId: string | null;
  /** The card saved for off-session use at checkout. */
  stripePaymentMethodId: string | null;
  /** Set once the trial subscription exists: linking again does nothing. */
  trialSubscriptionId: string | null;
  /** The account it is linked to, if any. */
  userId: string | null;
  refundedAt: string | Date | null;
  /** When the buyer ticked the checkout terms box (the saved-card consent). */
  termsAcceptedAt: string | Date | null;
}

export interface LinkProfileFacts {
  id: string;
  /** The account's sign-in email. */
  email: string | null;
  /** Whether that sign-in email is confirmed (auth). */
  emailConfirmed: boolean;
  /** The profile's own Stripe customer, if it has one. */
  stripeCustomerId: string | null;
  /** Billing owned by a team owner. */
  isTeamMember: boolean;
}

export interface LinkInput {
  purchase: LinkPurchaseFacts;
  profile: LinkProfileFacts;
  /** Stripe reports a live plan (active/trialing/past_due/paused/unpaid/incomplete) on the profile's customer. */
  profileCustomerHasLivePlan: boolean;
  /** Stripe reports a live plan on the purchase's customer. */
  purchaseCustomerHasLivePlan: boolean;
  /** This email already has an earlier purchase that got a trial (one trial per buyer, ever). */
  emailHadEarlierTrial: boolean;
  /** 'auto' (checkout, sign-in, daily cron): emails must match. 'admin': linked by hand, may differ. */
  by: LinkBy;
}

/**
 * What linking does with Stripe customers. A saved card cannot move between
 * customers, so the trial always runs on the purchase's customer:
 *   use_purchase_customer        the profile has none: it takes the purchase's
 *   same_customer                the profile already is the purchase's customer
 *   switch_to_purchase_customer  the profile has another customer with no live
 *                                plan: the profile moves to the purchase's
 *                                customer, the old id kept (previous_customer_id)
 */
export type CustomerAction = 'use_purchase_customer' | 'same_customer' | 'switch_to_purchase_customer';

export type LinkRefusal =
  | 'refuse_live_plan'
  | 'refuse_email_mismatch'
  | 'refuse_unconfirmed_email'
  | 'refuse_refunded'
  | 'refuse_team_member'
  | 'refuse_no_consent'
  | 'refuse_repeat_purchase'
  /** No Stripe customer or saved card on the purchase: a trial has nothing to charge. */
  | 'refuse_no_card';

export type LinkDecision =
  | { decision: 'start'; customer: CustomerAction; customerId: string; previousCustomerId: string | null }
  | { decision: 'already'; userId: string | null }
  | { decision: LinkRefusal };

/**
 * Whether a purchase may start its trial on this account, and how. Checked in
 * this order (the first that applies wins): already started → refunded → no
 * consent → repeat purchase → no card → team member → unconfirmed email →
 * email mismatch (auto only) → a live plan on either customer.
 */
export function linkDecision(input: LinkInput): LinkDecision {
  const { purchase, profile, by } = input;
  if (purchase.trialSubscriptionId) return { decision: 'already', userId: purchase.userId };
  if (purchase.refundedAt) return { decision: 'refuse_refunded' };
  if (!purchase.termsAcceptedAt) return { decision: 'refuse_no_consent' };
  if (input.emailHadEarlierTrial) return { decision: 'refuse_repeat_purchase' };
  if (!purchase.stripeCustomerId || !purchase.stripePaymentMethodId) return { decision: 'refuse_no_card' };
  if (profile.isTeamMember) return { decision: 'refuse_team_member' };
  if (!profile.emailConfirmed) return { decision: 'refuse_unconfirmed_email' };
  if (by === 'auto' && (!profile.email || emailKey(profile.email) !== emailKey(purchase.email))) {
    return { decision: 'refuse_email_mismatch' };
  }
  if (input.purchaseCustomerHasLivePlan) return { decision: 'refuse_live_plan' };
  const purchaseCustomer = purchase.stripeCustomerId;
  if (!profile.stripeCustomerId) {
    return { decision: 'start', customer: 'use_purchase_customer', customerId: purchaseCustomer, previousCustomerId: null };
  }
  if (input.profileCustomerHasLivePlan) return { decision: 'refuse_live_plan' };
  if (profile.stripeCustomerId === purchaseCustomer) {
    return { decision: 'start', customer: 'same_customer', customerId: purchaseCustomer, previousCustomerId: null };
  }
  return { decision: 'start', customer: 'switch_to_purchase_customer', customerId: purchaseCustomer, previousCustomerId: profile.stripeCustomerId };
}

// ── The reminder email ──

/**
 * Days before the trial ends, counted the way the daily cron sees them: the
 * time left rounded UP to whole days. 7 means "more than 6 and at most 7 days
 * (7 × 24h) left", so a daily run meets each count once. 0 or less: ended.
 */
export function daysBeforeTrialEnd(trialEnd: Date, now: Date): number {
  return Math.ceil((trialEnd.getTime() - now.getTime()) / DAY_MS);
}

export interface ReminderState {
  /** Today's capped email slot is still free for this member. */
  slotFree: boolean;
  /** When the reminder went, if it has. */
  sentAt: string | Date | null;
  /** The subscription is still `trialing`. */
  trialing: boolean;
  /** The member has already cancelled (cancel_at_period_end or cancelled). */
  cancelling: boolean;
  /** The purchase was refunded. */
  refunded: boolean;
}

/**
 * skip        already sent, not trialing, cancelling, refunded, or the trial has ended
 * not_yet     more than reminderDaysBefore (7) days left: nothing to do yet
 * send        7 or 6 days left and today's slot is free: claim it and send
 * wait        7 or 6 days left but today's slot is taken: try again tomorrow
 * send_anyway reminderLatestDaysBefore (5) days left or fewer: send without the slot
 * Days are daysBeforeTrialEnd (whole days left, rounded up).
 */
export type ReminderDecision = 'skip' | 'not_yet' | 'wait' | 'send' | 'send_anyway';

export function reminderDecision(trialEnd: Date, now: Date, state: ReminderState): ReminderDecision {
  if (state.sentAt || !state.trialing || state.cancelling || state.refunded) return 'skip';
  const days = daysBeforeTrialEnd(trialEnd, now);
  if (days <= 0) return 'skip';
  if (days > ACADEMY_FACTS.reminderDaysBefore) return 'not_yet';
  if (days <= ACADEMY_FACTS.reminderLatestDaysBefore) return 'send_anyway';
  return state.slotFree ? 'send' : 'wait';
}
