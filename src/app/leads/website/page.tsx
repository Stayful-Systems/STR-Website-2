import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { dueDayText } from "@/lib/websites/lead-panel";
import { DELETION_KEEPS, DELETION_REMOVES } from "@/lib/websites/grace-run";
import { graceForSite } from "@/lib/websites/grace-server";
import { siteAbsoluteUrl } from "@/lib/websites/urls";
import { websiteActor } from "../setup/website/context";
import { SwitchOnButton } from "./SwitchOnButton";

export const metadata: Metadata = { title: "Your website — Stayful Intelligence", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Batch 36: the website home. Status, any warning with its switch-off date,
 * "Switch back on" when the site was switched off, and the way to Edit and to
 * send a change request. Server component: the site is the signed-in OWNER's
 * (websiteActor); a team member, a member nobody invited and a signed-out
 * visitor never see it. The grace state is derived now (graceForSite), never
 * read from the stored row, so a login that cancels a switch-off is shown at
 * once.
 */

const WARNING: Record<string, string> = {
  abandoned: "because nobody has logged in or had an enquiry through it for a long time. Logging in keeps it live.",
  cancelled: "because your plan has ended. Starting your plan again keeps it live.",
  unpaid: "because the yearly charge for your web address is unpaid. Paying it keeps your website.",
};

const linkBtn = "inline-flex min-h-10 items-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground hover:bg-muted";

export default async function WebsiteHome() {
  const r = await websiteActor();
  if (!r.ok) {
    if (r.reason === "signed_out") redirect("/login?redirect=/leads/website");
    redirect("/leads");
  }
  const { site } = r.actor;
  const grace = await graceForSite(site.id);
  const live = site.status === "live";
  const switchedOff = Boolean(grace?.switchedOff);
  const deleted = Boolean(grace?.deleted);
  const address = siteAbsoluteUrl(site, "");

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <Link href="/leads" className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">← Leads</Link>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">Your website</h1>

        {live ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Your website is live at{" "}
            <a href={address} className="font-medium text-foreground underline underline-offset-2" target="_blank" rel="noreferrer">{address}</a>.
          </p>
        ) : null}

        {live && grace?.pendingSwitchOff ? (
          <div role="status" className="mt-5 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-foreground">
            <p className="font-medium">Your website will be switched off on {dueDayText(grace.pendingSwitchOff)}</p>
            <p className="mt-1 text-muted-foreground">{WARNING[grace.reason ?? "abandoned"]}</p>
          </div>
        ) : null}

        {switchedOff && !deleted ? (
          <div className="mt-5 space-y-4">
            <div className="rounded-lg border border-border bg-card p-4 text-sm">
              <p className="font-medium text-foreground">Your website has been switched off</p>
              <p className="mt-1 text-muted-foreground">Visitors see a page saying it is no longer available, and your web address has stopped renewing. Your leads and their reports carry on as usual.</p>
              {grace?.deleteOn ? <p className="mt-2 text-foreground">Its data will be deleted on {dueDayText(grace.deleteOn)} unless you switch it back on first.</p> : null}
            </div>
            <SwitchOnButton />
            <div className="rounded-lg border border-border p-4 text-sm">
              <p className="font-medium text-foreground">If it is deleted, we remove</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {DELETION_REMOVES.map((x) => <li key={x}>{x}</li>)}
              </ul>
              <p className="mt-3 font-medium text-foreground">and we keep</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {DELETION_KEEPS.map((x) => <li key={x}>{x}</li>)}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">Want a copy of your website&rsquo;s data first? Ask the team and we will send it.</p>
            </div>
          </div>
        ) : null}

        {deleted ? (
          <div className="mt-5 rounded-lg border border-border bg-card p-4 text-sm">
            <p className="font-medium text-foreground">Your website&rsquo;s data has been deleted</p>
            <p className="mt-1 text-muted-foreground">Your leads are kept as usual. Send a change request if you would like a new website.</p>
          </div>
        ) : null}

        {site.status === "paused" && !switchedOff && !deleted ? (
          <div className="mt-5 rounded-lg border border-border bg-card p-4 text-sm">
            <p className="font-medium text-foreground">Your website is paused</p>
            <p className="mt-1 text-muted-foreground">Get in touch if you would like it back on.</p>
          </div>
        ) : null}

        {!live && site.status !== "paused" ? (
          <div className="mt-5 rounded-lg border border-border bg-card p-4 text-sm">
            <p className="font-medium text-foreground">Your website is not live yet</p>
            <p className="mt-1 text-muted-foreground">Finish setting it up, then approve it to go live.</p>
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-3">
          {live ? <Link href="/leads/website/edit" className={linkBtn}>Edit your website</Link> : null}
          {!live && site.status !== "paused" ? <Link href="/leads/setup/website" className={linkBtn}>Continue setup</Link> : null}
          <Link href="/leads/website/requests" className={linkBtn}>Change requests</Link>
        </div>
      </div>
    </main>
  );
}
