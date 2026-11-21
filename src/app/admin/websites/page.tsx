import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { isAdminEmail } from "@/lib/admin";
import { liveRequestsEngine } from "@/lib/websites/edit-requests-store";
import { nextStatuses } from "@/lib/websites/edit-requests";
import { loadConsole, realConsoleSource } from "@/lib/websites/grace-admin";
import { graceForSite, readGraceSettings } from "@/lib/websites/grace-server";
import { parseSiteSettings } from "@/lib/websites/store-server";
import { WebsitesConsole, type ConsoleRequest } from "./WebsitesConsole";
import { TransfersPanel, type TransferView } from "./TransfersPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Customer websites — Admin", robots: { index: false, follow: false } };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Batch 37: the transfers panel's rows. Read only; safe columns only (no zip path, reference, snapshot or lead). */
async function loadTransfers(): Promise<{ rows: TransferView[]; error: string | null }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("website_transfers")
    .select("id, website_id, owner_id, provider_name, ips_tag, method, domain_name, export_state, export_error, domain_state, overlap_ends_at, overlap_ended_at, cancelled_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return { rows: [], error: error.message };
  const list = (data ?? []) as Array<Record<string, unknown>>;
  const ids = (k: string) => [...new Set(list.map((r) => String(r[k])))];
  const [sites, owners] = await Promise.all([
    list.length ? admin.from("websites").select("id, slug, settings").in("id", ids("website_id")) : Promise.resolve({ data: [], error: null }),
    list.length ? admin.from("profiles").select("id, email").in("id", ids("owner_id")) : Promise.resolve({ data: [], error: null }),
  ]);
  const siteBy = new Map((sites.data ?? []).map((s) => [String((s as { id: unknown }).id), `${parseSiteSettings((s as { settings: unknown }).settings).companyName || "—"} · /s/${String((s as { slug: unknown }).slug)}`]));
  const emailBy = new Map((owners.data ?? []).map((m) => [String((m as { id: unknown }).id), str((m as { email?: unknown }).email)]));
  const rows = list.map((r): TransferView => ({
    id: String(r.id),
    email: emailBy.get(String(r.owner_id)) ?? null,
    site: siteBy.get(String(r.website_id)) ?? "unknown",
    providerName: String(r.provider_name),
    ipsTag: str(r.ips_tag),
    method: r.method === "tag" || r.method === "code" ? r.method : "none",
    domainName: str(r.domain_name),
    exportState: r.export_state === "ready" || r.export_state === "failed" ? r.export_state : "pending",
    exportError: str(r.export_error),
    domainState: r.domain_state === "pending" || r.domain_state === "manual" || r.domain_state === "requested" || r.domain_state === "moved" ? r.domain_state : "none",
    overlapEndsAt: str(r.overlap_ends_at),
    overlapEndedAt: str(r.overlap_ended_at),
    cancelledAt: str(r.cancelled_at),
  }));
  return { rows, error: sites.error?.message ?? owners.error?.message ?? null };
}

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

  let transfers: TransferView[] = [];
  let transfersError: string | null = null;
  try {
    ({ rows: transfers, error: transfersError } = await loadTransfers());
  } catch (err) {
    transfersError = (err as Error).message;
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <p className="text-xs text-muted-foreground">
        <Link href="/admin/management" className="underline">Management companies</Link>
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-foreground">Customer websites</h1>
      <WebsitesConsole sites={sites} requests={requests} settings={settings} readError={readError} />
      <TransfersPanel transfers={transfers} readError={transfersError} />
    </main>
  );
}
