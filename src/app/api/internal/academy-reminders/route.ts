import { runAcademyReminders } from "@/lib/academy/reminders-run";
import { authoriseInternal, internalSecretsConfigured } from "@/lib/internal-auth";

// ─── Academy reminders (Batch 31a) ─────────────────────────────────────
// Vercel cron (vercel.json: 06:47 UTC, before the picks passes from 07:00,
// so the reminder takes the member's capped email of the day). Links
// unlinked Academy purchases whose email now belongs to a confirmed account,
// then sends the "free months end on…" reminder 7 days before the first
// charge (waits a day while the slot is taken; 5 days before, sends anyway).
//
//   ?dry=1   who would be linked, who would get the reminder today (with the
//            full email), who waits; sends, claims and writes nothing
//
//   curl -H "x-internal-secret: $INTERNAL_API_SECRET" "https://<host>/api/internal/academy-reminders?dry=1"

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!authoriseInternal(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  const result = await runAcademyReminders({ dry });
  return Response.json(result.body, { status: result.status });
}
