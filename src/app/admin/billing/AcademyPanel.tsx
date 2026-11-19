import { createAdminClient } from "@/lib/supabase/admin";
import { formatGbp } from "@/lib/credit/pricing";
import { ACADEMY_FACTS } from "@/lib/academy/rules";
import { AcademyPanelClient, type AcademyRow } from "./AcademyPanelClient";

/**
 * Batch 31a, Phase 6: Academy purchases on /admin/billing — every purchase (newest first), who it is linked to,
 * the trial's state from the database (no Stripe call per row), flags; Link / Unlink / reminders cron with a dry run
 * first (AcademyPanelClient + academy-actions.ts).
 */

const LIMIT = 200;
const ID_CHUNK = 150;
const DAY_MS = 86_400_000;

const FLAGS: Record<string, string> = {
  repeat_purchase: "repeat purchase",
  live_plan: "live plan",
  team_member: "team member",
  email_mismatch: "email mismatch",
  unconfirmed_email: "unconfirmed email",
  no_card: "no card",
  no_consent: "no consent",
  refunded: "refunded",
};

interface PurchaseRow {
  id: string;
  email: string;
  amount_pence: number | null;
  paid_at: string | null;
  created_at: string;
  user_id: string | null;
  linked_by: string | null;
  trial_subscription_id: string | null;
  trial_ends_at: string | null;
  trial_cancelled_at: string | null;
  refunded_at: string | null;
  reminder_sent_at: string | null;
  flag_reason: string | null;
}

function day(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
}

/** The table rows, dates as display strings (no hydration differences). */
function toRows(rows: PurchaseRow[], linkedEmails: Map<string, string>): AcademyRow[] {
  const now = Date.now();
  return rows.map((r) => {
    const paid = r.paid_at ?? r.created_at;
    const trialLive = Boolean(r.trial_subscription_id && (!r.trial_ends_at || new Date(r.trial_ends_at).getTime() > now));
    let status: string;
    if (r.refunded_at) status = "refunded";
    else if (r.trial_cancelled_at) status = "cancelled";
    else if (r.trial_subscription_id && trialLive) status = `trialing until ${day(r.trial_ends_at)}`;
    else if (r.trial_subscription_id) status = `trial ended ${day(r.trial_ends_at)}`;
    else status = "not linked";
    const flags: string[] = [];
    const unlinked = !r.user_id && !r.trial_subscription_id;
    if (unlinked && !r.refunded_at && now - new Date(paid).getTime() > ACADEMY_FACTS.chaseUnlinkedDays * DAY_MS) flags.push("chase");
    if (r.flag_reason) flags.push(FLAGS[r.flag_reason] ?? r.flag_reason);
    if (r.refunded_at && r.flag_reason !== "refunded") flags.push("refunded");
    return {
      id: r.id,
      email: r.email,
      amount: r.amount_pence === null ? "—" : formatGbp(r.amount_pence),
      paid: day(paid),
      linkedTo: r.user_id ? (linkedEmails.get(r.user_id) ?? r.user_id) : null,
      linkedBy: r.linked_by,
      status,
      trialEnd: day(r.trial_ends_at),
      reminderSent: day(r.reminder_sent_at),
      flags,
      canLink: !r.trial_subscription_id && !r.refunded_at,
      canUnlink: trialLive && !r.refunded_at && !r.trial_cancelled_at,
    };
  });
}

export async function AcademyPanel() {
  let rows: PurchaseRow[] = [];
  let problem: string | null = null;
  const linkedEmails = new Map<string, string>();
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("academy_purchases")
      .select("id, email, amount_pence, paid_at, created_at, user_id, linked_by, trial_subscription_id, trial_ends_at, trial_cancelled_at, refunded_at, reminder_sent_at, flag_reason")
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw new Error(`academy_purchases unreadable (schema.sql not run?): ${error.message}`);
    rows = (data ?? []) as PurchaseRow[];
    const ids = [...new Set(rows.map((r) => r.user_id).filter((x): x is string => Boolean(x)))];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data: profiles, error: pErr } = await admin.from("profiles").select("id, email").in("id", ids.slice(i, i + ID_CHUNK));
      if (pErr) throw new Error(`profiles unreadable: ${pErr.message}`);
      for (const p of (profiles ?? []) as { id: string; email: string | null }[]) linkedEmails.set(p.id, p.email ?? p.id);
    }
  } catch (err) {
    problem = (err as Error)?.message ?? String(err);
    console.error("[admin/billing] academy purchases:", problem);
  }

  const out = toRows(rows, linkedEmails);

  return (
    <section className="mt-8 rounded-xl border border-border bg-card p-4">
      <h2 className="text-lg font-semibold text-foreground">Academy purchases</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Newest first (up to {LIMIT}). Trial state is from the database; Unlink checks Stripe for a paid invoice itself. &ldquo;chase&rdquo;: still unlinked {ACADEMY_FACTS.chaseUnlinkedDays} days after paying.
      </p>
      {problem ? <p className="mt-3 text-sm text-destructive">{problem}</p> : <AcademyPanelClient rows={out} />}
    </section>
  );
}
