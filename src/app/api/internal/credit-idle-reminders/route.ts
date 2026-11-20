import { authoriseInternal, internalSecretsConfigured } from "@/lib/internal-auth";
import { runCreditIdleReminders } from "@/lib/credit/idle-reminders-run";
import { liveIdleRemindersDeps } from "@/lib/credit/idle-reminders-server";

// ─── No-spend credit reminders (Batch 34b) ─────────────────────────────
// Vercel cron (vercel.json: 06:43 UTC, before the Academy reminders at 06:47
// and the picks from 07:00). Members holding plan credit with no spend get a
// reminder at 3 and 6 months (behind the credit alerts switch) and a final
// warning at plan_credit_idle_months (a billing notice). Each goes through
// the one-a-day cap: a used slot means wait for tomorrow. Nothing expires
// here (the 03:00 credit sweep does that, 30+ days after a final warning).
//
//   ?dry=1   wouldSend / waiting / skipped (user id, stage, kind; no emails);
//            writes nothing: no notices, no claims, no sends, no activity
//
//   curl -H "x-internal-secret: $INTERNAL_API_SECRET" "https://<host>/api/internal/credit-idle-reminders?dry=1"

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!authoriseInternal(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  let deps;
  try {
    deps = liveIdleRemindersDeps();
  } catch {
    return Response.json({ error: "Storage not configured" }, { status: 503 });
  }
  try {
    const result = await runCreditIdleReminders(deps, { dry });
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    console.error("[credit-idle-reminders] run failed:", (err as Error)?.message ?? String(err));
    return Response.json({ error: "Run failed" }, { status: 500 });
  }
}
