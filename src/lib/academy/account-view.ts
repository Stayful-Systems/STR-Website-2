import 'server-only';
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { getStripe, stripeConfigured } from '../stripe/client';
import { priceIdForPlan } from '../stripe/prices';
import { cardSummary } from '../stripe/customer';
import { formatPlanDate } from '../subscription';
import { poundsFromPence } from './checkout-params';

/** What the account plan card says for an Academy trial (Batch 31a). */
export interface AcademyTrialView {
  freeUntil: string;
  /** The Pro price as Stripe charges it, e.g. "£39.99". */
  amount: string;
  last4: string | null;
}

/**
 * The Academy line for the account owner's plan card, or null when the plan is
 * not a live Academy trial (no linked purchase for this subscription, not
 * trialing, refunded). Fails soft: any Stripe or database error gives null and
 * the card falls back to the normal plan wording.
 */
export async function academyTrialView(
  userId: string,
  profile: { stripe_subscription_id?: unknown; stripe_subscription_status?: unknown; stripe_default_payment_method_id?: unknown },
): Promise<AcademyTrialView | null> {
  const subId = typeof profile.stripe_subscription_id === 'string' ? profile.stripe_subscription_id : null;
  if (!subId || profile.stripe_subscription_status !== 'trialing' || !hasServiceRole() || !stripeConfigured()) return null;
  try {
    const { data, error } = await createAdminClient()
      .from('academy_purchases')
      .select('trial_ends_at, stripe_payment_method_id, refunded_at')
      .eq('user_id', userId)
      .eq('trial_subscription_id', subId)
      .maybeSingle();
    if (error || !data || data.refunded_at) return null;
    const freeUntil = formatPlanDate(data.trial_ends_at as string | null);
    const priceId = priceIdForPlan('pro');
    if (!freeUntil || !priceId) return null;
    const pm = typeof profile.stripe_default_payment_method_id === 'string' ? profile.stripe_default_payment_method_id : null;
    const [price, card] = await Promise.all([
      getStripe().prices.retrieve(priceId),
      cardSummary(pm ?? (data.stripe_payment_method_id as string | null)),
    ]);
    const amount = price.recurring?.interval === 'month' && price.recurring.interval_count === 1 ? poundsFromPence(price.unit_amount, price.currency) : null;
    if (!amount) return null;
    return { freeUntil, amount, last4: card?.last4 ?? null };
  } catch (err) {
    console.warn('[account] academy trial view failed:', (err as Error)?.message ?? err);
    return null;
  }
}
