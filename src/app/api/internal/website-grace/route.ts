import { authoriseInternal, internalSecretsConfigured } from "@/lib/internal-auth";
import { runWebsiteGrace } from "@/lib/websites/grace-run";
import { liveGraceDeps } from "@/lib/websites/grace-server";

// ─── Customer website grace period (Batch 36) ──────────────────────────
// Vercel cron (vercel.json: 06:45 UTC daily). Rules: src/lib/websites/grace-rules.ts.
// A live site nobody has logged in to (and no lead has come to) for
// website_abandon_days, whose plan has ended, or whose domain charge is unpaid,
// is warned (website_warning_days, 30/14/3 days before), switched off (status
// paused, the domain stops renewing) and, website_delete_after_days later, has
// its settings, pages, versions, requests and files deleted. In this order:
//   1 cancel episodes no longer due   2 start new ones   3 send the warning due
//   4 switch off what is due          5 delete what is due
// Each warning goes through the one-a-day cap: a used slot means wait for
// tomorrow, except from the day before switch-off on. A login cancels a
// pending switch-off the moment it happens (the screens derive it), the cron
// then records it. Leads, held reports and deliveries are never touched.
//
//   ?dry=1   lists what each site would get; writes nothing, sends nothing,
//            claims no slot (website ids, stages and dates; no addresses)
//
//   curl -H "x-internal-secret: $INTERNAL_API_SECRET" "https://<host>/api/internal/website-grace?dry=1"

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!authoriseInternal(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  let deps;
  try {
    deps = liveGraceDeps();
  } catch {
    return Response.json({ error: "Storage not configured" }, { status: 503 });
  }
  try {
    const result = await runWebsiteGrace(deps, { dry });
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    console.error("[website-grace] run failed:", (err as Error)?.message ?? String(err));
    return Response.json({ error: "Run failed" }, { status: 500 });
  }
}
