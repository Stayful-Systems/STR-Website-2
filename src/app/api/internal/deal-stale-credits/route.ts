import { createAdminClient } from "@/lib/supabase/admin";
import { runStaleCredits } from "@/lib/marketplace/stale-credit-server";
import { authoriseInternal, internalSecretsConfigured } from "@/lib/internal-auth";

// ─── Deal feed: the stale-deal credit ─────────────────────────────────
// Vercel cron (vercel.json: hourly, minute 17). A member who opened a deal that went off the market
// within deal_stale_credit_days (7) of the open gets back what they actually spent on it (the open, and
// the full report if they bought one). Once only per open: the credit's source_ref is 'stale:<open id>'.
// Does nothing while deal_stale_credit_enabled is off (it is seeded off).
//
//   ?dry=1   lists the opens that would be credited, with the pence, and grants nothing. It lists even
//            while the switch is off, so it can be read before the switch is turned on.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/internal/deal-stale-credits?dry=1"
//
// The answer carries open ids and pence only, never an address.

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!authoriseInternal(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  const summary = await runStaleCredits(createAdminClient(), { dry });
  return Response.json(summary);
}
