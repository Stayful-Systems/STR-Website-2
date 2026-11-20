import { loadRolloverMeasure } from "@/lib/admin/rollover-measure-server";
import { SMALL_NUMBERS, type ActiveShare, type IdleExpiryListRow, type IdleExpiryLists, type PeriodRate } from "@/lib/admin/rollover-measure";

/**
 * Batch 34, Phase 7: "Plan credit rollover", the success measure. Did plan
 * cancellations fall after unused plan credit started rolling over, without
 * plan members using the app less? The maths is
 * src/lib/admin/rollover-measure.ts; counts and pence only, nobody is named.
 * The page's admin gate covers it (page.tsx).
 *
 * Batch 34b: below it, "Warned" (final no-spend warning sent, still inside
 * the notice window, with the day it becomes due) and "Due to expire" (what
 * the next 03:00 credit sweep expires). These name members by email, as the
 * weekly-active drill-down above does, for the admin only.
 */

const money = (p: number) => `£${(p / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function launchDay(iso: string | null): string {
  if (!iso) return "not launched";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
}

function rateText(r: PeriodRate): string {
  return r.ratePct === null ? "—" : `${r.ratePct}%`;
}

function rateLine(r: PeriodRate): string {
  if (r.months === 0) return "No whole month yet.";
  return `${r.cancelled} cancelled over ${r.months} month${r.months === 1 ? "" : "s"}, about ${r.averageMembers ?? 0} plan members at each month's start.`;
}

function dayTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
}

function shareText(s: ActiveShare): string {
  return s.pct === null ? "—" : `${s.pct}%`;
}

export async function RolloverMeasure() {
  const load = await loadRolloverMeasure();
  return (
    <div className="mx-auto max-w-6xl px-5 pb-10">
      <h2 id="rollover" className="mb-1 text-lg font-semibold text-foreground">
        Plan credit rollover
      </h2>
      {!load.ok ? (
        <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">Couldn&rsquo;t read the rollover measure: {load.error}</div>
      ) : (
        <Body load={load} />
      )}
    </div>
  );
}

function Body({ load }: { load: Extract<Awaited<ReturnType<typeof loadRolloverMeasure>>, { ok: true }> }) {
  const m = load.measure;
  return (
    <>
      <p className="mb-3 max-w-3xl text-sm text-muted-foreground">
        Unused plan credit rolls over from {launchDay(m.launchAt)}. The aim is fewer plan cancellations. Cancellation rate is the churn report&rsquo;s monthly rate (cancellations over plan members at the month&rsquo;s start), averaged; {m.launchMonth ? `the launch month (${m.launchMonth}) has days on both sides, so it is in neither.` : "nothing counts as after until the launch date is set."} Weekly active uses this page&rsquo;s rule, for plan members only.
      </p>

      {m.tooEarly && (
        <p className="mb-3 rounded-lg border border-border bg-card p-3 text-sm text-foreground">
          Too early ({m.planMembers} of {SMALL_NUMBERS} plan members): treat these as a baseline, not a result.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile title="Cancellation rate before" value={rateText(m.cancellation.before)} line={rateLine(m.cancellation.before)} />
        <Tile title="Cancellation rate after" value={rateText(m.cancellation.after)} line={rateLine(m.cancellation.after)} />
        <Tile
          title="Weekly active, plan members"
          value={m.guardrail ? `${shareText(m.guardrail.before)} → ${shareText(m.guardrail.after)}` : "—"}
          line={m.guardrail ? `Before ${m.guardrail.before.active} of ${m.guardrail.before.base} member-weeks; after ${m.guardrail.after.active} of ${m.guardrail.after.base}. A guardrail: it should not fall.` : "Weekly-active facts unreadable."}
        />
        <Tile
          title="Plan credit banked"
          value={m.credit ? money(m.credit.bankedPence) : "—"}
          line={m.credit ? `${money(m.credit.rolledOverPence)} of it rolled over from earlier months, across ${m.credit.holders} member${m.credit.holders === 1 ? "" : "s"}.` : "Plan grants unreadable."}
        />
      </div>

      <IdleLists idle={load.idle} />

      {load.notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {load.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function IdleLists({ idle }: { idle: IdleExpiryLists | null }) {
  if (!idle) return null;
  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      <IdleTable
        title={`Due to expire (${idle.due.length})`}
        blurb={`Final warning sent long enough ago and still no spend: the next 03:00 sweep expires ${money(idle.duePence)} of plan credit from earlier months. The newest month is never touched.`}
        rows={idle.due}
        empty="Nobody is due."
      />
      <IdleTable
        title={`Warned (${idle.warned.length})`}
        blurb={`Final warning sent, still inside the notice window. Any spend before the due time cancels it. ${money(idle.warnedPence)} would expire if all of them stay idle.`}
        rows={idle.warned}
        empty="Nobody is inside the notice window."
      />
    </div>
  );
}

function IdleTable({ title, blurb, rows, empty }: { title: string; blurb: string; rows: IdleExpiryListRow[]; empty: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <p className="mt-1 text-xs text-muted-foreground">{blurb}</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Member</th>
                <th className="py-1 pr-3 font-medium">Warned</th>
                <th className="py-1 pr-3 font-medium">Due from</th>
                <th className="py-1 text-right font-medium">Expires</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className="border-t border-border">
                  <td className="py-1 pr-3 text-foreground">{r.email ?? r.userId.slice(0, 8)}</td>
                  <td className="py-1 pr-3 tabular-nums text-muted-foreground">{dayTime(r.noticeSentAt)}</td>
                  <td className="py-1 pr-3 tabular-nums text-muted-foreground">{dayTime(r.dueAt)}</td>
                  <td className="py-1 text-right tabular-nums text-foreground">{money(r.expiringPence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Tile({ title, value, line }: { title: string; value: string; line: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{line}</div>
    </div>
  );
}
