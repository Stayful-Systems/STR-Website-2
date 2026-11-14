import { createAdminClient } from "@/lib/supabase/admin";
import { authoriseInternal, internalSecretsConfigured } from "@/lib/internal-auth";
import { expireDueGrants, previewDueGrants } from "@/lib/credit/ledger";
import { syncUnitCosts } from "@/lib/credit/unit-costs";
import { ensureAnnualMonthlyGrant } from "@/lib/stripe/grants";

// ─── Daily credit sweep ────────────────────────────────────────────────
// Vercel cron (vercel.json, 03:00 UTC). Writes 'expire' rows for plan credit
// past its cycle, grants the next monthly slot to annual subscribers, and
// seeds any unit-cost rows a deploy added. (Its Monday "Lapsed at zero" step
// went in Batch 20: Monday's Billing status is the sales-funnel sync's,
// src/lib/crm/monday-funnel.)
//
//   curl -H "x-internal-secret: $INTERNAL_API_SECRET" "https://<host>/api/internal/credit-sweep"
//
// Batch 29: it also expires a starter pack's bonus left unspent after
// pack_bonus_expiry_days, unless the member paid again by then (then the bonus
// is lifted and never expires). ?dry=1 lists what would expire or be lifted
// and writes nothing (no annual grants, no unit-cost seeding either).

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!authoriseInternal(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return Response.json({ error: "Storage not configured" }, { status: 503 });
  }
  if (new URL(request.url).searchParams.get("dry") === "1") {
    try {
      const due = await previewDueGrants();
      return Response.json({ dry: true, wouldExpire: due.expire, wouldLift: due.lift, annual: "not run on a dry run", seed: "not run on a dry run" });
    } catch (err) {
      return Response.json({ dry: true, error: (err as Error).message }, { status: 500 });
    }
  }
  const summary = { expired: 0, annualGranted: 0, seeded: 0, errors: [] as string[] };

  try {
    summary.expired = await expireDueGrants();
  } catch (err) {
    summary.errors.push(`expire: ${(err as Error).message}`);
  }

  try {
    const { data } = await admin.from("profiles").select("id").eq("plan_code", "pro_annual").not("stripe_subscription_id", "is", null);
    for (const p of data ?? []) {
      try {
        if (await ensureAnnualMonthlyGrant(String(p.id))) summary.annualGranted += 1;
      } catch (err) {
        summary.errors.push(`annual ${p.id}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    summary.errors.push(`annual: ${(err as Error).message}`);
  }

  try {
    summary.seeded = await syncUnitCosts();
  } catch (err) {
    summary.errors.push(`seed: ${(err as Error).message}`);
  }

  return Response.json(summary);
}
