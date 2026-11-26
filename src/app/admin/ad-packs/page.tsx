import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { pageGuard } from "@/lib/ad-packs/admin-run";
import { loadAdPacksAdmin } from "@/lib/ad-packs/admin-server";
import { listAdAccounts } from "@/lib/leaddb/ad-account-server";
import type { AdAccountAdminRow } from "@/lib/leaddb/ad-account-admin";
import { AdPacksPanel } from "./AdPacksPanel";

export const dynamic = "force-dynamic";
// A Run makes the pack's images inside the request.
export const maxDuration = 60;
export const metadata: Metadata = { title: "Ad packs — Admin", robots: { index: false, follow: false } };

/**
 * Batch 38: every operator's ad pack, what each ad has brought, and the two
 * admin actions (regenerate a pack; link missing leads), each a Dry run first.
 * Admin only: the same sign-in / not-found pattern as the other admin pages.
 */
export default async function AdminAdPacks() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const guard = pageGuard(user);
  if (guard === "login") redirect("/login?redirect=/admin/ad-packs");
  if (guard === "not_found") notFound();

  const data = await loadAdPacksAdmin();
  // Batch 55: the lead database ad accounts (states and flags only). A failed read says so; it never shows an empty list as if it were true.
  let accounts: AdAccountAdminRow[] = [];
  let accountsError = false;
  if (data.available) {
    try {
      accounts = await listAdAccounts();
    } catch {
      accountsError = true;
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <Link href="/admin" className="text-sm text-primary hover:underline">← Admin</Link>
      <h1 className="mt-2 text-2xl font-bold text-foreground">Ad packs</h1>
      <p className="mt-1 text-sm"><Link href="/admin/ad-sheets" className="text-primary hover:underline">Lead form sheets →</Link></p>
      <p className="mt-1 text-sm text-muted-foreground">
        The three landlord Facebook ads each Academy operator has been given, and the website leads recorded against each ad.
        Counts only: no landlord&apos;s details are shown here.
      </p>
      {!data.available ? <p className="mt-3 rounded-md bg-muted p-3 text-sm text-muted-foreground">The database is not connected here, so nothing can be shown.</p> : null}
      {data.readError ? <p className="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{data.readError}</p> : null}
      {data.linksTruncated ? <p className="mt-3 rounded-md bg-muted p-3 text-sm text-muted-foreground">There are more lead links than this page counts, so the lead numbers may be a little low.</p> : null}
      <AdPacksPanel view={data.view} accounts={accounts} accountsError={accountsError} />
    </main>
  );
}
