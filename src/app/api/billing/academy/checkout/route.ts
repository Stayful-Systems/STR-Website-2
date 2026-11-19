import { currentMember } from '@/lib/credit/auth';
import { priceIdForPlan } from '@/lib/stripe/prices';
import { stripeConfigured, getStripe } from '@/lib/stripe/client';
import { ensureStripeCustomer, loadBillingProfile } from '@/lib/stripe/customer';
import { siteUrl } from '@/lib/url';
import { academyCheckoutParams, academyTermsMessage, isTermsUrlMissingError, poundsFromPence } from '@/lib/academy/checkout-params';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const NOT_SET_UP = "The Academy checkout isn't set up yet.";

/**
 * Batch 31a: POST → { url } to Stripe Checkout for the Stayful Academy, a
 * one-off card payment that saves the card for the free Pro months after it
 * (src/lib/academy). Anyone may buy, signed in or not. A signed-in member who
 * pays for themselves buys on their own Stripe customer; anyone else (signed
 * out, or a team member, whose billing is the owner's) gets a new customer
 * from Checkout, and the webhook links the purchase by email later.
 *
 * Never opens without the terms tick box (the consent to charge the saved
 * card after the free months): no Academy price, no Pro price, or no Terms of
 * Service URL in the Stripe Dashboard → 503, and nothing is retried without it.
 */
export async function POST() {
  if (!stripeConfigured()) return Response.json({ error: 'Payments are not configured yet. Email hello@stayful.co.uk.' }, { status: 503 });
  const academyPriceId = process.env.STRIPE_PRICE_ACADEMY || null;
  const proPriceId = priceIdForPlan('pro');
  if (!academyPriceId || !proPriceId) {
    console.error(`[billing/academy] checkout refused: ${!academyPriceId ? 'STRIPE_PRICE_ACADEMY' : 'STRIPE_PRICE_PRO'} is not set`);
    return Response.json({ error: NOT_SET_UP }, { status: 503 });
  }

  const stripe = getStripe();
  let proMonthly: string | null;
  try {
    const pro = await stripe.prices.retrieve(proPriceId);
    proMonthly = pro.recurring?.interval === 'month' && pro.recurring.interval_count === 1 ? poundsFromPence(pro.unit_amount, pro.currency) : null;
  } catch (err) {
    console.error('[billing/academy] Pro price lookup failed:', (err as Error)?.message ?? err);
    return Response.json({ error: "Couldn't start checkout. Please try again." }, { status: 502 });
  }
  if (!proMonthly) {
    console.error(`[billing/academy] checkout refused: Pro price ${proPriceId} is not a monthly GBP price`);
    return Response.json({ error: NOT_SET_UP }, { status: 503 });
  }

  let member: { id: string; customerId: string } | null = null;
  try {
    const signedIn = await currentMember();
    if (signedIn && !signedIn.teamMember) {
      const profile = await loadBillingProfile(signedIn.id);
      if (profile) member = { id: signedIn.id, customerId: await ensureStripeCustomer(profile, signedIn.email) };
    }
  } catch (err) {
    console.error('[billing/academy] customer lookup failed:', (err as Error)?.message ?? err);
    return Response.json({ error: "Couldn't start checkout. Please try again." }, { status: 502 });
  }

  const params = academyCheckoutParams({
    academyPriceId,
    termsMessage: academyTermsMessage(proMonthly),
    siteBase: siteUrl(),
    member,
    automaticTax: process.env.STRIPE_TAX === 'true',
  });
  try {
    const session = await stripe.checkout.sessions.create(params);
    if (!session.url) throw new Error(`checkout session ${session.id} has no url`);
    return Response.json({ url: session.url });
  } catch (err) {
    if (isTermsUrlMissingError(err)) {
      console.error('[billing/academy] Stripe refused the terms tick box: set a Terms of Service URL in the Stripe Dashboard (Settings → Public details). The Academy checkout stays closed until then:', (err as Error)?.message ?? err);
      return Response.json({ error: NOT_SET_UP }, { status: 503 });
    }
    console.error('[billing/academy] checkout failed:', (err as Error)?.message ?? err);
    return Response.json({ error: "Couldn't start checkout. Please try again." }, { status: 502 });
  }
}
