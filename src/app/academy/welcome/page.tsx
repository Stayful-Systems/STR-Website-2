import type { Metadata } from "next";
import Link from "next/link";
import { currentMember } from "@/lib/credit/auth";
import { stripeConfigured, getStripe } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { ACADEMY_FACTS, emailKey, maskEmail } from "@/lib/academy/rules";

export const metadata: Metadata = {
  title: "Stayful Academy — Stayful Intelligence",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const CONTACT = "mailto:hello@stayful.co.uk";
const NO_MATCH = "Use the email you bought the Academy with, or contact us.";

interface PurchaseRow {
  email: string;
  user_id: string | null;
  trial_subscription_id: string | null;
  refunded_at: string | null;
  flag_reason: string | null;
}

type View =
  | { kind: "not_found" }
  | { kind: "pending" }
  | { kind: "started" }
  | { kind: "refunded" }
  | { kind: "flagged" }
  | { kind: "linked_elsewhere"; masked: string; signedIn: boolean }
  | { kind: "no_match"; masked: string };

async function viewFor(sessionId: string | undefined): Promise<View> {
  if (!sessionId || !/^cs_[A-Za-z0-9_]{1,250}$/.test(sessionId) || !stripeConfigured()) return { kind: "not_found" };
  let paymentIntentId: string | null;
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.metadata?.kind !== "academy" || session.payment_status !== "paid") return { kind: "not_found" };
    paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
  } catch {
    return { kind: "not_found" };
  }

  const db = createAdminClient();
  const columns = "email, user_id, trial_subscription_id, refunded_at, flag_reason";
  let { data } = await db.from("academy_purchases").select(columns).eq("stripe_checkout_session_id", sessionId).maybeSingle();
  if (!data && paymentIntentId) ({ data } = await db.from("academy_purchases").select(columns).eq("stripe_payment_intent_id", paymentIntentId).maybeSingle());
  const purchase = (data as PurchaseRow | null) ?? null;
  // The webhook records the purchase; it can land a few seconds after the buyer does.
  if (!purchase) return { kind: "pending" };
  if (purchase.refunded_at) return { kind: "refunded" };

  const member = await currentMember();
  const masked = maskEmail(purchase.email);
  if (purchase.user_id) {
    if (member && purchase.user_id === member.id) return { kind: "started" };
    return { kind: "linked_elsewhere", masked, signedIn: Boolean(member) };
  }
  if (member?.email && emailKey(member.email) === purchase.email) return purchase.flag_reason ? { kind: "flagged" } : { kind: "pending" };
  return { kind: "no_match", masked };
}

/**
 * Batch 31a: where Stripe Checkout returns an Academy buyer
 * (?session_id=…). Says whether the free Pro months have started on this
 * account and, if not, which email the purchase was made with, masked
 * (j•••@gmail.com): anyone holding the URL can open this page, so the full
 * address is never shown.
 */
export default async function AcademyWelcomePage({ searchParams }: { searchParams: Promise<{ session_id?: string | string[] }> }) {
  const { session_id } = await searchParams;
  const view = await viewFor(typeof session_id === "string" ? session_id : undefined);
  const months = ACADEMY_FACTS.trialMonths;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">Stayful Academy</p>
        {view.kind === "not_found" ? (
          <>
            <h1 className="mt-2 text-2xl font-semibold text-foreground">We couldn’t find that purchase</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Check the link from your receipt, or <a href={CONTACT} className="font-medium text-primary hover:underline">contact us</a>.
            </p>
          </>
        ) : view.kind === "pending" ? (
          <>
            <h1 className="mt-2 text-2xl font-semibold text-foreground">Thanks for buying the Academy</h1>
            <p className="mt-3 text-sm text-muted-foreground">Thanks — we’re setting up your free months; refresh in a minute.</p>
          </>
        ) : view.kind === "started" ? (
          <>
            <h1 className="mt-2 text-2xl font-semibold text-foreground">You’re all set</h1>
            <p className="mt-3 text-sm text-muted-foreground">Your {months} free months of Stayful Intelligence Pro have started.</p>
            <Link href="/account/billing" className="mt-6 inline-flex rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90">
              Go to Billing
            </Link>
          </>
        ) : view.kind === "refunded" ? (
          <>
            <h1 className="mt-2 text-2xl font-semibold text-foreground">This purchase was refunded</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Questions? <a href={CONTACT} className="font-medium text-primary hover:underline">Contact us</a>.
            </p>
          </>
        ) : view.kind === "flagged" ? (
          <>
            <h1 className="mt-2 text-2xl font-semibold text-foreground">Thanks for buying the Academy</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              We couldn’t start your free months automatically. <a href={CONTACT} className="font-medium text-primary hover:underline">Contact us</a> and we’ll sort it out.
            </p>
          </>
        ) : view.kind === "linked_elsewhere" ? (
          <>
            <h1 className="mt-2 text-2xl font-semibold text-foreground">Your free months have started</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              They’re on the account for <span className="font-medium text-foreground">{view.masked}</span>.{" "}
              {view.signedIn ? "Sign in with that email to see them." : null}
            </p>
            {view.signedIn ? null : (
              <Link href="/login?redirect=/account/billing" className="mt-6 inline-flex rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90">
                Sign in
              </Link>
            )}
            <p className="mt-4 text-xs text-muted-foreground">
              {NO_MATCH.replace("contact us.", "")}
              <a href={CONTACT} className="font-medium text-primary hover:underline">contact us</a>.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-2 text-2xl font-semibold text-foreground">Thanks for buying the Academy</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Create your Intelligence account with <span className="font-medium text-foreground">{view.masked}</span> and your {months} free months of Pro start as soon as you’ve confirmed your email.
            </p>
            <Link href="/signup" className="mt-6 inline-flex rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90">
              Create your account
            </Link>
            <p className="mt-4 text-xs text-muted-foreground">
              {NO_MATCH.replace("contact us.", "")}
              <a href={CONTACT} className="font-medium text-primary hover:underline">contact us</a>.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
