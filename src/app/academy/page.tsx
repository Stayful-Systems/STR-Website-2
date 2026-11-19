import type { Metadata } from "next";
import { ACADEMY_FACTS } from "@/lib/academy/rules";
import { BuyButton } from "./BuyButton";

export const metadata: Metadata = {
  title: "Stayful Academy — Stayful Intelligence",
  robots: { index: false, follow: false },
};

/**
 * Batch 31a: the Stayful Academy's buy page. Public (signed in or not), not
 * in the nav, sitemap or search; Zac links to it directly. The price is shown
 * by Stripe Checkout, never typed here.
 */
export default function AcademyPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">Stayful Intelligence</p>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">Stayful Academy</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Includes {ACADEMY_FACTS.trialMonths} months of Stayful Intelligence Pro free.
        </p>
        <BuyButton />
      </div>
    </main>
  );
}
