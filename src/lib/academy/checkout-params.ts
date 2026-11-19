/**
 * The Stayful Academy's Stripe Checkout parameters (Batch 31a). Pure, so the
 * signed-in and signed-out parameter sets are unit-tested
 * (checkout-params.test.ts); the route (src/app/api/billing/academy/checkout)
 * passes them straight to `stripe.checkout.sessions.create`, never through
 * createCheckoutSession, which would drop the terms tick box when Stripe has
 * no Terms URL. The tick box is the buyer's consent to the card being saved
 * and charged after the free months, so the checkout never opens without it.
 */
import type Stripe from 'stripe';
import { ACADEMY_FACTS } from './rules.ts';

/** Stripe swaps this for the session id on the way back; it must reach Stripe unencoded. */
export const CHECKOUT_SESSION_PLACEHOLDER = '{CHECKOUT_SESSION_ID}';

/** "£39.99" from a GBP amount in pence; null for anything else (the wording promises pounds). */
export function poundsFromPence(amountPence: number | null | undefined, currency: string | null | undefined): string | null {
  if (typeof amountPence !== 'number' || !Number.isInteger(amountPence) || amountPence <= 0) return null;
  if ((currency ?? '').toLowerCase() !== 'gbp') return null;
  return `£${(amountPence / 100).toFixed(2)}`;
}

/** The tick-box wording (PLAN.md "Exact wording"), with the Pro price as Stripe charges it. */
export function academyTermsMessage(proMonthly: string): string {
  return (
    `Includes ${ACADEMY_FACTS.trialMonths} months of Stayful Intelligence Pro free, starting when you create your Intelligence account with this email. ` +
    `After that it's ${proMonthly}/month on this card until you cancel. Cancel any time in Account → Billing.`
  );
}

export interface AcademyCheckoutInput {
  /** STRIPE_PRICE_ACADEMY: the one-off GBP price. */
  academyPriceId: string;
  termsMessage: string;
  /** The site's base URL (no trailing slash needed). */
  siteBase: string;
  /** A signed-in member who pays for themselves (not a team member), with their Stripe customer; null otherwise. */
  member: { id: string; customerId: string } | null;
  automaticTax: boolean;
}

export function academyCheckoutParams(input: AcademyCheckoutInput): Stripe.Checkout.SessionCreateParams {
  const base = input.siteBase.replace(/\/$/, '');
  const metadata: Record<string, string> = input.member ? { kind: 'academy', user_id: input.member.id } : { kind: 'academy' };
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{ price: input.academyPriceId, quantity: 1 }],
    payment_intent_data: { setup_future_usage: 'off_session', metadata: { ...metadata } },
    metadata: { ...metadata },
    consent_collection: { terms_of_service: 'required' },
    custom_text: { terms_of_service_acceptance: { message: input.termsMessage } },
    success_url: `${base}/academy/welcome?session_id=${CHECKOUT_SESSION_PLACEHOLDER}`,
    cancel_url: `${base}/academy`,
    allow_promotion_codes: false,
  };
  if (input.member) {
    params.customer = input.member.customerId;
    params.client_reference_id = input.member.id;
    if (input.automaticTax) {
      params.automatic_tax = { enabled: true };
      params.customer_update = { address: 'auto' };
    }
  } else {
    // Stripe makes the customer, so the card saved for after the free months has one to live on.
    params.customer_creation = 'always';
    if (input.automaticTax) params.automatic_tax = { enabled: true };
  }
  return params;
}

/** True when Stripe refused the session because the account has no Terms of Service URL. */
export function isTermsUrlMissingError(err: unknown): boolean {
  const msg = String((err as { message?: unknown } | null)?.message ?? '');
  return /terms_of_service|terms of service|consent_collection/i.test(msg);
}
