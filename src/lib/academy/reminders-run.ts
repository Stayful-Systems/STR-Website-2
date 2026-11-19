import 'server-only';

/**
 * The daily Academy cron (Batch 31a, Phase 5): /api/internal/academy-reminders,
 * 06:47 UTC, before the morning picks (07:00), so on reminder day the
 * reminder takes the member's one capped email of the day (Zac's Q3).
 *
 *   (a) Link sweep. Password sign-ins never run the sign-in hooks, so an
 *       unlinked, unrefunded purchase whose email now belongs to exactly one
 *       account with a confirmed sign-in email is linked here ('auto'), as
 *       the sign-in hook would have.
 *   (b) Reminders. For each started trial with no reminder sent and its end
 *       within reminderDaysBefore (7) days: read the subscription in Stripe
 *       (still trialing? cancelling?) and ask rules.ts reminderDecision.
 *       'send' claims the day's slot ('academy_reminder'); a slot already
 *       used today means wait for tomorrow. 'send_anyway' (5 days or fewer
 *       left) tries the slot and sends whatever the answer. The email goes
 *       with the idempotency key academy-trial-reminder:<sub>, so no retry
 *       sends it twice, and reminder_sent_at is stamped after (only while
 *       still empty). It is a billing notice: marketing unsubscribes and
 *       notification switches do not apply.
 *
 * Dry run: who would be linked, who would get the reminder today (with the
 * full email), who waits, who is skipped and why; sends, claims and writes
 * nothing. Logs carry ids only, never an email.
 */
import type Stripe from 'stripe';
import { createAdminClient } from '../supabase/admin';
import { getStripe, stripeConfigured } from '../stripe/client';
import { priceIdForPlan } from '../stripe/prices';
import { cardSummary } from '../stripe/customer';
import { sendEmail, isEmailConfigured } from '../email/send';
import { abandonSend, claimSlot, finishSend, markSending, releaseClaim, slotsInUse } from '../notify/sends';
import { siteUrl } from '../url';
import { ACADEMY_FACTS, reminderDecision, type ReminderDecision } from './rules';
import { academyReminderEmail } from './emails';
import { academyCancelUrl } from './cancel-link';
import { poundsFromPence } from './checkout-params';
import { linkAcademyPurchase } from './deps';

const TIME_BUDGET_MS = 45_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 500;
const ID_CHUNK = 150;
/** Refusals that can clear by themselves (the account confirms its email, or is created later). */
const RETRY_FLAGS = ['unconfirmed_email', 'email_mismatch'];

type Admin = ReturnType<typeof createAdminClient>;

export interface AcademyRemindersResult {
  status: number;
  body: Record<string, unknown>;
}

interface PurchaseRow {
  id: string;
  email: string;
  user_id: string | null;
  trial_subscription_id: string | null;
  trial_ends_at: string | null;
  stripe_payment_method_id: string | null;
  flag_reason: string | null;
}

interface ProfileRow {
  id: string;
  email: string | null;
  stripe_default_payment_method_id: string | null;
}

function msg(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

async function profilesByEmail(admin: Admin, emails: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < emails.length; i += ID_CHUNK) {
    const { data, error } = await admin.from('profiles').select('id, email').in('email', emails.slice(i, i + ID_CHUNK));
    if (error) throw new Error(`profiles read failed: ${error.message}`);
    for (const r of (data ?? []) as { id: string; email: string }[]) out.set(r.email, [...(out.get(r.email) ?? []), r.id]);
  }
  return out;
}

async function profilesById(admin: Admin, ids: string[]): Promise<Map<string, ProfileRow>> {
  const out = new Map<string, ProfileRow>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await admin.from('profiles').select('id, email, stripe_default_payment_method_id').in('id', ids.slice(i, i + ID_CHUNK));
    if (error) throw new Error(`profiles read failed: ${error.message}`);
    for (const r of (data ?? []) as ProfileRow[]) out.set(r.id, r);
  }
  return out;
}

function pmId(pm: string | Stripe.PaymentMethod | null | undefined): string | null {
  if (!pm) return null;
  return typeof pm === 'string' ? pm : pm.id;
}

export async function runAcademyReminders(opts: { dry: boolean; now?: Date }): Promise<AcademyRemindersResult> {
  const started = Date.now();
  const dry = opts.dry;
  const now = opts.now ?? new Date();
  const outOfTime = () => Date.now() - started > TIME_BUDGET_MS;
  let admin: Admin;
  try {
    admin = createAdminClient();
  } catch {
    return { status: 503, body: { error: 'Storage not configured' } };
  }
  if (!stripeConfigured()) return { status: 503, body: { error: 'Stripe not configured' } };

  const errors: string[] = [];
  let ranOutOfTime = false;

  // ── (a) Link sweep ──
  const wouldLink: Array<Record<string, unknown>> = [];
  let linked = 0;
  {
    const { data, error } = await admin
      .from('academy_purchases')
      .select('id, email, user_id, trial_subscription_id, trial_ends_at, stripe_payment_method_id, flag_reason')
      .is('user_id', null)
      .is('trial_subscription_id', null)
      .is('refunded_at', null)
      .or(`flag_reason.is.null,flag_reason.in.(${RETRY_FLAGS.join(',')})`)
      .order('created_at', { ascending: true })
      .limit(PAGE);
    if (error) return { status: 500, body: { error: `academy_purchases read failed (schema.sql not run?): ${error.message}` } };
    const unlinked = (data ?? []) as PurchaseRow[];
    let byEmail = new Map<string, string[]>();
    try {
      byEmail = await profilesByEmail(admin, [...new Set(unlinked.map((p) => p.email))]);
    } catch (err) {
      errors.push(msg(err));
    }
    const confirmed = new Map<string, boolean>();
    for (const p of unlinked) {
      if (outOfTime()) {
        ranOutOfTime = true;
        break;
      }
      const ids = byEmail.get(p.email) ?? [];
      if (ids.length !== 1) continue; // no account yet (or, impossibly, two): nothing to link to
      const userId = ids[0];
      try {
        if (!confirmed.has(userId)) {
          const { data: auth, error: authErr } = await admin.auth.admin.getUserById(userId);
          if (authErr) throw new Error(`auth user read failed: ${authErr.message}`);
          confirmed.set(userId, Boolean(auth.user?.email_confirmed_at));
        }
        if (!confirmed.get(userId)) continue;
        const r = await linkAcademyPurchase(p.id, userId, 'auto', { dry });
        if (dry) wouldLink.push({ purchaseId: p.id, userId, outcome: r.outcome, decision: r.decision, reason: r.reason, trialEnd: r.trialEnd ?? null });
        else if (r.outcome === 'start' && r.done) linked += 1;
        else if (r.outcome === 'error') errors.push(`link ${p.id}: ${r.reason ?? 'error'}`);
      } catch (err) {
        errors.push(`link ${p.id}: ${msg(err)}`);
        console.error(`[academy-reminders] link of purchase ${p.id} failed:`, msg(err));
      }
    }
  }

  // ── (b) Reminders ──
  const wouldSend: Array<Record<string, unknown>> = [];
  const waiting: Array<Record<string, unknown>> = [];
  const skipped: Array<{ purchaseId: string; reason: string }> = [];
  let sent = 0;
  let waited = 0;
  let failed = 0;

  // Window: trials ending within reminderDaysBefore days (one spare day for a Stripe end later than ours).
  const horizon = new Date(now.getTime() + (ACADEMY_FACTS.reminderDaysBefore + 1) * DAY_MS).toISOString();
  const { data: dueData, error: dueErr } = await admin
    .from('academy_purchases')
    .select('id, email, user_id, trial_subscription_id, trial_ends_at, stripe_payment_method_id, flag_reason')
    .not('trial_subscription_id', 'is', null)
    .not('user_id', 'is', null)
    .is('refunded_at', null)
    .is('reminder_sent_at', null)
    .gt('trial_ends_at', now.toISOString())
    .lte('trial_ends_at', horizon)
    .order('trial_ends_at', { ascending: true })
    .limit(PAGE);
  if (dueErr) return { status: 500, body: { error: `academy_purchases read failed (schema.sql not run?): ${dueErr.message}` } };
  const due = (dueData ?? []) as PurchaseRow[];

  let profiles = new Map<string, ProfileRow>();
  try {
    profiles = await profilesById(admin, [...new Set(due.map((p) => p.user_id as string))]);
  } catch (err) {
    errors.push(msg(err));
  }
  // Dry: whose slot is already used today (read only; a real run relies on the claim itself).
  const inUse = dry && due.length > 0 ? await slotsInUse(admin, [...new Set(due.map((p) => p.user_id as string))], 'daily', now) : null;

  const stripe = getStripe();
  let amount: string | null | undefined;
  const proAmount = async (): Promise<string | null> => {
    if (amount !== undefined) return amount;
    const priceId = priceIdForPlan('pro');
    if (!priceId) return (amount = null);
    try {
      const price = await stripe.prices.retrieve(priceId);
      amount = price.recurring?.interval === 'month' && price.recurring.interval_count === 1 ? poundsFromPence(price.unit_amount, price.currency) : null;
    } catch (err) {
      console.error('[academy-reminders] Pro price read failed:', msg(err));
      amount = null;
    }
    return amount;
  };
  const emailOn = isEmailConfigured();
  const base = siteUrl();

  for (const p of due) {
    if (outOfTime()) {
      ranOutOfTime = true;
      break;
    }
    const subId = p.trial_subscription_id as string;
    const userId = p.user_id as string;
    try {
      let sub: Stripe.Subscription | null = null;
      try {
        sub = await stripe.subscriptions.retrieve(subId);
      } catch (err) {
        if ((err as { code?: string })?.code !== 'resource_missing') throw err;
      }
      if (!sub) {
        skipped.push({ purchaseId: p.id, reason: 'subscription_missing' });
        continue;
      }
      const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : new Date(p.trial_ends_at as string);
      const state = {
        sentAt: null,
        trialing: sub.status === 'trialing',
        cancelling: Boolean(sub.cancel_at_period_end || sub.cancel_at || sub.status === 'canceled'),
        refunded: false,
      };
      // First without the slot: is today a reminder day at all?
      const first: ReminderDecision = reminderDecision(trialEnd, now, { ...state, slotFree: true });
      if (first === 'skip' || first === 'not_yet') {
        skipped.push({ purchaseId: p.id, reason: first === 'not_yet' ? 'not_yet' : !state.trialing ? `not_trialing:${sub.status}` : state.cancelling ? 'cancelling' : 'ended' });
        continue;
      }

      const profile = profiles.get(userId);
      const to = profile?.email ?? p.email;
      const last4 =
        (await cardSummary(pmId(sub.default_payment_method)))?.last4 ??
        (await cardSummary(profile?.stripe_default_payment_method_id ?? null))?.last4 ??
        (await cardSummary(p.stripe_payment_method_id))?.last4 ??
        null;
      const price = await proAmount();
      if (!last4 || !price) {
        failed += 1;
        const why = !price ? 'pro_price_unavailable' : 'no_card';
        errors.push(`reminder ${p.id}: ${why}`);
        continue;
      }
      const mail = academyReminderEmail({ date: trialEnd, amount: price, last4, cancelUrl: academyCancelUrl(subId, trialEnd), months: ACADEMY_FACTS.trialMonths, siteUrl: base });
      const summary = { academyReminder: true, purchaseId: p.id, subscriptionId: subId, subject: mail.subject };

      if (dry) {
        const slotFree = !inUse?.has(userId);
        const decision = reminderDecision(trialEnd, now, { ...state, slotFree });
        if (decision === 'wait') waiting.push({ purchaseId: p.id, userId, slotTakenBy: inUse?.get(userId)?.kind ?? null });
        else wouldSend.push({ purchaseId: p.id, userId, decision, slotFree, subject: mail.subject, text: mail.text });
        continue;
      }

      if (!emailOn) {
        failed += 1;
        errors.push(`reminder ${p.id}: email_not_configured`);
        continue;
      }
      const claim = await claimSlot(admin, userId, 'academy_reminder', now);
      const decision = reminderDecision(trialEnd, now, { ...state, slotFree: claim.ok });
      if (decision === 'wait') {
        // Slot used today (or the record unavailable): tomorrow; on day 5 it goes anyway.
        waited += 1;
        continue;
      }
      if (decision !== 'send' && decision !== 'send_anyway') {
        if (claim.ok) await releaseClaim(admin, claim.id);
        skipped.push({ purchaseId: p.id, reason: decision });
        continue;
      }
      let sending = false;
      if (claim.ok) {
        sending = await markSending(admin, claim.id, summary, null);
        if (!sending) {
          await releaseClaim(admin, claim.id);
          if (decision === 'send') {
            // The record could not be written: try again tomorrow rather than send outside it.
            waited += 1;
            continue;
          }
        }
      }
      const res = await sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text, idempotencyKey: `academy-trial-reminder:${subId}` });
      if (!res.sent) {
        if (claim.ok && sending) await abandonSend(admin, claim.id);
        failed += 1;
        errors.push(`reminder ${p.id}: ${res.reason ?? 'send_failed'}`);
        continue;
      }
      if (claim.ok && sending) await finishSend(admin, claim.id, true, summary, []);
      const { error: stampErr } = await admin
        .from('academy_purchases')
        .update({ reminder_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', p.id)
        .is('reminder_sent_at', null);
      // Logged to fix by hand: an unstamped reminder could go again tomorrow (Resend keeps a key 24 hours).
      if (stampErr) console.error(`[academy-reminders] reminder stamp for purchase ${p.id} failed:`, stampErr.message);
      sent += 1;
    } catch (err) {
      failed += 1;
      errors.push(`reminder ${p.id}: ${msg(err)}`);
      console.error(`[academy-reminders] reminder for purchase ${p.id} failed:`, msg(err));
    }
  }

  const ms = Date.now() - started;
  if (dry) return { status: 200, body: { dry: true, wouldLink, wouldSend, waiting, skipped, errors, ranOutOfTime, ms } };
  return { status: 200, body: { dry: false, linked, sent, waited, skipped: skipped.length, skippedDetail: skipped, failed, errors, ranOutOfTime, ms } };
}
