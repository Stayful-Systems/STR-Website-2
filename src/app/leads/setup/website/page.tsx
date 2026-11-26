import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isCalculatorMode } from "@/lib/websites/calculator";
import { siteAbsoluteUrl } from "@/lib/websites/urls";
import { CalculatorBrand } from "./CalculatorBrand";
import { calculatorActor, websiteSetupContext } from "./context";
import { Notice } from "./Notice";
import { stepPath } from "./steps";

export const metadata: Metadata = { title: "Your website — Stayful Intelligence", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Batch 31: the website setup's front door. Anyone arriving is sent to their
 * current step (the first one not done); a live or paused site gets a notice;
 * a team member, a member nobody invited and a non-management account are sent
 * to Leads (context.ts).
 *
 * Batch 55 (Part A): an owner whose site is the calculator-only site (mode
 * 'calculator') sees one screen with just their company name, logo, colour,
 * areas, fee and contact details. No steps, no page text, no approval, no web
 * address, no photo or about text. Every other owner gets exactly the above.
 */
export default async function WebsiteSetupStart() {
  const calc = await calculatorActor();
  if (calc.ok && isCalculatorMode(calc.actor.site.mode)) {
    const { site } = calc.actor;
    const address = siteAbsoluteUrl(site, "");
    return (
      <main className="min-h-screen bg-background">
        <div className="mx-auto max-w-4xl px-4 pb-16 pt-6 sm:px-6">
          <Link href="/leads" className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">
            ← Leads
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-foreground">Your income calculator</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Landlords use your calculator to get a free income report. It shows your company name, logo and colour. Change them here and the calculator updates straight away.
          </p>
          <p className="mt-2 text-sm text-foreground">
            <a href={address} className="font-medium underline underline-offset-2" target="_blank" rel="noreferrer">
              {address}
            </a>
          </p>
          <div className="mt-6">
            <CalculatorBrand settings={site.settings} />
          </div>
        </div>
      </main>
    );
  }

  const ctx = await websiteSetupContext();
  if (ctx.kind !== "ready") return <Notice ctx={ctx} />;
  redirect(stepPath(ctx.resume));
}
