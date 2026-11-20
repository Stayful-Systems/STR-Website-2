/**
 * Stripe event → credit ledger. Pure-ish: everything that touches the
 * database, Stripe or email goes through `deps`, so the handler is unit
 * tested with fakes (webhook.test.ts) and the route wires the real thing.
 *
 * API version 2026-04-22.dahlia shapes: an invoice's subscription lives at
 * invoice.parent.subscription_details.subscription, a subscription's period
 * on its items, and a line's price at line.pricing.price_details.price.
 */

import { addMonthsClamped } from './annual.ts';
import type Stripe from 'stripe';
import { planForPriceId, topupPenceForPriceId, type Env } from './prices.ts';
import { subscriptionStateFromStripe } from '../subscription.ts';
import type { SubscriptionEventInput } from '../billing/subscription-events.ts';
import { planActivityKind, type ActivityKind } from '../activity/kinds.ts';
import type { InvoiceFacts, PackFacts, RepeatFacts } from '../meta/events.ts';
import { invoicePaymentIntentId, paymentFromIntent, paymentFromInvoice, type PaymentRecord, type RefundRecord } from '../payments/rules.ts';
import { trialSlotKey, trialSlots } from '../academy/rules.ts';
import { disputeWonRef, planInvoiceScope, refundedShare, trialEndedUnpaid, type AnnualInvoiceYear } from './plan-credit.ts';

import type { PlanSourceMatch, PlanSourceOptions } from '../credit/ledger.ts';

/** Batch 32: the reasons plan credit is removed under (credit_expire_plan_source's ledger rows carry them). */
export type PlanClawbackReason = 'plan_refunded' | 'plan_disputed';

export interface WebhookUser {
  id: string;
  email: string | null;
  plan_code: string | null;
  /** 'manual' marks a plan granted by hand that a stray Stripe event must not revoke. */
  plan_source?: string | null;
  // The rest is what the churn log needs and the profile write alone did not.
  // `cancel_reason` is read on the way OUT: the reason was captured when the
  // cancellation was scheduled, and this is the last moment it can be attached
  // to the event that records the member actually leaving.
  cancel_reason?: string | null;
  cancel_reason_comment?: string | null;
  /** Previous state, to tell a NEW pause or cancel from one merely re-reported. */
  subscription_cancel_at?: string | null;
  subscription_paused_until?: string | null;
  stripe_subscription_status?: string | null;
}

export interface WebhookDeps {
  env?: Env;
  findUserBySubscription(subscriptionId: string): Promise<WebhookUser | null>;
  findUserByCustomer(customerId: string): Promise<WebhookUser | null>;
  findUserByEmail(email: string): Promise<WebhookUser | null>;
  findUserById(userId: string): Promise<WebhookUser | null>;
  updateProfile(userId: string, patch: Record<string, unknown>): Promise<void>;
  grantPlanCycle(userId: string, planCode: string, sourceRef: string, periodEnd: Date | null, email: string | null): Promise<void>;
  grantUpgradeDifference(userId: string, fromPlanCode: string | null, toPlanCode: string, sourceRef: string, periodEnd: Date | null): Promise<void>;
  grantTopup(userId: string, amountPence: number, sourceRef: string, email: string | null): Promise<boolean>;
  /**
   * Batch 32 (plan credit rollover): removes up to `maxPence` (null = all) of
   * the member's plan credit in grants whose source_ref matches, never below
   * zero, no other credit touched (credit_expire_plan_source). Optional:
   * without it no plan credit is ever removed here. Plan credit is no longer
   * expired when a subscription ends, is paused or is downgraded.
   */
  expirePlanSource?(userId: string, match: PlanSourceMatch, maxPence: number | null, reason: string, opts?: PlanSourceOptions): Promise<{ expiredPence: number; grants: number }>;
  /**
   * Batch 32: the plan invoice a payment paid (member_payments, else Stripe's
   * invoice payments), or null when it paid no plan invoice. `paidPence` is
   * what the invoice charged. `annual` is set when it paid an annual plan's
   * year (its credit is that year's `annual:<sub>:` slot grants, not an
   * `inv:<id>` grant). A failed lookup throws (Stripe retries).
   */
  planInvoiceForPayment?(paymentIntentId: string): Promise<{ userId: string; invoiceId: string; paidPence: number; annual?: AnnualInvoiceYear | null } | null>;
  /**
   * Batch 32: the plan credit granted for the invoice (its `inv:<id>` grant,
   * or with `annual` the subscription's slot grants made in that year) and
   * what has already been removed from it under `reason`.
   */
  planInvoiceCredit?(userId: string, invoiceId: string, reason: PlanClawbackReason, annual?: AnnualInvoiceYear | null): Promise<{ grantedPence: number; removedPence: number }>;
  /** Batch 32: a won dispute's credit back, as a plan grant under `sourceRef` (idempotent on it); true when this call granted it. */
  restorePlanCredit?(userId: string, sourceRef: string, amountPence: number, description: string): Promise<boolean>;
  /**
   * Batch 32: whether the subscription has a paid plan invoice (money taken,
   * not a £0 trial invoice). Null when it cannot be told. Used to tell an
   * Academy trial that ended unpaid from one that went on to a paid month.
   */
  subscriptionHasPaidInvoice?(userId: string, subscriptionId: string): Promise<boolean | null>;
  savePaymentMethod(userId: string, customerId: string | null, paymentMethodId: string): Promise<void>;
  retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent | null>;
  /**
   * Batch 20: the same, but a lookup that fails (Stripe down, a timeout)
   * throws instead of answering null; null only when there is no such
   * payment. For a refund or dispute, where "could not tell" must be retried,
   * not taken as "not ours".
   */
  retrievePaymentIntentStrict?(id: string): Promise<Stripe.PaymentIntent | null>;
  retrieveSubscription(id: string): Promise<Stripe.Subscription | null>;
  /** Every subscription the customer holds; used to spot a late delete for a superseded plan. */
  listSubscriptions?(customerId: string): Promise<Stripe.Subscription[]>;
  refundTopup?(userId: string, sourceRef: string, amountPence: number, reason: string): Promise<void>;
  onSubscriptionStarted(email: string): Promise<void>;
  onSubscriptionCancelled(email: string): Promise<void>;
  /**
   * Append to the churn log. Implementations must swallow their own errors —
   * see recordSubscriptionEvent in ../billing/subscription-events.ts for why a
   * failed log write must never fail the delivery.
   */
  recordSubscriptionEvent?(input: SubscriptionEventInput): Promise<unknown>;
  paymentFailedEmail(email: string, planName: string | null): Promise<unknown>;
  cardNeedsUpdateEmail(email: string): Promise<unknown>;
  /**
   * The activity log (Batch 9, src/lib/activity): only what the member did,
   * a plan started or changed, a pause or cancellation made in Stripe's
   * portal, a top-up. Optional, like recordSubscriptionEvent; implementations
   * must swallow their own errors.
   */
  logActivity?(input: WebhookActivity): Promise<unknown>;
  /**
   * Batch 23: a top-up bought from Stayful Intelligence's auto top-up link
   * with no saved card switches auto top-up on in the same flow — only if it
   * is still off (never overwrites a member's own setting). True when it
   * switched it on. Optional; implementations must swallow their own errors.
   */
  enableAutoTopup?(userId: string, amountPence: number, thresholdPence: number): Promise<boolean>;
  /**
   * Meta's Subscribe, Purchase and RepeatPurchase (Batch 19 and 29,
   * src/lib/meta/conversions.ts): the facts go in, and it decides whether
   * they count. Recorded once per member and event, so a redelivery, or a
   * top-up's two events, is one conversion. Purchase is the starter pack
   * only; RepeatPurchase a pack buyer's first payment after it.
   * Optional; implementations must swallow their own errors.
   */
  recordConversion?(input: WebhookConversion): Promise<unknown>;
  /**
   * Batch 20 (src/lib/payments): the rows behind "Total paid". A payment is
   * written once per Stripe id and a refund as the charge's cumulative
   * amount, so a redelivery, or a top-up's two events, change nothing.
   * Optional; implementations must swallow their own errors.
   */
  recordPayment?(payment: PaymentRecord): Promise<unknown>;
  recordRefund?(refund: RefundRecord): Promise<unknown>;
  /** Review R4 (R4-14): a dispute opened (open) or closed in our favour (not open) on a payment; implementations must swallow their own errors. */
  recordDispute?(input: { paymentIntentId: string; open: boolean }): Promise<unknown>;
  /** The PaymentIntent a paid invoice was paid with (its refunds are matched on it); null when it cannot be told. */
  invoicePaymentIntent?(invoiceId: string): Promise<string | null>;
  /**
   * Batch 20's £10 starter pack (src/lib/starter-pack/grant-server.ts). The
   * card is authorised, not captured: settle claims the pack once per
   * person and captures it, or cancels a repeat so it is never charged;
   * grant runs on the captured payment and is idempotent (a redelivery or
   * both events grant once); clawback takes the credit back on a refund or a
   * dispute. Optional: without them a pack payment is left alone.
   */
  settleStarterPack?(paymentIntentId: string): Promise<string>;
  grantStarterPack?(input: { paymentIntent: Stripe.PaymentIntent; email: string | null }): Promise<'granted' | 'already' | 'blocked' | 'ignored'>;
  clawbackStarterPack?(input: { userId: string; paymentIntentId: string; refundedPence: number; chargedPence: number; reason: 'refunded' | 'disputed' }): Promise<unknown>;
  /**
   * Batch 21 (B17): a dispute closed in our favour (won, or an inquiry that
   * closed with nothing taken) gives back what charge.dispute.created took
   * from a top-up or a starter pack. Returns the pence restored; idempotent.
   */
  restoreDisputedCredit?(userId: string, paymentIntentId: string): Promise<number>;
  /**
   * Batch 31a: the Stayful Academy (src/lib/academy). Optional: without it an
   * Academy payment is still kept off the generic one-off path (it is never
   * treated as a top-up, nor its customer written to a profile).
   */
  academy?: AcademyWebhookDeps;
  log?: (msg: string) => void;
}

/** Batch 31a: one Academy purchase as the webhook records it (academy_purchases). */
export interface AcademyPurchaseInput {
  /** The checkout email, lower-case (emailKey). */
  email: string;
  customerId: string | null;
  paymentIntentId: string;
  /** The card saved for off-session use, from the payment intent. */
  paymentMethodId: string | null;
  /** What was charged (the payment intent's amount_received). */
  amountPence: number | null;
  paidAt: string;
  checkoutSessionId: string | null;
  /** Set when the checkout terms box was ticked (session.consent.terms_of_service = 'accepted'). */
  termsAcceptedAt: string | null;
}

export interface AcademyWebhookDeps {
  /**
   * Write the purchase once per payment intent (on conflict do nothing) and
   * return its row id, the existing row's on a replay; null if it could not
   * be written or found.
   */
  recordPurchase(input: AcademyPurchaseInput): Promise<{ id: string } | null>;
  /**
   * Link the purchase to this account and start its trial
   * (linkAcademyPurchase(purchaseId, userId, 'auto')); a note for the log.
   * Idempotent: a replay answers "already".
   */
  linkAfterPurchase(purchaseId: string, userId: string): Promise<string>;
  /** A refund of the Academy payment (cancelTrialForRefund); a note for the log. */
  cancelTrialForRefund(paymentIntentId: string, fullyRefunded: boolean): Promise<string>;
  /**
   * Batch 32: the member and trial subscription of the Academy purchase paid
   * with this payment, so a full refund removes that trial's credit
   * (`trial:<sub>:` grants) and nothing else. Null when there is none.
   */
  trialFor?(paymentIntentId: string): Promise<{ userId: string | null; subscriptionId: string | null } | null>;
}

export type WebhookConversion =
  | { name: 'Subscribe'; userId: string; eventId: string | null; invoice: InvoiceFacts }
  | { name: 'Purchase'; userId: string; eventId: string; pack: PackFacts }
  | { name: 'RepeatPurchase'; userId: string; eventId: string; repeat: RepeatFacts };

export interface WebhookActivity {
  userId: string;
  kind: ActivityKind;
  /** The same action from another delivery, or already logged by the app, is ignored. */
  dedupeKey?: string;
  source?: 'system' | 'sms_link';
  extras?: Record<string, string | number | boolean | null>;
}

export interface HandleResult {
  handled: boolean;
  note?: string;
}

function id(x: string | { id: string } | null | undefined): string | null {
  if (!x) return null;
  return typeof x === 'string' ? x : x.id;
}

function periodEndOf(sub: Stripe.Subscription | null): Date | null {
  const secs = sub?.items?.data?.[0]?.current_period_end;
  return secs ? new Date(secs * 1000) : null;
}

function priceIdOf(sub: Stripe.Subscription | null): string | null {
  return sub?.items?.data?.[0]?.price?.id ?? null;
}

const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

function isoFromUnix(seconds: number | null | undefined): string | null {
  if (!seconds) return null;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The self-serve pause / cancel columns, re-derived in full from the
 * subscription so a replayed event writes the same row and an auto-resume
 * (which arrives as `pause_collection: null`) clears the window by itself.
 * Shared with the /account server actions via subscriptionStateFromStripe.
 */
function subscriptionColumns(sub: Stripe.Subscription, ended = false): Record<string, unknown> {
  const state = subscriptionStateFromStripe(sub);
  const patch: Record<string, unknown> = {
    subscription_paused_from: state.pausedFrom,
    subscription_paused_until: state.pausedUntil,
    subscription_cancel_at: state.cancelAt,
    subscription_current_period_end: state.currentPeriodEnd,
  };
  if (!state.cancelAt && !ended) {
    // A cleared cancel_at means one of two opposite things, and this used to
    // treat them alike: the member changed their mind, OR the subscription
    // finally ended (Stripe drops cancel_at once it does). Clearing the reason
    // in the second case destroyed it at the exact moment it became the answer
    // to "why did they leave?", which is the whole point of capturing it.
    //
    // So: only while the subscription is still LIVE does a cleared cancel_at
    // mean the reason no longer describes anything.
    patch.cancel_reason = null;
    patch.cancel_reason_comment = null;
    patch.cancel_reason_at = null;
  }
  return patch;
}

/**
 * Stripe's own cancellation feedback, mapped onto our reason slugs.
 *
 * This is how a cancel done in the Stripe Customer Portal gets a reason at all:
 * the portal never touches cancelSubscriptionAction, so without this every
 * customer who leaves that way churns silently.
 */
const STRIPE_FEEDBACK_TO_REASON: Record<string, string> = {
  too_expensive: 'too_expensive',
  missing_features: 'missing_feature',
  switched_service: 'another_tool',
  unused: 'not_using',
  customer_service: 'other',
  too_complex: 'other',
  low_quality: 'other',
  other: 'other',
};

export function reasonFromStripeFeedback(feedback: string | null | undefined): string | null {
  if (!feedback) return null;
  return STRIPE_FEEDBACK_TO_REASON[feedback] ?? 'other';
}

/** What Stripe recorded when the subscription was cancelled, if anything. */
function cancellationFromStripe(sub: Stripe.Subscription): { reason: string | null; comment: string | null } {
  const details = sub.cancellation_details ?? null;
  return {
    reason: reasonFromStripeFeedback(details?.feedback ?? null),
    comment: details?.comment ?? null,
  };
}

/**
 * Fire-and-forget append to the churn log.
 *
 * The dep is optional so every existing test that builds a WebhookDeps by hand
 * keeps compiling, and the await is guarded so a missing implementation is a
 * no-op rather than a crash.
 */
async function logEvent(deps: WebhookDeps, input: SubscriptionEventInput): Promise<void> {
  await logPlanActivity(deps, input);
  if (!deps.recordSubscriptionEvent) return;
  try {
    await deps.recordSubscriptionEvent(input);
  } catch (err) {
    (deps.log ?? ((m: string) => console.log(`[stripe/webhook] ${m}`)))(`churn log failed: ${String(err)}`);
  }
}

/**
 * A subscription change the member made, for the activity log. A start is
 * keyed by subscription, because Stripe reports a new one twice (checkout,
 * then the subscription itself); a plan set up by hand is not the member's
 * doing. Never throws.
 */
async function logPlanActivity(deps: WebhookDeps, input: SubscriptionEventInput): Promise<void> {
  // The event's own source decides whose action this is (E20). A change the
  // member made in the app is already logged there as self_serve, so the
  // webhook's copy is dropped; one Stripe reports with no portal feedback is
  // treated as the dashboard's and is not the member's (planActivityKind gates
  // the member kinds on it). An event with no recorded source is 'stripe', the
  // same default recordSubscriptionEvent uses.
  const source = input.source ?? 'stripe';
  const kind = planActivityKind(input.kind, source);
  if (!deps.logActivity || !kind || source === 'manual' || source === 'self_serve') return;
  const dedupeKey =
    kind === 'plan_start' && input.stripeSubscriptionId ? `plan_start:${input.stripeSubscriptionId}` : input.stripeEventId ? `sub:${input.stripeEventId}:${input.kind}` : undefined;
  try {
    await deps.logActivity({ userId: input.userId, kind, dedupeKey, extras: input.planCode ? { plan: input.planCode } : undefined });
  } catch {
    // The activity log never fails a delivery.
  }
}

/** A top-up, for the activity log: the same key as the app's own, so it is only ever counted once. Never throws. */
/** Batch 23: the auto top-up link's top-up (metadata auto_topup_on = '1') switches auto top-up on, once. */
async function enableAutoTopupFromLink(deps: WebhookDeps, userId: string, paymentIntentId: string, metadata: Record<string, string> | null | undefined, amountPence: number): Promise<void> {
  if (!deps.enableAutoTopup || metadata?.auto_topup_on !== '1' || !(amountPence > 0)) return;
  const threshold = Number(metadata.auto_topup_threshold_pence);
  if (!Number.isInteger(threshold) || threshold < 100 || threshold > 10_000) return;
  try {
    if (await deps.enableAutoTopup(userId, amountPence, threshold)) {
      await deps.logActivity?.({ userId, kind: 'auto_topup_settings', dedupeKey: `auto_topup_on:pi:${paymentIntentId}`, source: 'sms_link', extras: { on: true, via: 'si_link' } });
    }
  } catch {
    // Never fails a delivery: the member can switch it on in Billing.
  }
}

async function logTopupActivity(deps: WebhookDeps, userId: string, paymentIntentId: string, amountPence: number, auto: boolean): Promise<void> {
  if (!deps.logActivity) return;
  try {
    await deps.logActivity({ userId, kind: auto ? 'auto_topup' : 'topup', dedupeKey: `topup:pi:${paymentIntentId}`, source: auto ? 'system' : undefined, extras: { amount_pence: amountPence } });
  } catch {
    // The activity log never fails a delivery.
  }
}

async function recordMetaConversion(deps: WebhookDeps, input: WebhookConversion): Promise<void> {
  if (!deps.recordConversion) return;
  try {
    await deps.recordConversion(input);
  } catch {
    // Measuring an ad never fails a delivery.
  }
}

/** Batch 20: a payment for "Total paid". Never throws. */
async function recordPaymentRow(deps: WebhookDeps, payment: PaymentRecord | null): Promise<void> {
  if (!deps.recordPayment || !payment) return;
  try {
    await deps.recordPayment(payment);
  } catch {
    // Bookkeeping never fails a delivery.
  }
}

/** Batch 20: the PaymentIntent a paid invoice was paid with, from the invoice or else Stripe. Never throws. */
async function invoicePaymentIntentFor(deps: WebhookDeps, invoice: Stripe.Invoice): Promise<string | null> {
  const fromInvoice = invoicePaymentIntentId(invoice as unknown as Parameters<typeof invoicePaymentIntentId>[0]);
  if (fromInvoice || !deps.invoicePaymentIntent || !invoice.id) return fromInvoice;
  try {
    return await deps.invoicePaymentIntent(invoice.id);
  } catch {
    return null;
  }
}

/**
 * Batch 20: a charge's refunds for "Total paid", whatever was bought (a pack,
 * a top-up or a subscription invoice). The member is the one the payment was
 * for, else the charge's customer. Never throws.
 */
async function recordChargeRefund(deps: WebhookDeps, charge: Stripe.Charge): Promise<void> {
  // A released authorisation (a repeat pack cancelled before capture) is reported as refunded, but nothing was paid.
  if (!deps.recordRefund || !charge?.id || charge.captured === false) return;
  try {
    const piId = id(charge.payment_intent);
    const pi = piId ? await deps.retrievePaymentIntent(piId) : null;
    let userId = pi?.metadata?.user_id ?? null;
    if (!userId && id(charge.customer)) userId = (await deps.findUserByCustomer(id(charge.customer)!))?.id ?? null;
    if (!userId) return;
    await deps.recordRefund({ chargeId: charge.id, userId, paymentIntentId: piId, amountRefundedPence: Number(charge.amount_refunded) || 0 });
  } catch {
    // Bookkeeping never fails a delivery.
  }
}

/**
 * Review R4 (R4-14): a payment under a dispute (or one closed in our favour)
 * for public.member_payment_dispute: a charged-back further payment no longer
 * counts as paying again. Never throws.
 */
async function recordDisputeMark(deps: WebhookDeps, dispute: Stripe.Dispute, open: boolean): Promise<void> {
  const piId = id(dispute?.payment_intent);
  if (!deps.recordDispute || !piId) return;
  try {
    await deps.recordDispute({ paymentIntentId: piId, open });
  } catch {
    // Bookkeeping never fails a delivery.
  }
}

/**
 * Batch 20: a captured starter pack. The grant is idempotent, and the
 * activity, Meta's Purchase and the payment row are each keyed on the
 * PaymentIntent, so a redelivery (or the one-click route having done it
 * already) changes nothing. A repeat that was charged anyway is a top-up.
 */
async function handleStarterPackPaid(pi: Stripe.PaymentIntent, deps: WebhookDeps): Promise<HandleResult> {
  if (!deps.grantStarterPack) return { handled: false, note: 'starter pack not configured' };
  const userId = pi.metadata?.user_id;
  const user = userId ? await deps.findUserById(userId) : null;
  if (!user) return { handled: false, note: 'no user for starter pack' };
  const pm = id(pi.payment_method);
  if (pm) await deps.savePaymentMethod(user.id, id(pi.customer), pm);
  const outcome = await deps.grantStarterPack({ paymentIntent: pi, email: user.email });
  if (outcome === 'ignored') return { handled: false, note: 'starter pack payment not captured' };
  const pricePence = Math.round(Number(pi.metadata?.price_pence) || 0) || pi.amount_received || pi.amount;
  if (deps.logActivity) {
    try {
      // A repeat charged anyway became a top-up, and is logged as one.
      if (outcome === 'blocked') await deps.logActivity({ userId: user.id, kind: 'topup', dedupeKey: `topup:pi:${pi.id}`, extras: { amount_pence: pricePence } });
      else await deps.logActivity({ userId: user.id, kind: 'starter_pack', dedupeKey: `starter_pack:pi:${pi.id}`, extras: { amount_pence: pricePence } });
    } catch {
      // The activity log never fails a delivery.
    }
  }
  // Meta's Purchase (Batch 29: the pack only): its price excluding VAT, once per member. A repeat charged
  // anyway (blocked) sends nothing: it is not the pack, nor a payment after it.
  if (outcome !== 'blocked') await recordMetaConversion(deps, { name: 'Purchase', userId: user.id, eventId: pi.id, pack: { pricePence, currency: pi.currency, outcome } });
  await recordPaymentRow(deps, paymentFromIntent(pi, user.id));
  return { handled: true, note: `starter pack ${outcome}` };
}

/** Batch 20: a refund or dispute on a starter pack's charge, or null when it is not one. */
async function clawbackPackIfPack(event: Stripe.Event, deps: WebhookDeps): Promise<HandleResult | null> {
  if (!deps.clawbackStarterPack) return null;
  const obj = event.data.object as Stripe.Charge | Stripe.Dispute;
  const charge = event.type === 'charge.refunded' ? (obj as Stripe.Charge) : null;
  const piId = charge ? id(charge.payment_intent) : id((obj as Stripe.Dispute).payment_intent);
  if (!piId) return null;
  // Not knowing whether it was a pack must not lose its clawback for good: a failed lookup throws, and Stripe sends it again.
  const pi = deps.retrievePaymentIntentStrict ? await deps.retrievePaymentIntentStrict(piId) : await deps.retrievePaymentIntent(piId);
  if (pi?.metadata?.kind !== 'starter_pack' || !pi.metadata.user_id) return null;
  // A hold released before capture (a repeat pack, or one never captured) is reported as refunded: no credit was ever given.
  if (charge && charge.captured === false) return { handled: true, note: 'starter pack authorisation released (never charged)' };
  const refundedPence = charge ? Number(charge.amount_refunded) || 0 : Number((obj as Stripe.Dispute).amount) || 0;
  const chargedPence = charge ? Number(charge.amount) || 0 : Number(pi.amount_received ?? pi.amount) || 0;
  await deps.clawbackStarterPack({ userId: pi.metadata.user_id, paymentIntentId: piId, refundedPence, chargedPence, reason: event.type === 'charge.refunded' ? 'refunded' : 'disputed' });
  return { handled: true, note: 'starter pack credit clawed back' };
}

// ── Batch 31a: Stayful Academy ──
// The Academy is a one-off payment (metadata kind 'academy' on the Checkout
// session and its payment intent) that gives 3 months of Intelligence Pro free
// (src/lib/academy). Its checkout is handled before the generic one-off path
// and returns: it never writes the profile's Stripe customer, saves a card or
// grants a top-up; linking (src/lib/academy/link.ts) decides all of that. Its
// trial's £0 first invoice credits month 1 only (the credit sweep grants months
// 2 and 3), and its refund cancels the trial instead of touching Total paid.

/** The Academy checkout: record the purchase, then link it to the buyer's account if there is one. */
async function handleAcademyCheckout(session: Stripe.Checkout.Session, prefetchedPi: Stripe.PaymentIntent | null, deps: WebhookDeps): Promise<HandleResult> {
  if (!deps.academy) return { handled: false, note: 'academy not configured' };
  // Card only, so it should be paid; anything else is left for a person to look at.
  if (session.payment_status !== 'paid') return { handled: true, note: `academy checkout ${session.payment_status ?? 'unknown'}: not recorded` };
  const piId = id(session.payment_intent);
  if (!piId) return { handled: false, note: 'academy checkout without payment intent' };
  const rawEmail = session.customer_details?.email ?? session.customer_email ?? null;
  if (!rawEmail) return { handled: false, note: 'academy checkout without email' };
  const email = rawEmail.trim().toLowerCase();
  // Strict: a Stripe outage throws (the route answers 500 and Stripe retries) rather than saving the
  // purchase without its card.
  const pi = prefetchedPi ?? (deps.retrievePaymentIntentStrict ? await deps.retrievePaymentIntentStrict(piId) : await deps.retrievePaymentIntent(piId));
  const purchase = await deps.academy.recordPurchase({
    email,
    customerId: id(session.customer) ?? id(pi?.customer),
    paymentIntentId: piId,
    paymentMethodId: id(pi?.payment_method),
    amountPence: pi?.amount_received ?? session.amount_total ?? null,
    paidAt: isoFromUnix(session.created) ?? new Date().toISOString(),
    checkoutSessionId: session.id ?? null,
    termsAcceptedAt: session.consent?.terms_of_service === 'accepted' ? new Date().toISOString() : null,
  });
  if (!purchase) return { handled: false, note: 'academy purchase not recorded' };
  let user = session.client_reference_id ? await deps.findUserById(session.client_reference_id) : null;
  if (!user) user = await deps.findUserByEmail(email);
  if (!user) return { handled: true, note: 'academy purchase recorded; no account yet' };
  const linked = await deps.academy.linkAfterPurchase(purchase.id, user.id);
  return { handled: true, note: `academy purchase recorded; ${linked}` };
}

/**
 * The Academy trial's £0 first invoice: month 1 of the trial's credit, keyed
 * and expiring exactly as the credit sweep's slot 0 (trialSlots), or null
 * when the invoice is not that.
 */
function academyTrialFirstMonth(sub: Stripe.Subscription | null, subId: string, reason: string | null): { sourceRef: string; expiresAt: Date } | null {
  if (!sub || sub.metadata?.source !== 'academy' || sub.status !== 'trialing' || reason !== 'subscription_create') return null;
  if (!sub.trial_start || !sub.trial_end) return null;
  const first = trialSlots(new Date(sub.trial_start * 1000), new Date(sub.trial_end * 1000))[0];
  return first ? { sourceRef: trialSlotKey(subId, first.key), expiresAt: first.to } : null;
}

/** A refund of the Academy payment cancels its trial (a full one) and is kept off Total paid; null when not the Academy's. */
async function academyRefund(charge: Stripe.Charge, deps: WebhookDeps): Promise<HandleResult | null> {
  if (!deps.academy) return null;
  const piId = id(charge?.payment_intent);
  if (!piId) return null;
  // As for a pack: "could not tell" throws so Stripe sends it again, rather than booking it as a member refund.
  const pi = deps.retrievePaymentIntentStrict ? await deps.retrievePaymentIntentStrict(piId) : await deps.retrievePaymentIntent(piId);
  if (pi?.metadata?.kind !== 'academy') return null;
  const fully = charge.refunded === true || (Number(charge.amount_refunded) || 0) >= (Number(charge.amount) || 0);
  const note = await deps.academy.cancelTrialForRefund(piId, fully);
  // Batch 32: cancelling no longer wipes plan credit, so a full refund removes the trial's own credit here
  // (only its trial:<sub>: grants; anything the member paid for is untouched). A redelivery removes nothing more.
  let removed = '';
  if (fully && deps.academy.trialFor && deps.expirePlanSource) {
    const trial = await deps.academy.trialFor(piId);
    if (trial?.userId && trial.subscriptionId) {
      const r = await deps.expirePlanSource(trial.userId, { prefix: `trial:${trial.subscriptionId}:` }, null, 'academy_refunded');
      removed = `; ${r.expiredPence}p trial credit removed`;
    }
  }
  return { handled: true, note: `academy refund (${fully ? 'full' : 'partial'}): ${note}${removed}` };
}

/**
 * Batch 32: an Academy trial that ended before any paid month forfeits its
 * trial credit (its trial:<sub>: grants only). A trial that went on to a paid
 * month keeps it: it rolls over like any plan credit. Returns a note, or ''.
 */
async function forfeitUnpaidAcademyTrial(sub: Stripe.Subscription, userId: string, deps: WebhookDeps): Promise<string> {
  // Only a trial that is over for good: a paused or unpaid one can still be paid and carry on.
  if (sub.metadata?.source !== 'academy' || !deps.expirePlanSource || (sub.status !== 'canceled' && sub.status !== 'incomplete_expired')) return '';
  const s = sub as unknown as { trial_end?: number | null; ended_at?: number | null; canceled_at?: number | null };
  const endedInTrial = trialEndedUnpaid(s, new Date(), null);
  // Only asked when it ended after the trial: the first paid invoice is at the trial end.
  const paid = endedInTrial ? null : deps.subscriptionHasPaidInvoice ? await deps.subscriptionHasPaidInvoice(userId, sub.id) : null;
  if (!trialEndedUnpaid(s, new Date(), paid)) return '';
  const r = await deps.expirePlanSource(userId, { prefix: `trial:${sub.id}:` }, null, 'academy_trial_unpaid');
  return `; unpaid academy trial: ${r.expiredPence}p trial credit removed`;
}

/**
 * Batch 32: a refund or a dispute of a plan invoice's payment removes that
 * invoice's unspent credit (its `inv:<id>` grant; for an annual plan, its
 * subscription's slot grants made in that invoice's year), in the share
 * refunded or disputed, never below zero, no other credit touched.
 * Cumulative: a refund carries the charge's total refunded, and the database
 * subtracts what was already removed for the reason under the member's lock
 * (p_total), so a later partial refund, a redelivery or two refunds racing
 * remove only what is still due. Null when the payment paid no plan invoice
 * (a top-up, a pack, the Academy) or the plan path is not wired.
 */
async function clawbackPlanInvoice(event: Stripe.Event, deps: WebhookDeps): Promise<HandleResult | null> {
  if (!deps.planInvoiceForPayment || !deps.planInvoiceCredit || !deps.expirePlanSource) return null;
  const charge = event.type === 'charge.refunded' ? (event.data.object as Stripe.Charge) : null;
  const dispute = charge ? null : (event.data.object as Stripe.Dispute);
  if (charge && charge.captured === false) return null;
  const piId = charge ? id(charge.payment_intent) : id(dispute?.payment_intent);
  if (!piId) return null;
  // A payment we made with our own metadata (a top-up, a pack, the Academy) has its own path.
  const pi = deps.retrievePaymentIntentStrict ? await deps.retrievePaymentIntentStrict(piId) : await deps.retrievePaymentIntent(piId);
  if (pi?.metadata?.kind) return null;
  const invoice = await deps.planInvoiceForPayment(piId);
  if (!invoice) return null;
  const reason: PlanClawbackReason = charge ? 'plan_refunded' : 'plan_disputed';
  const taken = charge ? Number(charge.amount_refunded) || 0 : Number(dispute?.amount) || 0;
  const charged = (charge ? Number(charge.amount) || 0 : 0) || invoice.paidPence || Number(pi?.amount_received ?? pi?.amount) || 0;
  // grantedPence never changes once granted (an annual year's only grows as its slots are granted), so reading it
  // outside the lock is safe; what was already removed is read inside it (p_total).
  const { grantedPence } = await deps.planInvoiceCredit(invoice.userId, invoice.invoiceId, reason, invoice.annual ?? null);
  const target = refundedShare(grantedPence, taken, charged);
  if (target <= 0) return { handled: true, note: `plan invoice ${invoice.invoiceId}: nothing more to remove` };
  const scope = planInvoiceScope(invoice.invoiceId, invoice.annual);
  const r = await deps.expirePlanSource(invoice.userId, scope.match, target, reason, { total: true, createdFrom: scope.createdFrom, createdTo: scope.createdTo });
  return { handled: true, note: `plan invoice ${invoice.invoiceId} ${charge ? 'refunded' : 'disputed'}: ${r.expiredPence}p of its credit removed` };
}

/** Batch 32: a won dispute on a plan invoice puts back what charge.dispute.created removed, once (its own source_ref). Null when not a plan invoice. */
async function restorePlanDispute(piId: string, pi: Stripe.PaymentIntent | null, deps: WebhookDeps): Promise<HandleResult | null> {
  if (pi?.metadata?.kind || !deps.planInvoiceForPayment || !deps.planInvoiceCredit || !deps.restorePlanCredit) return null;
  const invoice = await deps.planInvoiceForPayment(piId);
  if (!invoice) return null;
  const { removedPence } = await deps.planInvoiceCredit(invoice.userId, invoice.invoiceId, 'plan_disputed', invoice.annual ?? null);
  if (!(removedPence > 0)) return { handled: true, note: `plan invoice ${invoice.invoiceId}: nothing was removed, nothing to give back` };
  const granted = await deps.restorePlanCredit(invoice.userId, disputeWonRef(invoice.invoiceId), removedPence, 'Dispute closed in your favour — plan credit restored');
  return { handled: true, note: `plan invoice ${invoice.invoiceId}: ${granted ? `${removedPence}p restored` : 'already restored'}` };
}

export async function handleStripeEvent(event: Stripe.Event, deps: WebhookDeps): Promise<HandleResult> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((m: string) => console.log(`[stripe/webhook] ${m}`));

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      // Batch 31a: the Academy first, before any profile is looked up or written.
      if (session.metadata?.kind === 'academy') return handleAcademyCheckout(session, null, deps);
      let academyPi: Stripe.PaymentIntent | null = null;
      if (deps.academy && session.mode === 'payment' && id(session.payment_intent)) {
        academyPi = await deps.retrievePaymentIntent(id(session.payment_intent)!);
        if (academyPi?.metadata?.kind === 'academy') return handleAcademyCheckout(session, academyPi, deps);
      }
      const customerId = id(session.customer);
      const email = session.customer_details?.email ?? session.customer_email ?? null;
      let user = session.client_reference_id ? await deps.findUserById(session.client_reference_id) : null;
      if (!user && customerId) user = await deps.findUserByCustomer(customerId);
      if (!user && email) user = await deps.findUserByEmail(email);
      if (!user) return { handled: false, note: 'no user for checkout session' };

      const patch: Record<string, unknown> = {};
      if (customerId) patch.stripe_customer_id = customerId;
      if (session.consent?.terms_of_service === 'accepted') patch.terms_accepted_at = new Date().toISOString();

      if (session.mode === 'subscription') {
        const subId = id(session.subscription);
        if (subId) {
          patch.stripe_subscription_id = subId;
          patch.stripe_subscription_status = 'active';
          patch.plan = 'pro';
          patch.subscription_ended_at = null;
          if (user.plan_source !== 'manual') patch.plan_source = 'stripe';
          const sub = await deps.retrieveSubscription(subId);
          const code = planForPriceId(priceIdOf(sub), env);
          if (code) patch.plan_code = code;
          if (sub) {
            patch.stripe_subscription_status = sub.status;
            patch.stripe_price_id = priceIdOf(sub);
            patch.current_period_end = periodEndOf(sub)?.toISOString() ?? null;
            patch.cancel_at_period_end = Boolean(sub.cancel_at_period_end);
            patch.subscription_started_at = isoFromUnix(sub.start_date) ?? new Date().toISOString();
            Object.assign(patch, subscriptionColumns(sub));
          } else {
            patch.subscription_started_at = new Date().toISOString();
          }
        }
        await deps.updateProfile(user.id, patch);
        if (user.email ?? email) await deps.onSubscriptionStarted((user.email ?? email)!);
        await logEvent(deps, {
          userId: user.id,
          kind: 'started',
          cycleStartedAt: (patch.subscription_started_at as string | undefined) ?? null,
          planCode: (patch.plan_code as string | undefined) ?? null,
          stripeSubscriptionId: subId,
          stripeEventId: event.id,
          source: 'stripe',
        });
        return { handled: true, note: 'subscription checkout recorded; credit follows invoice.paid' };
      }

      // One-off top-up through Checkout: save the card, grant the credit.
      await deps.updateProfile(user.id, patch);
      const piId = id(session.payment_intent);
      if (piId) {
        const pi = academyPi ?? (await deps.retrievePaymentIntent(piId));
        const pm = id(pi?.payment_method);
        if (pm) await deps.savePaymentMethod(user.id, customerId, pm);
        const amount = Number(pi?.metadata?.amount_pence ?? session.amount_total ?? 0) || Number(session.amount_total ?? 0);
        if (pi?.metadata?.kind === 'topup' || session.metadata?.kind === 'topup') {
          // Batch 21 (B15): a delayed-notification payment method completes the
          // session before the money arrives; the credit waits for payment_intent.succeeded.
          if (session.payment_status && session.payment_status !== 'paid') return { handled: true, note: `top-up checkout ${session.payment_status}: credit follows the payment` };
          if (amount > 0) await deps.grantTopup(user.id, amount, `pi:${piId}`, user.email ?? email);
          if (amount > 0) await logTopupActivity(deps, user.id, piId, amount, false);
          if (amount > 0) await enableAutoTopupFromLink(deps, user.id, piId, pi?.metadata ?? session.metadata ?? null, amount);
          // Batch 29: a top-up is never a Purchase; a pack buyer's first payment after the pack is their
          // RepeatPurchase (payment_intent.succeeded carries the same key and id, so one is recorded).
          if (amount > 0) await recordMetaConversion(deps, { name: 'RepeatPurchase', userId: user.id, eventId: piId, repeat: { paymentId: `pi:${piId}`, topup: { kind: 'topup', auto: pi?.metadata?.auto ?? session.metadata?.auto ?? null, amountPence: amount, currency: pi?.currency ?? session.currency ?? null } } });
          // Batch 20: what was charged, for Total paid (the same row as payment_intent.succeeded's).
          await recordPaymentRow(deps, paymentFromIntent(pi ?? { id: piId, amount_received: session.amount_total ?? null, currency: session.currency ?? null, metadata: session.metadata ?? null }, user.id));
        }
        // Batch 20: the starter pack. The card was only authorised: claim it once per person, then capture it or cancel it.
        if (pi?.metadata?.kind === 'starter_pack' || session.metadata?.kind === 'starter_pack') {
          if (!deps.settleStarterPack) return { handled: false, note: 'starter pack not configured' };
          const outcome = await deps.settleStarterPack(piId);
          return { handled: true, note: `starter pack ${outcome}` };
        }
      }
      return { handled: true };
    }

    // Batch 20: a pack's card authorised (the one-click route settles it too,
    // and Checkout's completion; settling twice is safe), or its payment
    // cancelled (an authorisation never captured: the claim is let go).
    case 'payment_intent.amount_capturable_updated':
    case 'payment_intent.canceled': {
      const pi = event.data.object as Stripe.PaymentIntent;
      if (pi.metadata?.kind !== 'starter_pack') return { handled: false, note: 'not a starter pack' };
      if (!deps.settleStarterPack) return { handled: false, note: 'starter pack not configured' };
      const outcome = await deps.settleStarterPack(pi.id);
      return { handled: true, note: `starter pack ${outcome}` };
    }

    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      if (pi.metadata?.kind === 'starter_pack') return handleStarterPackPaid(pi, deps);
      if (pi.metadata?.kind !== 'topup') return { handled: false, note: 'not a top-up' };
      const userId = pi.metadata.user_id;
      const user = userId ? await deps.findUserById(userId) : id(pi.customer) ? await deps.findUserByCustomer(id(pi.customer)!) : null;
      if (!user) return { handled: false, note: 'no user for payment intent' };
      const pm = id(pi.payment_method);
      if (pm) await deps.savePaymentMethod(user.id, id(pi.customer), pm);
      const amount = Number(pi.metadata.amount_pence ?? pi.amount_received ?? pi.amount) || pi.amount_received || pi.amount;
      const granted = await deps.grantTopup(user.id, amount, `pi:${pi.id}`, user.email);
      await logTopupActivity(deps, user.id, pi.id, amount, pi.metadata?.auto === '1');
      await enableAutoTopupFromLink(deps, user.id, pi.id, pi.metadata, amount);
      // Batch 29: a pack buyer's first payment after the pack, chosen or automatic, is their RepeatPurchase
      // (never a Purchase; Checkout's event carries the same key and id).
      await recordMetaConversion(deps, { name: 'RepeatPurchase', userId: user.id, eventId: pi.id, repeat: { paymentId: `pi:${pi.id}`, topup: { kind: pi.metadata?.kind, auto: pi.metadata?.auto, amountPence: amount, currency: pi.currency } } });
      // Batch 20: what was charged, for Total paid.
      await recordPaymentRow(deps, paymentFromIntent(pi, user.id));
      return { handled: true, note: granted ? 'top-up granted' : 'already granted' };
    }

    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = invoice.parent?.subscription_details?.subscription ? id(invoice.parent.subscription_details.subscription) : null;
      if (!subId) return { handled: false, note: 'invoice without subscription' };
      let user = await deps.findUserBySubscription(subId);
      if (!user && id(invoice.customer)) user = await deps.findUserByCustomer(id(invoice.customer)!);
      // Batch 21 (B19): a subscriber with no linked customer or subscription yet (a Payment Link, invoice.paid beating checkout.session.completed) is matched by the invoice's email, as a Checkout session is.
      if (!user && invoice.customer_email) user = await deps.findUserByEmail(invoice.customer_email);
      if (!user) return { handled: false, note: 'no user for invoice' };
      const sub = await deps.retrieveSubscription(subId);
      const linePrice = invoice.lines?.data?.[0]?.pricing?.price_details?.price;
      const priceId = priceIdOf(sub) ?? (typeof linePrice === 'string' ? linePrice : (linePrice?.id ?? null));
      const planCode = planForPriceId(priceId, env);
      // Batch 20: every paid invoice is money the member paid (Total paid), whatever it is for.
      await recordPaymentRow(deps, paymentFromInvoice(invoice, user.id, planCode, await invoicePaymentIntentFor(deps, invoice)));
      if (!planCode) {
        log(`invoice ${invoice.id}: price ${priceId} is not a known plan`);
        return { handled: false, note: 'unknown price' };
      }
      // Batch 31a: an Academy trial's first invoice arriving once the trial is no longer running (refunded,
      // unlinked or cancelled meanwhile) grants nothing and leaves the profile alone. Without this it
      // fell through to the generic inv:<id> grant: 90 days of Pro for a trial that has ended.
      const academyMeta = sub?.metadata ?? invoice.parent?.subscription_details?.metadata ?? null;
      if (academyMeta?.source === 'academy' && invoice.billing_reason === 'subscription_create' && sub?.status !== 'trialing') {
        log(`invoice ${invoice.id}: academy trial ${subId} is ${sub?.status ?? 'unknown'}; nothing granted`);
        return { handled: true, note: `academy trial ${sub?.status ?? 'unknown'}: nothing granted` };
      }
      const lineEnd = invoice.lines?.data?.[0]?.period?.end;
      const periodEnd = periodEndOf(sub) ?? (lineEnd ? new Date(lineEnd * 1000) : null);
      const patch: Record<string, unknown> = {
        stripe_subscription_id: subId,
        stripe_subscription_status: sub?.status ?? 'active',
        stripe_price_id: priceId,
        plan_code: planCode,
        current_period_end: periodEnd?.toISOString() ?? null,
        cancel_at_period_end: Boolean(sub?.cancel_at_period_end),
        plan: 'pro',
        subscription_ended_at: null,
      };
      if (user.plan_source !== 'manual') patch.plan_source = 'stripe';
      if (id(invoice.customer)) patch.stripe_customer_id = id(invoice.customer);
      if (sub) {
        patch.subscription_started_at = isoFromUnix(sub.start_date);
        Object.assign(patch, subscriptionColumns(sub));
      }
      await deps.updateProfile(user.id, patch);
      if (user.stripe_subscription_status === 'past_due') {
        // The card went through after all, so the subscription leaves the
        // at-risk band. Without this it would sit there for ever.
        await logEvent(deps, {
          userId: user.id,
          kind: 'recovered',
          cycleStartedAt: (patch.subscription_started_at as string | undefined) ?? null,
          planCode,
          stripeSubscriptionId: subId,
          stripeEventId: event.id,
          source: 'stripe',
        });
      }

      const reason = invoice.billing_reason;
      // A £0 invoice (a 100%-off code, a trial's first invoice) grants the full
      // cycle: a promotion is a promotion (Batch 21 review, question 5).
      if (reason === 'subscription_create' || reason === 'subscription_cycle' || reason === 'manual' || reason === null) {
        // Batch 31a: the Academy trial's £0 first invoice is month 1 of three, not the whole 90 days.
        const academyMonth = academyTrialFirstMonth(sub, subId, reason);
        if (academyMonth) {
          await deps.grantPlanCycle(user.id, 'pro', academyMonth.sourceRef, academyMonth.expiresAt, user.email);
        } else if (planCode === 'pro_annual') {
          // Annual: the first month now; the sweep cron grants the rest month by month.
          const start = new Date();
          // Batch 21 (B8): a month added with the day clamped, as the sweep's slots are (src/lib/stripe/annual.ts).
          const slotEnd = addMonthsClamped(start, 1);
          await deps.grantPlanCycle(user.id, planCode, `annual:${subId}:${start.toISOString().slice(0, 7)}`, periodEnd && slotEnd > periodEnd ? periodEnd : slotEnd, user.email);
        } else {
          await deps.grantPlanCycle(user.id, planCode, `inv:${invoice.id}`, periodEnd, user.email);
        }
        // Meta's Subscribe: the member's first paid invoice of a subscription started after tracking began.
        const invoiceFacts = {
          amountPaid: invoice.amount_paid,
          totalExcludingTax: invoice.total_excluding_tax,
          billingReason: reason,
          currency: invoice.currency,
          subscriptionStartedAt: sub ? isoFromUnix(sub.start_date) : reason === 'subscription_create' ? isoFromUnix(invoice.created) : null,
        };
        await recordMetaConversion(deps, { name: 'Subscribe', userId: user.id, eventId: invoice.id ?? null, invoice: invoiceFacts });
        // Batch 29 (question 10): a pack buyer whose first payment after the pack is this plan invoice sends RepeatPurchase too.
        if (invoice.id) await recordMetaConversion(deps, { name: 'RepeatPurchase', userId: user.id, eventId: invoice.id, repeat: { paymentId: `inv:${invoice.id}`, invoice: invoiceFacts } });
        return { handled: true, note: `plan cycle granted (${reason ?? 'unspecified'})` };
      }
      if (reason === 'subscription_update') {
        await deps.grantUpgradeDifference(user.id, user.plan_code, planCode, `inv:${invoice.id}`, periodEnd);
        return { handled: true, note: 'upgrade difference granted' };
      }
      return { handled: false, note: `billing_reason ${reason} ignored` };
    }

    // `created` matters for subscriptions set up by hand in the Stripe
    // dashboard: there is no Checkout Session for those, so this is the only
    // event that can link them to a profile (credit still follows invoice.paid).
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = id(sub.customer);
      let user = await deps.findUserBySubscription(sub.id);
      if (!user && customerId) user = await deps.findUserByCustomer(customerId);
      if (!user) return { handled: false, note: 'no user for subscription' };
      // Batch 21 (B42): a subscription made by hand that has not had its first
      // payment is not over; treating 'incomplete' as ended expired credit and
      // wrote an 'ended' churn row for a plan that never started.
      if (event.type !== 'customer.subscription.deleted' && sub.status === 'incomplete') return { handled: true, note: 'subscription incomplete: awaiting its first payment' };
      const ended = event.type === 'customer.subscription.deleted' || !LIVE_STATUSES.has(sub.status);

      // Don't let a dead subscription end the plan when the customer still has
      // a live one. Switching plan (monthly → annual) cancels the old
      // subscription and creates a new one, and Stripe does not guarantee
      // event order — a late `sub_old.deleted` would otherwise expire the
      // credit a customer is paying for on sub_new (whose own events carry
      // the right state).
      if (ended && customerId && deps.listSubscriptions) {
        const live = (await deps.listSubscriptions(customerId)).find((s) => s.id !== sub.id && LIVE_STATUSES.has(s.status));
        if (live) return { handled: false, note: `ignoring ${sub.id} (${sub.status}); customer still has live subscription ${live.id}` };
      }

      const priceId = priceIdOf(sub);
      const planCode = planForPriceId(priceId, env);
      const manual = user.plan_source === 'manual';
      const patch: Record<string, unknown> = {
        stripe_subscription_id: sub.id,
        stripe_subscription_status: sub.status,
        cancel_at_period_end: Boolean(sub.cancel_at_period_end),
        current_period_end: periodEndOf(sub)?.toISOString() ?? null,
        ...subscriptionColumns(sub, ended),
      };
      if (customerId) patch.stripe_customer_id = customerId;
      const cycleStartedAt = isoFromUnix(sub.start_date);
      const logBase = {
        userId: user.id,
        cycleStartedAt,
        planCode: planCode ?? user.plan_code ?? null,
        stripeSubscriptionId: sub.id,
        stripeEventId: event.id,
      } as const;

      if (ended) {
        // A plan granted by hand is a deliberate decision that outranks Stripe;
        // record what Stripe said but keep the override.
        if (!manual) Object.assign(patch, { plan: 'free', plan_code: null, stripe_price_id: null, plan_source: 'stripe' });
        patch.subscription_ended_at = new Date().toISOString();
        await deps.updateProfile(user.id, patch);
        // Batch 32 (plan credit rollover): ending a subscription no longer wipes its plan credit; it stays
        // on the account. Only an Academy trial that never reached a paid month forfeits its trial credit.
        const forfeited = await forfeitUnpaidAcademyTrial(sub, user.id, deps);
        if (user.email) await deps.onSubscriptionCancelled(user.email);

        // Why they left, best source first: what they told us when they
        // scheduled the cancellation, then whatever Stripe captured (a portal
        // cancel only ever has this), and failing both — if the subscription
        // was already past due — the card, because an involuntary churn is
        // still a churn and needs to show up in the breakdown as one.
        const fromStripe = cancellationFromStripe(sub);
        const involuntary = user.stripe_subscription_status === 'past_due' || sub.status === 'unpaid' || sub.status === 'past_due';
        const reason = user.cancel_reason ?? fromStripe.reason ?? (involuntary ? 'payment_failed' : null);
        const source = user.cancel_reason ? 'self_serve' : fromStripe.reason ? 'portal' : 'stripe';
        await logEvent(deps, {
          ...logBase,
          kind: 'ended',
          reason,
          reasonComment: user.cancel_reason_comment ?? fromStripe.comment ?? null,
          source,
        });
        return { handled: true, note: `subscription ended; plan credit kept${forfeited}` };
      }

      patch.subscription_ended_at = null;
      patch.subscription_started_at = cycleStartedAt;
      if (!manual) patch.plan_source = 'stripe';
      if (planCode) Object.assign(patch, { plan_code: planCode, stripe_price_id: priceId, plan: 'pro' });
      await deps.updateProfile(user.id, patch);

      // Everything below is a state CHANGE, compared against the row we just
      // read. Logging on the change rather than on the event keeps a
      // re-reported state (Stripe sends the whole object every time) from
      // filling the log with duplicates the unique index cannot catch, because
      // each delivery carries its own event id.
      const state = subscriptionStateFromStripe(sub);
      if (event.type === 'customer.subscription.created') {
        await logEvent(deps, { ...logBase, kind: 'started', source: manual ? 'manual' : 'stripe' });
      }
      const wasPaused = Boolean(user.subscription_paused_until);
      const isPausedNow = Boolean(state.pausedUntil);
      if (isPausedNow && !wasPaused) await logEvent(deps, { ...logBase, kind: 'paused' });
      if (!isPausedNow && wasPaused) await logEvent(deps, { ...logBase, kind: 'resumed' });

      const wasCancelling = Boolean(user.subscription_cancel_at);
      const isCancellingNow = Boolean(state.cancelAt);
      if (isCancellingNow && !wasCancelling) {
        const fromStripe = cancellationFromStripe(sub);
        await logEvent(deps, {
          ...logBase,
          kind: 'cancel_scheduled',
          reason: user.cancel_reason ?? fromStripe.reason ?? null,
          reasonComment: user.cancel_reason_comment ?? fromStripe.comment ?? null,
          source: user.cancel_reason ? 'self_serve' : fromStripe.reason ? 'portal' : 'stripe',
        });
      }
      if (!isCancellingNow && wasCancelling) await logEvent(deps, { ...logBase, kind: 'cancel_reverted' });

      if (planCode && user.plan_code && planCode !== user.plan_code) {
        await logEvent(deps, { ...logBase, kind: 'plan_changed' });
      }
      if (user.stripe_subscription_status === 'past_due' && sub.status === 'active') {
        await logEvent(deps, { ...logBase, kind: 'recovered' });
      }

      return { handled: true, note: sub.pause_collection ? 'subscription state mirrored (paused)' : 'subscription state mirrored' };
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = invoice.parent?.subscription_details?.subscription ? id(invoice.parent.subscription_details.subscription) : null;
      // Batch 21 (B43): a one-off invoice that fails is not a subscription past due.
      if (!subId) return { handled: false, note: 'invoice without subscription' };
      let user = await deps.findUserBySubscription(subId);
      if (!user && id(invoice.customer)) user = await deps.findUserByCustomer(id(invoice.customer)!);
      if (!user) return { handled: false, note: 'no user for failed invoice' };
      await deps.updateProfile(user.id, { stripe_subscription_status: 'past_due' });
      if (user.email) await deps.paymentFailedEmail(user.email, user.plan_code);
      // Only on the way IN to past_due: a second failed invoice on an already
      // past-due subscription is the same episode, not a new one.
      if (user.stripe_subscription_status !== 'past_due') {
        await logEvent(deps, {
          userId: user.id,
          kind: 'past_due',
          planCode: user.plan_code ?? null,
          stripeSubscriptionId: subId,
          stripeEventId: event.id,
          source: 'stripe',
        });
      }
      return { handled: true, note: 'marked past_due' };
    }

    case 'payment_method.attached': {
      const pm = event.data.object as Stripe.PaymentMethod;
      const customerId = id(pm.customer);
      if (!customerId) return { handled: false };
      const user = await deps.findUserByCustomer(customerId);
      if (!user) return { handled: false, note: 'no user for customer' };
      await deps.savePaymentMethod(user.id, customerId, pm.id);
      return { handled: true };
    }

    case 'charge.refunded':
    case 'charge.dispute.created': {
      // Batch 31a: an Academy refund cancels its trial and is not the member's money in Total paid.
      if (event.type === 'charge.refunded') {
        const academy = await academyRefund(event.data.object as Stripe.Charge, deps);
        if (academy) return academy;
      }
      // Batch 20: every refund comes off Total paid, whatever the charge was for.
      if (event.type === 'charge.refunded') await recordChargeRefund(deps, event.data.object as Stripe.Charge);
      else await recordDisputeMark(deps, event.data.object as Stripe.Dispute, true);
      // Batch 20: a starter pack's credit comes back in the same share as its payment.
      const packClawback = await clawbackPackIfPack(event, deps);
      if (packClawback) return packClawback;
      // Batch 32: a plan invoice's payment refunded or disputed removes that invoice's unspent credit.
      const planClawback = await clawbackPlanInvoice(event, deps);
      if (planClawback) return planClawback;
      if (!deps.refundTopup) return { handled: false, note: 'no clawback configured' };
      const obj = event.data.object as Stripe.Charge | Stripe.Dispute;
      const charge = event.type === 'charge.refunded' ? (obj as Stripe.Charge) : null;
      const piId = charge ? id(charge.payment_intent) : id((obj as Stripe.Dispute).payment_intent);
      if (!piId) return { handled: false, note: 'no payment intent' };
      const pi = await deps.retrievePaymentIntent(piId);
      if (pi?.metadata?.kind !== 'topup' || !pi.metadata.user_id) return { handled: false, note: 'not a top-up' };
      const taken = charge ? charge.amount_refunded : (obj as Stripe.Dispute).amount;
      // Batch 21 (B18): with Stripe Tax the charge is VAT-inclusive while the
      // credit (metadata.amount_pence) is not: the same SHARE of the credit
      // comes back, never more credit than was granted.
      const creditPence = Number(pi.metadata.amount_pence) || 0;
      const chargedPence = Number(pi.amount) || 0;
      const amount = creditPence > 0 && chargedPence > 0 ? Math.round((creditPence * Math.min(taken, chargedPence)) / chargedPence) : taken;
      await deps.refundTopup(pi.metadata.user_id, `pi:${piId}`, amount, event.type === 'charge.refunded' ? 'refunded' : 'disputed');
      return { handled: true, note: 'top-up clawed back' };
    }

    // Batch 21 (B17): the dispute's outcome. Won, or an inquiry closed with
    // nothing taken, gives back what charge.dispute.created took; lost leaves
    // the clawback where it is.
    case 'charge.dispute.closed': {
      const dispute = event.data.object as Stripe.Dispute;
      if (dispute.status !== 'won' && dispute.status !== 'warning_closed') return { handled: false, note: `dispute ${dispute.status}: nothing to give back` };
      await recordDisputeMark(deps, dispute, false);
      const piId = id(dispute.payment_intent);
      if (!piId) return { handled: false, note: 'no payment intent' };
      const pi = deps.retrievePaymentIntentStrict ? await deps.retrievePaymentIntentStrict(piId) : await deps.retrievePaymentIntent(piId);
      // Batch 32: a plan invoice's dispute won puts back the credit its opening removed.
      const planRestore = await restorePlanDispute(piId, pi, deps);
      if (planRestore) return planRestore;
      if (!deps.restoreDisputedCredit) return { handled: false, note: 'no restore configured' };
      const kind = pi?.metadata?.kind;
      const userId = pi?.metadata?.user_id;
      if (!userId || (kind !== 'topup' && kind !== 'starter_pack')) return { handled: false, note: 'not a top-up or starter pack' };
      const restored = await deps.restoreDisputedCredit(userId, piId);
      return { handled: true, note: `dispute ${dispute.status}: ${restored}p restored` };
    }

    default:
      return { handled: false, note: `ignored ${event.type}` };
  }
}

/** Human label for the plan price a subscription is on (used in emails). */
export function planCodeForSubscription(sub: Stripe.Subscription | null, env: Env = process.env): string | null {
  return planForPriceId(priceIdOf(sub), env);
}

export { topupPenceForPriceId };
