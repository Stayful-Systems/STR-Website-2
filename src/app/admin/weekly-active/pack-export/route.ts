import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/admin";
import { metricsExcludedIds } from "@/lib/activity/admin-server";
import { loadPackPaying } from "@/lib/admin/pack-paying-server";
import { countedFacts, packPayingCsv } from "@/lib/admin/pack-paying";

// ─── "Pack → paying" as a spreadsheet (Batch 29, section F) ─────────
// Admin only (same gate as the page). One row per starter pack buyer the
// section counts, with the same ad filter (?packCampaign= / ?packContent=,
// "none" for untagged), so "Download CSV" hands back what is on screen.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdminEmail(user.email)) return Response.json({ error: "Not found" }, { status: 404 });

  const sp = new URL(request.url).searchParams;
  const filter = { campaign: sp.get("packCampaign") || null, content: sp.get("packContent") || null };
  const load = await loadPackPaying();
  if (!load.ok) return Response.json({ error: load.error }, { status: 503 });
  const excluded = await metricsExcludedIds(load.facts.map((f) => f.u));
  const now = new Date();
  const rows = countedFacts(load.facts, excluded, filter);
  const suffix = [filter.campaign, filter.content].filter(Boolean).join("-").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);

  return new Response(packPayingCsv(rows, now), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="pack-to-paying-${now.toISOString().slice(0, 10)}${suffix ? `-${suffix}` : ""}.csv"`,
      "cache-control": "no-store",
    },
  });
}
