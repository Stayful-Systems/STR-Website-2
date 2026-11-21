import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { websiteActor } from "../../setup/website/context";
import { TransferForm, TransferStatus } from "./TransferForm";
import { transferScreenAction } from "./transfer-actions";

export const metadata: Metadata = { title: "Take my website — Stayful Intelligence", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Batch 37 (Phase 8): take your website away with you. Owner only: the website is the signed-in
 * owner's own (websiteActor); a team member, a member with no website and a signed-out visitor never
 * see it. No id comes from the address. Before a transfer: what happens, the provider picker and a
 * Check. After it starts: the files, the domain and when our copy stops.
 */
export default async function TransferPage() {
  const r = await websiteActor();
  if (!r.ok) {
    if (r.reason === "signed_out") redirect("/login?redirect=/leads/website/transfer");
    redirect("/leads");
  }
  const screen = await transferScreenAction();
  if (screen.kind === "denied") redirect("/leads");

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-4 pb-16 sm:px-6">
        <Link href="/leads/website" className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">
          ← Back to your website
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">Take my website</h1>

        {screen.kind === "unavailable" ? (
          <p role="alert" className="mt-4 rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
            We could not load this just now. Please try again in a minute.
          </p>
        ) : null}

        {screen.kind === "status" ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">You have asked to take your website. Here is where it has got to.</p>
            <div className="mt-6">
              <TransferStatus view={screen.view} overlapDays={screen.overlapDays} />
            </div>
          </>
        ) : null}

        {screen.kind === "start" ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              Want to run your website yourself, or with someone else? You can take it with you. Here is what happens.
            </p>
            {screen.previouslyCancelled ? (
              <p role="status" className="mt-4 rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
                An earlier transfer was cancelled. You can start again below.
              </p>
            ) : null}
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-foreground">
              <li>We email you your website files and a step-by-step guide to putting them online.</li>
              {screen.hasDomain ? <li>Your domain moves to the company you choose below.</li> : <li>You have no domain with us, so there is no domain to move.</li>}
              {screen.method === "code" ? <li>We&rsquo;ll email you a transfer code. You give it to the company you are moving to, and they do the rest.</li> : null}
              <li>
                Our copy of your website keeps running for {screen.overlapDays} days{screen.hasDomain ? ", and until your domain has moved" : ""}, so nothing breaks while you set yours up. Then our hosting stops.
              </li>
              <li>The enquiry form in your files keeps sending leads to your account, with or without a plan.</li>
            </ul>
            <div className="mt-6">
              <TransferForm hasDomain={screen.hasDomain} />
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
