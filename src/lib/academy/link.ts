/**
 * Linking a Stayful Academy purchase to an account and starting its free Pro
 * months (Batch 31a, Phase 2). Pure-ish: everything that touches the
 * database, Stripe or email goes through `deps` (live wiring in deps.ts), so
 * the flows are unit tested with fakes (link.test.ts), like the Stripe
 * webhook.
 *
 *   linkAcademyPurchase   decide (rules.ts linkDecision) and, unless dry,
 *                         start the trial subscription on the purchase's
 *                         customer (the saved card lives there)
 *   linkPendingForUser    link every unlinked purchase made with the
 *                         account's email ('auto')
 *   unlinkAcademyPurchase admin: cancel a trial nothing has been paid on and
 *                         free the purchase for another account
 *   cancelTrialForRefund  a refund of the purchase: a full one while trialing
 *                         ends the trial now and sends the refund email
 *
 * A dry run reads (database and Stripe) but writes nothing and changes
 * nothing in Stripe; its result says exactly what a real run would do. Logs
 * carry ids only, never an email.
 */
import type Stripe from 'stripe';
import { ACADEMY_FACTS, academyTrialEnd, emailKey, linkDecision, type CustomerAction, type LinkBy } from './rules.ts';

/** The academy_purchases columns these flows read. */
export interface AcademyPurchaseRow {
  id: string;
  email: string;
  stripe_customer_id: string | null;
  stripe_payment_intent_id: string;
  stripe_payment_method_id: string | null;
  user_id: string | null;
  linked_at: string | null;
  linked_by: string | null;
  trial_subscription_id: string | null;
  refunded_at: string | null;
  terms_accepted_at: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  previous_customer_id: string | null;
  flag_reason: string | null;
  reminder_sent_at: string | null;
  trial_cancelled_at: string | null;
}

export interface AcademyProfileRow {
  id: string;
  email: string | null;
  plan_code: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_status: string | null;
  stripe_default_payment_method_id: string | null;
}

/** The parts of a Stripe subscription these flows read (a Stripe.Subscription fits). */
export interface AcademySubscription {
  id: string;
  status: string;
  metadata?: Record<string, string> | null;
  trial_start?: number | null;
  trial_end?: number | null;
}

type PurchaseColumn = keyof AcademyPurchaseRow;

export interface AcademyLinkDeps {
  now?(): Date;
  /** STRIPE_TAX === 'true': the trial subscription collects tax like a normal plan. */
  automaticTax?: boolean;
  /** The Stripe price of the Pro plan (STRIPE_PRICE_PRO), or null when unset. */
  proPriceId(): string | null;

  loadPurchase(purchaseId: string): Promise<AcademyPurchaseRow | null>;
  loadPurchaseByPaymentIntent(paymentIntentId: string): Promise<AcademyPurchaseRow | null>;
  /** Unlinked (no account, no trial), unrefunded purchases made with this email (already emailKey'd). */
  listUnlinkedPurchases(email: string): Promise<AcademyPurchaseRow[]>;
  /** Another purchase by this email (emailKey'd) already got a trial. */
  emailHadEarlierTrial(email: string, exceptPurchaseId: string): Promise<boolean>;
  /**
   * Writes `patch` to the purchase only where every `where` column matches
   * (null: is null). True when a row was written. Throws on a failed write.
   */
  updatePurchase(purchaseId: string, patch: Partial<Record<PurchaseColumn, string | null>>, where?: Partial<Record<PurchaseColumn, string | null>>): Promise<boolean>;

  loadProfile(userId: string): Promise<AcademyProfileRow | null>;
  updateProfile(userId: string, patch: Record<string, unknown>): Promise<void>;
  /** The account's sign-in email is confirmed (auth). */
  emailConfirmed(userId: string): Promise<boolean>;
  /** Billing belongs to a team owner (the account is a team member). */
  isTeamMember(userId: string): Promise<boolean>;

  /** Every subscription on the customer. Throws when Stripe cannot be asked; [] for a customer that no longer exists. */
  listSubscriptions(customerId: string): Promise<AcademySubscription[]>;
  retrieveSubscription(subscriptionId: string): Promise<AcademySubscription | null>;
  createSubscription(params: Stripe.SubscriptionCreateParams, idempotencyKey: string): Promise<AcademySubscription>;
  cancelSubscription(subscriptionId: string): Promise<AcademySubscription>;
  /** An invoice on the subscription has been paid with money (amount_paid > 0). */
  hasPaidInvoice(subscriptionId: string): Promise<boolean>;
  cardLast4(paymentMethodId: string): Promise<string | null>;
  savePaymentMethod(userId: string, customerId: string | null, paymentMethodId: string): Promise<void>;

  logTrialStarted(userId: string, subscriptionId: string): Promise<void>;
  /** The refund email to the member (never throws; true when sent). */
  sendRefundEmail(to: string, purchaseId: string): Promise<boolean>;
}

/** A subscription in any of these is a plan the member has (copied from /api/billing/subscribe). */
export const HOLDS_A_PLAN: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']);

const DEAD = new Set(['canceled', 'incomplete_expired']);

export interface LinkResult {
  /** start: the trial starts (dry: would start); already: it had started; refused: no trial; error: could not tell. */
  outcome: 'start' | 'already' | 'refused' | 'error';
  dry: boolean;
  /** Something was written or changed in Stripe. */
  done: boolean;
  purchaseId: string;
  userId: string;
  by: LinkBy;
  /** linkDecision's answer, or not_found / no_profile / error. */
  decision: string;
  /** Why not (the flag_reason written on a real refusal), or the error. */
  reason: string | null;
  customerAction: CustomerAction | null;
  /** The customer the trial runs on (the purchase's). */
  customerId: string | null;
  /** The profile's customer before linking. */
  profileCustomerBefore: string | null;
  /** The profile moves onto the purchase's customer (it had none, or another one with no live plan). */
  profileCustomerChanges: boolean;
  /** The profile's old customer, kept on the purchase, when it switches. */
  previousCustomerId: string | null;
  cardLast4: string | null;
  trialStart: string | null;
  trialEnd: string | null;
  subscriptionId: string | null;
  /** An existing trial subscription for this purchase was found in Stripe and reused (none created). */
  reusedSubscription: boolean;
  /** For 'already': the account the purchase is linked to. */
  linkedUserId: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const fromUnix = (s: number | null | undefined) => (typeof s === 'number' ? new Date(s * 1000) : null);

function nowOf(deps: AcademyLinkDeps): Date {
  return deps.now ? deps.now() : new Date();
}

/** The parameters of the trial subscription (Pro, trialDays, cancelled if the card is missing at the end). */
export function trialSubscriptionParams(input: {
  customerId: string;
  priceId: string;
  paymentMethodId: string;
  userId: string;
  purchaseId: string;
  automaticTax: boolean;
}): Stripe.SubscriptionCreateParams {
  return {
    customer: input.customerId,
    items: [{ price: input.priceId }],
    trial_period_days: ACADEMY_FACTS.trialDays,
    default_payment_method: input.paymentMethodId,
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    metadata: { user_id: input.userId, plan_code: 'pro', source: 'academy', academy_purchase_id: input.purchaseId },
    ...(input.automaticTax ? { automatic_tax: { enabled: true } } : {}),
  };
}

/** The Stripe idempotency key of a purchase's trial subscription. */
export function trialIdempotencyKey(purchaseId: string): string {
  return `academy-trial:${purchaseId}`;
}

/** The flag_reason written for a refusal: the decision without its `refuse_` prefix. */
export function flagReasonFor(decision: string): string {
  return decision.replace(/^refuse_/, '');
}

/**
 * Link a purchase to an account and start its trial. With `dry`, says what
 * would happen and touches nothing. A real refusal writes flag_reason on the
 * purchase (admin shows it) and creates nothing.
 */
export async function linkAcademyPurchase(
  deps: AcademyLinkDeps,
  purchaseId: string,
  userId: string,
  by: LinkBy,
  opts: { dry?: boolean } = {},
): Promise<LinkResult> {
  const dry = Boolean(opts.dry);
  const result: LinkResult = {
    outcome: 'error',
    dry,
    done: false,
    purchaseId,
    userId,
    by,
    decision: 'error',
    reason: null,
    customerAction: null,
    customerId: null,
    profileCustomerBefore: null,
    profileCustomerChanges: false,
    previousCustomerId: null,
    cardLast4: null,
    trialStart: null,
    trialEnd: null,
    subscriptionId: null,
    reusedSubscription: false,
    linkedUserId: null,
  };
  const purchase = await deps.loadPurchase(purchaseId);
  if (!purchase) return { ...result, decision: 'not_found', reason: 'not_found' };
  const profile = await deps.loadProfile(userId);
  if (!profile) return { ...result, decision: 'no_profile', reason: 'no_profile' };
  result.profileCustomerBefore = profile.stripe_customer_id;

  const already = () => ({ ...result, outcome: 'already' as const, decision: 'already', subscriptionId: purchase.trial_subscription_id, linkedUserId: purchase.user_id, trialStart: purchase.trial_started_at, trialEnd: purchase.trial_ends_at });
  if (purchase.trial_subscription_id) return already();

  const [emailConfirmed, isTeamMember, emailHadEarlierTrial] = await Promise.all([
    deps.emailConfirmed(userId),
    deps.isTeamMember(userId),
    deps.emailHadEarlierTrial(emailKey(purchase.email), purchase.id),
  ]);
  const input = {
    purchase: {
      email: purchase.email,
      stripeCustomerId: purchase.stripe_customer_id,
      stripePaymentMethodId: purchase.stripe_payment_method_id,
      trialSubscriptionId: purchase.trial_subscription_id,
      userId: purchase.user_id,
      refundedAt: purchase.refunded_at,
      termsAcceptedAt: purchase.terms_accepted_at,
    },
    profile: { id: profile.id, email: profile.email, emailConfirmed, stripeCustomerId: profile.stripe_customer_id, isTeamMember },
    profileCustomerHasLivePlan: false,
    purchaseCustomerHasLivePlan: false,
    emailHadEarlierTrial,
    by,
  };

  const refuse = async (decision: string): Promise<LinkResult> => {
    const reason = flagReasonFor(decision);
    let done = false;
    if (!dry && purchase.flag_reason !== reason) {
      done = await deps.updatePurchase(purchase.id, { flag_reason: reason }, { trial_subscription_id: null });
    }
    return { ...result, outcome: 'refused', decision, reason, done };
  };

  // Everything but the live-plan checks first: those come last in linkDecision's order, so Stripe is
  // only asked when nothing else refuses.
  const first = linkDecision(input);
  if (first.decision === 'already') return already();
  if (first.decision !== 'start') return refuse(first.decision);

  const purchaseCustomer = purchase.stripe_customer_id!;
  const paymentMethod = purchase.stripe_payment_method_id!;
  let existing: AcademySubscription | null = null;
  try {
    const purchaseSubs = await deps.listSubscriptions(purchaseCustomer);
    // A trial this purchase already started (an earlier run that stopped before writing it down) is
    // reused, not counted as a live plan.
    existing = purchaseSubs.find((s) => s.metadata?.academy_purchase_id === purchase.id && !DEAD.has(s.status)) ?? null;
    input.purchaseCustomerHasLivePlan = purchaseSubs.some((s) => s !== existing && HOLDS_A_PLAN.has(s.status));
    if (profile.stripe_customer_id && profile.stripe_customer_id !== purchaseCustomer) {
      const profileSubs = await deps.listSubscriptions(profile.stripe_customer_id);
      input.profileCustomerHasLivePlan = profileSubs.some((s) => HOLDS_A_PLAN.has(s.status));
    } else {
      input.profileCustomerHasLivePlan = input.purchaseCustomerHasLivePlan;
    }
  } catch (err) {
    console.warn(`[academy] could not ask Stripe about purchase ${purchase.id}:`, (err as Error).message);
    return { ...result, decision: 'error', reason: 'stripe_unavailable' };
  }

  const decision = linkDecision(input);
  if (decision.decision === 'already') return already();
  if (decision.decision !== 'start') return refuse(decision.decision);

  const priceId = deps.proPriceId();
  if (!priceId) return { ...result, decision: 'error', reason: 'pro_price_missing' };

  const now = nowOf(deps);
  const plan: LinkResult = {
    ...result,
    outcome: 'start',
    decision: 'start',
    customerAction: decision.customer,
    customerId: decision.customerId,
    profileCustomerChanges: decision.customer !== 'same_customer',
    previousCustomerId: decision.previousCustomerId,
    cardLast4: await deps.cardLast4(paymentMethod).catch(() => null),
    trialStart: iso(fromUnix(existing?.trial_start) ?? now),
    trialEnd: iso(fromUnix(existing?.trial_end) ?? academyTrialEnd(now)),
    subscriptionId: existing?.id ?? null,
    reusedSubscription: Boolean(existing),
  };
  if (dry) return plan;

  // The customer first, so the subscription's own webhook finds the account by its customer.
  if (decision.customer === 'switch_to_purchase_customer') {
    await deps.updatePurchase(purchase.id, { previous_customer_id: decision.previousCustomerId }, { trial_subscription_id: null });
  }
  if (decision.customer !== 'same_customer') await deps.updateProfile(userId, { stripe_customer_id: purchaseCustomer });
  await deps.savePaymentMethod(userId, purchaseCustomer, paymentMethod);

  const sub =
    existing ??
    (await deps.createSubscription(
      trialSubscriptionParams({ customerId: purchaseCustomer, priceId, paymentMethodId: paymentMethod, userId, purchaseId: purchase.id, automaticTax: Boolean(deps.automaticTax) }),
      trialIdempotencyKey(purchase.id),
    ));
  const trialStart = fromUnix(sub.trial_start) ?? now;
  const trialEnd = fromUnix(sub.trial_end) ?? academyTrialEnd(trialStart);

  const won = await deps.updatePurchase(
    purchase.id,
    {
      trial_subscription_id: sub.id,
      trial_started_at: trialStart.toISOString(),
      trial_ends_at: trialEnd.toISOString(),
      user_id: userId,
      linked_at: now.toISOString(),
      linked_by: by,
      flag_reason: null,
    },
    { trial_subscription_id: null },
  );
  if (!won) {
    // Another run linked it first. Nothing more is created; a subscription of ours that is not the
    // one it recorded would charge on day 91 with no purchase behind it, so it is cancelled.
    const now2 = await deps.loadPurchase(purchase.id);
    if (now2?.trial_subscription_id && now2.trial_subscription_id !== sub.id && !existing) {
      console.warn(`[academy] purchase ${purchase.id} was linked to ${now2.trial_subscription_id} meanwhile; cancelling duplicate ${sub.id}`);
      await deps.cancelSubscription(sub.id).catch((err) => console.error(`[academy] could not cancel duplicate ${sub.id}:`, (err as Error).message));
    }
    return { ...result, outcome: 'already', decision: 'already', done: true, subscriptionId: now2?.trial_subscription_id ?? sub.id, linkedUserId: now2?.user_id ?? null };
  }

  // As /api/billing/subscribe does: the id and status now, so a second run (or a tap on Upgrade) before
  // the webhook lands sees a live plan.
  await deps.updateProfile(userId, { stripe_subscription_id: sub.id, stripe_subscription_status: sub.status });
  await deps.logTrialStarted(userId, sub.id);
  return { ...plan, done: true, subscriptionId: sub.id, trialStart: trialStart.toISOString(), trialEnd: trialEnd.toISOString() };
}

/** Link every unlinked purchase made with the account's email ('auto'). For sign-in and the daily cron. */
export async function linkPendingForUser(deps: AcademyLinkDeps, userId: string): Promise<LinkResult[]> {
  const profile = await deps.loadProfile(userId);
  if (!profile?.email) return [];
  const purchases = await deps.listUnlinkedPurchases(emailKey(profile.email));
  const out: LinkResult[] = [];
  for (const p of purchases) out.push(await linkAcademyPurchase(deps, p.id, userId, 'auto'));
  return out;
}

export interface UnlinkResult {
  outcome: 'unlink' | 'refused' | 'error';
  dry: boolean;
  done: boolean;
  purchaseId: string;
  /** not_found, not_linked, paid_invoice, or null when allowed. */
  reason: string | null;
  userId: string | null;
  subscriptionId: string | null;
  /** The subscription's status in Stripe, and whether it is cancelled now. */
  subscriptionStatus: string | null;
  cancelsSubscription: boolean;
  /** The account's profile goes back to its old customer (null: none) and its saved card is cleared. */
  restoresProfileCustomer: boolean;
  restoredCustomerId: string | null;
}

/**
 * Admin Unlink: only while nothing has been paid on the trial. Cancels the
 * trial now and frees the purchase to be linked again (a fresh 90 days). The
 * account it was linked to goes back to its own customer (or none), so the
 * buyer's card no longer sits on it.
 */
export async function unlinkAcademyPurchase(deps: AcademyLinkDeps, purchaseId: string, opts: { dry?: boolean } = {}): Promise<UnlinkResult> {
  const dry = Boolean(opts.dry);
  const base: UnlinkResult = {
    outcome: 'refused',
    dry,
    done: false,
    purchaseId,
    reason: null,
    userId: null,
    subscriptionId: null,
    subscriptionStatus: null,
    cancelsSubscription: false,
    restoresProfileCustomer: false,
    restoredCustomerId: null,
  };
  const purchase = await deps.loadPurchase(purchaseId);
  if (!purchase) return { ...base, reason: 'not_found' };
  const subId = purchase.trial_subscription_id;
  if (!subId) return { ...base, reason: 'not_linked', userId: purchase.user_id };
  base.userId = purchase.user_id;
  base.subscriptionId = subId;
  let sub: AcademySubscription | null;
  try {
    if (await deps.hasPaidInvoice(subId)) return { ...base, reason: 'paid_invoice' };
    sub = await deps.retrieveSubscription(subId);
  } catch (err) {
    console.warn(`[academy] could not ask Stripe about subscription ${subId}:`, (err as Error).message);
    return { ...base, outcome: 'error', reason: 'stripe_unavailable' };
  }
  const profile = purchase.user_id ? await deps.loadProfile(purchase.user_id) : null;
  const restores = Boolean(profile && profile.stripe_customer_id === purchase.stripe_customer_id);
  const plan: UnlinkResult = {
    ...base,
    outcome: 'unlink',
    subscriptionStatus: sub?.status ?? null,
    cancelsSubscription: Boolean(sub && !DEAD.has(sub.status)),
    restoresProfileCustomer: restores,
    restoredCustomerId: restores ? purchase.previous_customer_id : null,
  };
  if (dry) return plan;

  if (plan.cancelsSubscription) await deps.cancelSubscription(subId);
  const now = nowOf(deps).toISOString();
  const won = await deps.updatePurchase(
    purchase.id,
    {
      user_id: null,
      linked_at: null,
      linked_by: null,
      trial_subscription_id: null,
      trial_started_at: null,
      trial_ends_at: null,
      reminder_sent_at: null,
      previous_customer_id: null,
      trial_cancelled_at: now,
    },
    { trial_subscription_id: subId },
  );
  if (won && profile && restores) {
    const patch: Record<string, unknown> = { stripe_customer_id: purchase.previous_customer_id };
    if (profile.stripe_default_payment_method_id && profile.stripe_default_payment_method_id === purchase.stripe_payment_method_id) patch.stripe_default_payment_method_id = null;
    await deps.updateProfile(profile.id, patch);
  }
  return { ...plan, done: true };
}

export interface RefundResult {
  /**
   * not_found            no academy purchase for this payment
   * partial              a partial refund: recorded only, nothing changes
   * already              handled before: nothing changes, no second email
   * refunded             marked refunded; there was no trial still running to end
   * trial_cancelled      marked refunded, the trial ended now, the refund email sent (emailSent)
   */
  outcome: 'not_found' | 'partial' | 'already' | 'refunded' | 'trial_cancelled';
  purchaseId: string | null;
  subscriptionId: string | null;
  emailSent: boolean;
}

/**
 * A refund of the Academy payment. Full: refunded_at is set (the purchase can
 * never be linked again) and a trial still `trialing` is cancelled now, with
 * the refund email. Partial: recorded only. Idempotent: a second call finds
 * refunded_at / trial_cancelled_at set and changes nothing.
 */
export async function cancelTrialForRefund(deps: AcademyLinkDeps, paymentIntentId: string, fullyRefunded: boolean): Promise<RefundResult> {
  const purchase = await deps.loadPurchaseByPaymentIntent(paymentIntentId);
  if (!purchase) return { outcome: 'not_found', purchaseId: null, subscriptionId: null, emailSent: false };
  const base = { purchaseId: purchase.id, subscriptionId: purchase.trial_subscription_id, emailSent: false };
  if (!fullyRefunded) return { ...base, outcome: 'partial' };

  const now = nowOf(deps).toISOString();
  const markedNow = purchase.refunded_at ? false : await deps.updatePurchase(purchase.id, { refunded_at: now }, { refunded_at: null });
  const subId = purchase.trial_subscription_id;
  if (!subId || purchase.trial_cancelled_at) return { ...base, outcome: markedNow ? 'refunded' : 'already' };

  const sub = await deps.retrieveSubscription(subId);
  if (!sub || sub.status !== 'trialing') return { ...base, outcome: markedNow ? 'refunded' : 'already' };
  try {
    await deps.cancelSubscription(subId);
  } catch (err) {
    // Cancelled meanwhile (a concurrent delivery) is fine; anything else is retried by the caller.
    const again = await deps.retrieveSubscription(subId);
    if (!again || again.status !== 'canceled') throw err;
  }
  const won = await deps.updatePurchase(purchase.id, { trial_cancelled_at: now }, { trial_cancelled_at: null });
  if (!won) return { ...base, outcome: 'already' };

  const profile = purchase.user_id ? await deps.loadProfile(purchase.user_id) : null;
  const to = profile?.email || purchase.email;
  const emailSent = to ? await deps.sendRefundEmail(to, purchase.id) : false;
  return { ...base, outcome: 'trial_cancelled', emailSent };
}
