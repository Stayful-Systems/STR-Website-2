import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { pageGuard } from "@/lib/ad-packs/admin-run";
import { loadAdSheetsAdmin } from "@/lib/ad-sheets/admin-server";
import { AdSheetsPanel } from "./AdSheetsPanel";

export const dynamic = "force-dynamic";
// A Run reads the connected sheets inside the request.
export const maxDuration = 60;
export const metadata: Metadata = { title: "Lead form sheets — Admin", robots: { index: false, follow: false } };

/**
 * Batch 35: every operator's connected lead form sheet, the import's state, and
 * the admin actions (import, disconnect), each a Dry run first. Admin only: the
 * same sign-in / not-found pattern as the other admin pages. Counts, dates and
 * codes only: no landlord's details and no cell are shown here.
 */
export default async function AdminAdSheets() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const guard = pageGuard(user);
  if (guard === "login") redirect("/login?redirect=/admin/ad-sheets");
  if (guard === "not_found") notFound();

  const data = await loadAdSheetsAdmin();

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <Link href="/admin/ad-packs" className="text-sm text-primary hover:underline">← Ad packs</Link>
      <h1 className="mt-2 text-2xl font-bold text-foreground">Lead form sheets</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        The Google Sheets operators have connected to their Facebook lead forms, and how reading them is going.
        Counts only: no landlord&apos;s details are shown here.
      </p>
      {!data.available ? <p className="mt-3 rounded-md bg-muted p-3 text-sm text-muted-foreground">The database is not connected here, so nothing can be shown.</p> : null}
      {data.readError ? <p className="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{data.readError}</p> : null}
      <AdSheetsPanel view={data.view} />
    </main>
  );
}
