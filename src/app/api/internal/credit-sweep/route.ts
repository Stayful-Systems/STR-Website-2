import { createAdminClient } from "@/lib/supabase/admin";
import { authoriseInternal, internalSecretsConfigured } from "@/lib/internal-auth";
import { expireDueGrants, idlePlanReport, previewDueGrants } from "@/lib/credit/ledger";
import { idlePlanLogLine, idlePlanSweepReport } from "@/lib/admin/rollover-measure";
import { syncUnitCosts } from "@/lib/credit/unit-costs";
import { academyTrialSlotDue, ensureAnnualMonthlyGrant, ensureAcademyTrialMonthlyGrant, type AcademyTrialPurchase } from "@/lib/stripe/grants";

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
//
// Batch 31a: it also grants Stayful Academy trials their monthly Pro credit
// (months 2 and 3; the webhook grants month 1), keyed `trial:<sub>:<YYYY-MM>`.
// The dry run lists the trial months it would grant (academyTrialDue).
//
// Batch 32a: both the dry and the live run report idlePlanCandidates, the
// members credit_idle_plan_report finds with plan credit and no spend for
// plan_credit_idle_months (user id, dates and pence; no emails). Report only:
// nothing expires because of it until 32b. If the SQL function is not there
// yet (schema.sql not run), it is null with idlePlanError and the rest of the
// sweep runs as before.

type AcademyTrialRow = AcademyTrialPurchase & { id: string };

/** Academy purchases whose trial is still running (linked, not refunded, not ended). */
async function liveAcademyTrials(admin: ReturnType<typeof createAdminClient>): Promise<AcademyTrialRow[]> {
  const { data, error } = await admin
    .from("academy_purchases")
    .select("id, user_id, trial_subscription_id, trial_started_at, trial_ends_at, refunded_at")
    .not("trial_subscription_id", "is", null)
    .is("refunded_at", null)
    .gt("trial_ends_at", new Date().toISOString());
  if (error) throw new Error(error.message);
  return (data ?? []) as AcademyTrialRow[];
}

/** What the academy loop would grant now: the due month of each trial not yet granted (the profile check is the grant's own). */
async function academyTrialDue(admin: ReturnType<typeof createAdminClient>): Promise<Array<{ purchaseId: string; userId: string; sourceRef: string }>> {
  const out: Array<{ purchaseId: string; userId: string; sourceRef: string }> = [];
  for (const row of await liveAcademyTrials(admin)) {
    const due = academyTrialSlotDue(row);
    if (!due) continue;
    const { data: profile } = await admin.from("profiles").select("stripe_subscription_id, stripe_subscription_status").eq("id", due.userId).maybeSingle();
    if (!profile || profile.stripe_subscription_id !== due.subscriptionId || profile.stripe_subscription_status !== "trialing") continue;
    const { data: existing } = await admin.from("credit_grants").select("id").eq("source_ref", due.sourceRef).maybeSingle();
    if (existing) continue;
    out.push({ purchaseId: row.id, userId: due.userId, sourceRef: due.sourceRef });
  }
  return out;
}

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
      let academy: Awaited<ReturnType<typeof academyTrialDue>> | { error: string };
      try {
        academy = await academyTrialDue(admin);
      } catch (err) {
        academy = { error: (err as Error).message };
      }
      const idle = await idlePlanSweepReport(() => idlePlanReport());
      console.log(idlePlanLogLine(idle, true));
      return Response.json({ dry: true, wouldExpire: due.expire, wouldLift: due.lift, annual: "not run on a dry run", seed: "not run on a dry run", academyTrialDue: academy, ...idle });
    } catch (err) {
      return Response.json({ dry: true, error: (err as Error).message }, { status: 500 });
    }
  }
  const summary = { expired: 0, annualGranted: 0, academyTrialGranted: 0, seeded: 0, errors: [] as string[] };

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

  // Batch 31a: Stayful Academy trials, one month of Pro credit at a time.
  try {
    for (const row of await liveAcademyTrials(admin)) {
      try {
        if (await ensureAcademyTrialMonthlyGrant(row)) summary.academyTrialGranted += 1;
      } catch (err) {
        summary.errors.push(`academy ${row.id}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    summary.errors.push(`academy: ${(err as Error).message}`);
  }

  try {
    summary.seeded = await syncUnitCosts();
  } catch (err) {
    summary.errors.push(`seed: ${(err as Error).message}`);
  }

  // Batch 32a: report only. Nothing below expires anything.
  const idle = await idlePlanSweepReport(() => idlePlanReport());
  console.log(idlePlanLogLine(idle, false));

  return Response.json({ ...summary, ...idle });
}
