import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requestStatusLabel } from "@/lib/websites/edit-requests";
import { liveRequestsEngine } from "@/lib/websites/edit-requests-store";
import { websiteActor } from "../../setup/website/context";
import { RequestForm } from "./RequestForm";

export const metadata: Metadata = { title: "Website change requests — Stayful Intelligence", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });

/**
 * Batch 36 (Phase 5): ask Stayful for a change to your website, and see what
 * you have asked for. Owner only: the requests listed are the signed-in
 * owner's own (the engine filters by the owner's id); a team member, or a
 * member with no website, is sent back to Leads.
 */
export default async function WebsiteRequestsPage() {
  const r = await websiteActor();
  if (!r.ok) {
    if (r.reason === "signed_out") redirect("/login?redirect=/leads/website/requests");
    redirect("/leads");
  }
  const requests = await liveRequestsEngine().listOwn(r.actor.userId);
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-4 pb-16 sm:px-6">
        <Link href="/leads/website" className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">
          ← Back to your website
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">Ask for a change</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something you can&rsquo;t change yourself, like a new web address or a new page? Tell us here. There is no limit on requests.
        </p>
        <div className="mt-6">
          <RequestForm />
        </div>
        {requests.length > 0 ? (
          <section className="mt-10" aria-labelledby="your-requests">
            <h2 id="your-requests" className="text-lg font-semibold text-foreground">Your requests</h2>
            <ul className="mt-3 space-y-3">
              {requests.map((q) => (
                <li key={q.id} className="rounded-lg border border-border p-4 text-sm">
                  <p className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>{WHEN.format(new Date(q.createdAt))}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">{requestStatusLabel(q.status)}</span>
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-foreground">{q.body}</p>
                  {q.adminNotes && (q.status === "done" || q.status === "declined") ? <p className="mt-2 text-muted-foreground">Note from us: {q.adminNotes}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  );
}
