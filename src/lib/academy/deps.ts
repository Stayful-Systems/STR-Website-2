import 'server-only';

/**
 * Live wiring for the Academy linking flows (link.ts): the Supabase admin
 * client, Stripe, the activity log and the email sender. The webhook, admin
 * panel, sign-in hook and daily cron call the convenience functions below.
 * Logs carry ids only, never an email.
 */
import type Stripe from 'stripe';
import { createAdminClient } from '../supabase/admin';
import { getStripe } from '../stripe/client';
import { priceIdForPlan } from '../stripe/prices';
import { savePaymentMethod } from '../stripe/customer';
import { payerFor } from '../team';
import { recordActivity } from '../activity/log';
import { sendEmail, isEmailConfigured } from '../email/send';
import { siteUrl } from '../url';
import { emailKey, type LinkBy } from './rules';
import { academyRefundEmail } from './emails';
import {
  cancelTrialForRefund as cancelTrialForRefundCore,
  linkAcademyPurchase as linkAcademyPurchaseCore,
  linkPendingForUser as linkPendingForUserCore,
  unlinkAcademyPurchase as unlinkAcademyPurchaseCore,
  type AcademyLinkDeps,
  type AcademyPurchaseRow,
  type AcademyProfileRow,
  type LinkResult,
  type RefundResult,
  type UnlinkResult,
} from './link';

const PURCHASE_COLUMNS =
  'id, email, stripe_customer_id, stripe_payment_intent_id, stripe_payment_method_id, user_id, linked_at, linked_by, trial_subscription_id, refunded_at, terms_accepted_at, trial_started_at, trial_ends_at, previous_customer_id, flag_reason, reminder_sent_at, trial_cancelled_at';
const PROFILE_COLUMNS = 'id, email, plan_code, stripe_customer_id, stripe_subscription_id, stripe_subscription_status, stripe_default_payment_method_id';

function isMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'resource_missing';
}

export function liveAcademyDeps(): AcademyLinkDeps {
  const db = createAdminClient();
  const stripe = getStripe();
  return {
    automaticTax: process.env.STRIPE_TAX === 'true',
    proPriceId: () => priceIdForPlan('pro'),

    loadPurchase: async (id) => {
      const { data, error } = await db.from('academy_purchases').select(PURCHASE_COLUMNS).eq('id', id).maybeSingle();
      if (error) throw new Error(`academy purchase read failed: ${error.message}`);
      return (data as AcademyPurchaseRow | null) ?? null;
    },
    loadPurchaseByPaymentIntent: async (pi) => {
      const { data, error } = await db.from('academy_purchases').select(PURCHASE_COLUMNS).eq('stripe_payment_intent_id', pi).maybeSingle();
      if (error) throw new Error(`academy purchase read failed: ${error.message}`);
      return (data as AcademyPurchaseRow | null) ?? null;
    },
    listUnlinkedPurchases: async (email) => {
      const { data, error } = await db
        .from('academy_purchases')
        .select(PURCHASE_COLUMNS)
        .eq('email', email)
        .is('user_id', null)
        .is('trial_subscription_id', null)
        .is('refunded_at', null)
        .order('created_at', { ascending: true })
        .limit(10);
      if (error) throw new Error(`academy purchase read failed: ${error.message}`);
      return (data ?? []) as AcademyPurchaseRow[];
    },
    emailHadEarlierTrial: async (email, exceptId) => {
      const { data, error } = await db.from('academy_purchases').select('id').eq('email', email).neq('id', exceptId).not('trial_subscription_id', 'is', null).limit(1);
      if (error) throw new Error(`academy purchase read failed: ${error.message}`);
      return (data ?? []).length > 0;
    },
    updatePurchase: async (id, patch, where = {}) => {
      let q = db.from('academy_purchases').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
      for (const [col, v] of Object.entries(where)) q = v === null ? q.is(col, null) : q.eq(col, v as string);
      const { data, error } = await q.select('id');
      if (error) throw new Error(`academy purchase write failed: ${error.message}`);
      return (data ?? []).length > 0;
    },

    loadProfile: async (userId) => {
      const { data, error } = await db.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle();
      if (error) throw new Error(`profile read failed: ${error.message}`);
      return (data as AcademyProfileRow | null) ?? null;
    },
    updateProfile: async (userId, patch) => {
      const { error } = await db.from('profiles').update(patch).eq('id', userId);
      if (error) throw new Error(`profile write failed: ${error.message}`);
    },
    emailConfirmed: async (userId) => {
      const { data, error } = await db.auth.admin.getUserById(userId);
      if (error) throw new Error(`auth user read failed: ${error.message}`);
      return Boolean(data.user?.email_confirmed_at);
    },
    isTeamMember: async (userId) => (await payerFor(userId)).memberId !== null,

    listSubscriptions: async (customerId) => {
      try {
        return (await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })).data;
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
    },
    retrieveSubscription: async (id) => {
      try {
        return await stripe.subscriptions.retrieve(id);
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },
    createSubscription: (params: Stripe.SubscriptionCreateParams, idempotencyKey: string) => stripe.subscriptions.create(params, { idempotencyKey }),
    cancelSubscription: (id) => stripe.subscriptions.cancel(id),
    hasPaidInvoice: async (subscriptionId) => {
      const list = await stripe.invoices.list({ subscription: subscriptionId, status: 'paid', limit: 100 });
      return list.data.some((inv) => inv.amount_paid > 0);
    },
    cardLast4: async (pmId) => {
      try {
        return (await stripe.paymentMethods.retrieve(pmId)).card?.last4 ?? null;
      } catch {
        return null;
      }
    },
    savePaymentMethod,

    logTrialStarted: (userId, subId) => recordActivity(userId, 'academy_trial_started', { dedupeKey: `academy_trial_started:${subId}` }),
    sendRefundEmail: async (to, purchaseId) => {
      if (!isEmailConfigured()) return false;
      try {
        const email = academyRefundEmail({ siteUrl: siteUrl() });
        const res = await sendEmail({ to, ...email, idempotencyKey: `academy-refund:${purchaseId}` });
        return res.sent;
      } catch (err) {
        console.error(`[academy] refund email for purchase ${purchaseId} failed:`, (err as Error).message);
        return false;
      }
    },
  };
}

/** Link a purchase to an account and start its trial (dry: say what would happen, change nothing). */
export function linkAcademyPurchase(purchaseId: string, userId: string, by: LinkBy, opts: { dry?: boolean } = {}): Promise<LinkResult> {
  return linkAcademyPurchaseCore(liveAcademyDeps(), purchaseId, userId, by, opts);
}

/** Link every unlinked purchase made with the account's email (sign-in hook, daily cron). */
export function linkPendingForUser(userId: string): Promise<LinkResult[]> {
  return linkPendingForUserCore(liveAcademyDeps(), userId);
}

/** Admin Unlink (only while nothing has been paid on the trial). */
export function unlinkAcademyPurchase(purchaseId: string, opts: { dry?: boolean } = {}): Promise<UnlinkResult> {
  return unlinkAcademyPurchaseCore(liveAcademyDeps(), purchaseId, opts);
}

/** A refund of the Academy payment (webhook charge.refunded). */
export function cancelTrialForRefund(paymentIntentId: string, fullyRefunded: boolean): Promise<RefundResult> {
  return cancelTrialForRefundCore(liveAcademyDeps(), paymentIntentId, fullyRefunded);
}

/**
 * For ensureStripeCustomer: the Stripe customer of an Academy purchase linked
 * to this account, else of an unrefunded, unlinked one made with the
 * account's email (only when that sign-in email is confirmed), while that
 * customer still exists. Null otherwise.
 */
export async function academyCustomerFor(userId: string, email: string | null): Promise<string | null> {
  const db = createAdminClient();
  const { data: linked } = await db.from('academy_purchases').select('stripe_customer_id').eq('user_id', userId).not('stripe_customer_id', 'is', null).order('created_at', { ascending: false }).limit(1);
  let customerId = (linked as Array<{ stripe_customer_id: string }> | null)?.[0]?.stripe_customer_id ?? null;
  if (!customerId && email) {
    const { data: auth } = await db.auth.admin.getUserById(userId);
    if (!auth.user?.email_confirmed_at) return null;
    const { data: unlinked } = await db
      .from('academy_purchases')
      .select('stripe_customer_id')
      .eq('email', emailKey(email))
      .is('user_id', null)
      .is('refunded_at', null)
      .not('stripe_customer_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1);
    customerId = (unlinked as Array<{ stripe_customer_id: string }> | null)?.[0]?.stripe_customer_id ?? null;
  }
  if (!customerId) return null;
  try {
    const c = await getStripe().customers.retrieve(customerId);
    return 'deleted' in c && c.deleted ? null : customerId;
  } catch {
    return null;
  }
}
