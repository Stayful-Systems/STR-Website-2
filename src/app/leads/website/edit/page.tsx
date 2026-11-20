import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { pendingKeys } from "@/lib/websites/edit-run";
import { editRunFor } from "@/lib/websites/edit-server";
import { websiteActor } from "../../setup/website/context";
import { EditWebsite } from "./EditWebsite";

export const metadata: Metadata = { title: "Edit your website — Stayful Intelligence", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Batch 36: edit a live website. Server component: the site is the signed-in
 * OWNER's (websiteActor), the edit run is built from that owner's id, and a
 * site that is paused, switched off or not live gets the run's own plain
 * sentence instead of the editor. Nothing is opened (no draft, no snapshot)
 * just by looking: the first save does that.
 */
export default async function EditWebsitePage() {
  const r = await websiteActor();
  if (!r.ok) {
    if (r.reason === "signed_out") redirect("/login?redirect=/leads/website/edit");
    redirect("/leads");
  }
  const run = await editRunFor(r.actor.userId);
  const st = run ? await run.state() : null;
  if (!st || !st.ok) redirect("/leads");

  if (st.editable) {
    return (
      <main className="min-h-screen bg-background">
        <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
          <Link href="/leads/website" className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">← Your website</Link>
          <h1 className="mt-2 text-2xl font-semibold text-foreground">Edit your website</h1>
          <p role="status" className="mt-4 rounded-lg border border-border bg-card p-4 text-sm text-foreground">{st.editable.message}</p>
        </div>
      </main>
    );
  }

  const { site, draft } = st;
  const settings = draft?.settings ?? site.settings;
  const copy = draft?.pages ?? site.pages;
  if (!copy) redirect("/leads/website");
  const newest = st.versions.reduce((n, v) => Math.max(n, v.versionNo), 0);
  const problems = st.problems.map((p) => `${p.page === "site" ? "Your details" : `The ${p.page.replace(/^areas\//, "")} page`}: ${p.message}`);

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <Link href="/leads/website" className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">← Your website</Link>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">Edit your website</h1>
        <p className="mt-2 text-sm text-muted-foreground">Your changes are saved as a draft. Your live website only changes when you publish.</p>
        <div className="mt-6">
          <EditWebsite
            slug={site.slug}
            domain={site.domain ?? null}
            settings={settings}
            copy={copy}
            hasDraft={draft !== null}
            pending={pendingKeys(draft?.pendingPages ?? [])}
            left={st.left}
            problems={problems}
            versions={st.versions.map((v) => ({ versionNo: v.versionNo, kind: v.kind, restoredFrom: v.restoredFrom, publishedAt: v.publishedAt }))}
            newestVersion={newest}
          />
        </div>
      </div>
    </main>
  );
}
