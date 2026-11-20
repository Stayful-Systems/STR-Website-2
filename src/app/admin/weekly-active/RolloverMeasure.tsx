import { loadRolloverMeasure } from "@/lib/admin/rollover-measure-server";
import { SMALL_NUMBERS, type ActiveShare, type PeriodRate } from "@/lib/admin/rollover-measure";

/**
 * Batch 32, Phase 7: "Plan credit rollover", the success measure. Did plan
 * cancellations fall after unused plan credit started rolling over, without
 * plan members using the app less? The maths is
 * src/lib/admin/rollover-measure.ts; counts and pence only, nobody is named.
 * The page's admin gate covers it (page.tsx).
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

function Tile({ title, value, line }: { title: string; value: string; line: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{line}</div>
    </div>
  );
}
