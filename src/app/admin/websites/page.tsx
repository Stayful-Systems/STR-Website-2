import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasServiceRole } from "@/lib/supabase/admin";
import { isAdminEmail } from "@/lib/admin";
import { liveRequestsEngine } from "@/lib/websites/edit-requests-store";
import { nextStatuses } from "@/lib/websites/edit-requests";
import { loadConsole, realConsoleSource } from "@/lib/websites/grace-admin";
import { graceForSite, readGraceSettings } from "@/lib/websites/grace-server";
import { WebsitesConsole, type ConsoleRequest } from "./WebsitesConsole";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Customer websites — Admin", robots: { index: false, follow: false } };

/**
 * Batch 36: the admin website console. Every customer site in one list (status,
 * domain, leads, last login, last enquiry, warnings, switch-off and delete
 * dates, open change requests), the actions on a site (each with a dry run
 * first), the change requests, and the three grace settings. Admin only: anyone
 * else gets a 404. No lead contact details or addresses are read here.
 */
export default async function AdminWebsitesPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?redirect=/admin/websites");
  if (!isAdminEmail(user.email)) notFound();

  if (!hasServiceRole()) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">The service role is not configured, so websites cannot be listed or changed here.</p>
      </main>
    );
  }

  let readError: string | null = null;
  let sites: Awaited<ReturnType<typeof loadConsole>> = [];
  let requests: ConsoleRequest[] = [];
  const settings = await readGraceSettings();
  try {
    sites = await loadConsole(realConsoleSource(), (id) => graceForSite(id));
    const slugs = new Map(sites.map((s) => [s.id, s.slug]));
    requests = (await liveRequestsEngine().adminList({})).map((r) => ({
      id: r.id,
      slug: slugs.get(r.websiteId) ?? "unknown",
      body: r.body,
      status: r.status,
      adminNotes: r.adminNotes ?? "",
      createdAt: r.createdAt,
      hasScreenshot: Boolean(r.screenshotPath),
      next: [...nextStatuses(r.status)],
    }));
  } catch (err) {
    readError = (err as Error).message;
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <p className="text-xs text-muted-foreground">
        <Link href="/admin/management" className="underline">Management companies</Link>
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-foreground">Customer websites</h1>
      <WebsitesConsole sites={sites} requests={requests} settings={settings} readError={readError} />
    </main>
  );
}
