import { stripeConfigured, getStripe } from '@/lib/stripe/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { siteUrl } from '@/lib/url';
import { verifyAcademyCancelToken } from '@/lib/academy/cancel-link';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Subscriptions that can still be cancelled (and are not already ending). */
const CANCELLABLE = new Set(['trialing', 'active', 'past_due', 'unpaid', 'paused']);

function toBilling(): Response {
  return Response.redirect(siteUrl('/account/billing'), 303);
}

/**
 * Batch 31a: GET ?t=<token> — the Academy reminder email's one-tap cancel
 * link (src/lib/academy/cancel-link.ts). A valid token (signed, before the
 * trial end) for a trial that is still running and not refunded opens a fresh
 * Stripe portal "cancel subscription" flow for that trial, without signing in.
 * Anything else (bad or expired link, unknown or refunded purchase, a trial
 * already cancelled or ending) goes to Account → Billing. Logs carry ids only.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('t');
  const verified = verifyAcademyCancelToken(token);
  if (!verified || !stripeConfigured()) return toBilling();
  const subId = verified.subId;

  try {
    const { data: purchase, error } = await createAdminClient().from('academy_purchases').select('id, refunded_at').eq('trial_subscription_id', subId).maybeSingle();
    if (error) throw new Error(`academy purchase read failed: ${error.message}`);
    if (!purchase || (purchase as { refunded_at: string | null }).refunded_at) return toBilling();

    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subId);
    if (!CANCELLABLE.has(sub.status) || sub.cancel_at_period_end || sub.cancel_at) return toBilling();
    const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

    const portal = await stripe.billingPortal.sessions.create({
      customer,
      return_url: siteUrl('/account/billing'),
      ...(process.env.STRIPE_PORTAL_CONFIG_ID ? { configuration: process.env.STRIPE_PORTAL_CONFIG_ID } : {}),
      flow_data: { type: 'subscription_cancel', subscription_cancel: { subscription: subId } },
    });
    return Response.redirect(portal.url, 303);
  } catch (err) {
    console.error(`[billing/academy/cancel] portal for ${subId} failed:`, (err as Error)?.message ?? err);
    return toBilling();
  }
}
