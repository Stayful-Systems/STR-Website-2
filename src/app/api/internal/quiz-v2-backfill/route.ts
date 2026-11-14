import { runQuizV2Backfill } from "@/lib/profile/quiz-v2-backfill-run";
import { authoriseInternal, internalSecretsConfigured } from "@/lib/internal-auth";

// ─── The shorter quiz: the one-off move of existing profiles (Batch 30) ──────
// Old R2R setup answers move onto the new bands and stay a nice-to-have; a buyer
// with a budget and no Buying cash gets the band it points to (worked out, never
// a filter); a rate the member chose is kept as theirs (src/lib/profile/quiz-v2-backfill.ts).
// Run it straight after the release, before the 07:00 sourcing run and before the
// first rate sync. Idempotent: a second run changes nothing. No provider calls, no
// charges, no activity logged.
//
//   ?dry=1   every profile's before and after (short ids, option keys); writes nothing
//
//   curl -H "x-internal-secret: $INTERNAL_API_SECRET" "https://<host>/api/internal/quiz-v2-backfill?dry=1"

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!authoriseInternal(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  const result = await runQuizV2Backfill({ dry, triggeredBy: "internal" });
  return Response.json(result.body, { status: result.status });
}
