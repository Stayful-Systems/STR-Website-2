import { metricsExcludedIds } from "@/lib/activity/admin-server";
import { loadPackPaying } from "@/lib/admin/pack-paying-server";
import { packPayingReport, UNTAGGED, WINDOWS, type Cell, type CohortRow, type CostCell, type PackFilter, type Rag } from "@/lib/admin/pack-paying";

/**
 * Batch 29, section F: "Pack → paying". Starter pack buyers by UK sign-up
 * week, how many go on to pay again, and what a buyer who never pays again
 * costs us in data. The maths is src/lib/admin/pack-paying.ts; the accounts
 * the rest of the page leaves out are left out here too. Filter by the ad
 * (utm_campaign / utm_content, "none" for untagged) with ?packCampaign= and
 * ?packContent=; the CSV takes the same filter.
 */
export async function PackToPaying({ filter }: { filter: PackFilter }) {
  const load = await loadPackPaying();
  if (!load.ok) {
    return <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">Couldn&rsquo;t read the starter pack buyers: {load.error}</div>;
  }
  const now = new Date();
  const excluded = await metricsExcludedIds(load.facts.map((f) => f.u));
  const report = packPayingReport(load.facts, { excluded, filter, targets: load.targets, now });
  const t = load.targets;
  const qs = new URLSearchParams();
  if (filter.campaign) qs.set("packCampaign", filter.campaign);
  if (filter.content) qs.set("packContent", filter.content);
  const csvHref = `/admin/weekly-active/pack-export${qs.size > 0 ? `?${qs}` : ""}`;

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Headline title="Paid again within 60 days" rag={report.headlineRag} value={pctText(report.total.paid60)} line={`Green at ${t.headlineTargetPct}%, amber from ${t.headlineFloorPct}%.`} />
        <Headline title="Ran down to £5, then paid within 14 days" rag={report.rundownRag} value={pctText(report.total.paidAfterRun)} line={`Green at ${t.rundownPaidTargetPct}%, amber from ${t.rundownPaidFloorPct}%.`} />
        <Headline title="Data cost per pack-only member" rag={report.costRag} value={report.total.cost.averagePence === null ? "—" : `${money(report.total.cost.averagePence)} average`} line={`Green to ${money(t.costTargetPence)}, amber to ${money(t.costCeilingPence)}.${report.total.cost.soFar ? " So far: some could still pay again." : ""}`} />
      </div>

      {report.smallNumbers && (
        <p className="mt-3 rounded-lg border border-border bg-card p-3 text-sm text-foreground">
          Small numbers ({report.buyers} {report.buyers === 1 ? "buyer" : "buyers"}): treat these as a baseline, not a result.
        </p>
      )}

      <form method="get" action="/admin/weekly-active" className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Campaign (utm_campaign)</span>
          <select name="packCampaign" defaultValue={filter.campaign ?? ""} className="rounded-md border border-border bg-background px-2 py-1">
            <option value="">All</option>
            <option value={UNTAGGED}>none (untagged)</option>
            {report.campaigns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Ad (utm_content)</span>
          <select name="packContent" defaultValue={filter.content ?? ""} className="rounded-md border border-border bg-background px-2 py-1">
            <option value="">All</option>
            <option value={UNTAGGED}>none (untagged)</option>
            {report.contents.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md border border-border px-3 py-1 font-medium text-foreground hover:bg-muted">
          Show
        </button>
        <a href={csvHref} className="ml-auto font-medium text-primary hover:underline">
          Download CSV
        </a>
      </form>

      <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-3 py-2 font-medium">Signed up (week of)</th>
              <th className="px-3 py-2 font-medium">1. Bought the pack</th>
              <th className="px-3 py-2 font-medium">2. Active in first week</th>
              <th className="px-3 py-2 font-medium">3. Contacted within 30 days</th>
              <th className="px-3 py-2 font-medium">4. Down to £5 within 45 days</th>
              <th className="px-3 py-2 font-medium">5. Paid within 14 days of 4</th>
              <th className="px-3 py-2 font-medium">6. Paid again within 60 days</th>
              <th className="px-3 py-2 font-medium">7. Paid a third time</th>
              <th className="px-3 py-2 font-medium">8. Data cost per pack-only member (avg · p90 · max)</th>
            </tr>
          </thead>
          <tbody>
            {report.cohorts.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-4 text-muted-foreground">
                  No starter pack buyers{filter.campaign || filter.content ? " for this ad" : " yet"}.
                </td>
              </tr>
            )}
            {report.cohorts.map((c) => (
              <Row key={c.weekStart} row={c} label={weekLabel(c.weekStart)} />
            ))}
            {report.cohorts.length > 1 && <Row row={report.total} label="All weeks" strong />}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Paying again is a top-up (chosen or automatic) or a plan&rsquo;s paid invoice. Step 5 is a share of step 4; the others are shares of step 1. A column says too early until its window has closed for the week&rsquo;s latest buyer ({WINDOWS.firstWeek} days from sign-up for step 2; {WINDOWS.contacted}, {WINDOWS.ranDown}, {WINDOWS.paidAfterRun} and {WINDOWS.paid60} days from the pack for steps 3 to 7), and All weeks adds up only the weeks whose window has closed. Data cost is the raw cost of every report, look-up and pick charged to a buyer who has not paid again. Admins, staff and accounts switched off below are left out.
      </p>
    </div>
  );
}

const RAG_CLASS: Record<Rag, string> = {
  green: "bg-emerald-600",
  amber: "bg-amber-500",
  red: "bg-red-600",
};
const RAG_WORD: Record<Rag, string> = { green: "On target", amber: "Below target", red: "Below the floor" };

function Headline({ title, rag, value, line }: { title: string; rag: Rag | null; value: string; line: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {rag && <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${RAG_CLASS[rag]}`} />}
        {title}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {rag ? `${RAG_WORD[rag]}. ` : "Too early to judge. "}
        {line}
      </div>
    </div>
  );
}

function Row({ row, label, strong }: { row: CohortRow; label: string; strong?: boolean }) {
  return (
    <tr className={`border-b border-border last:border-0 ${strong ? "font-medium" : ""}`}>
      <td className="px-3 py-2 whitespace-nowrap">{label}</td>
      <td className="px-3 py-2 tabular-nums">{row.bought}</td>
      <ShareCell cell={row.firstWeek} />
      <ShareCell cell={row.contacted} />
      <ShareCell cell={row.ranDown} />
      <ShareCell cell={row.paidAfterRun} />
      <ShareCell cell={row.paid60} />
      <ShareCell cell={row.third} />
      <td className="px-3 py-2 tabular-nums whitespace-nowrap">{costText(row.cost)}</td>
    </tr>
  );
}

function ShareCell({ cell }: { cell: Cell }) {
  if (cell === null) return <td className="px-3 py-2 text-muted-foreground">too early</td>;
  return (
    <td className="px-3 py-2 tabular-nums whitespace-nowrap">
      {cell.count}
      <span className="text-muted-foreground">{cell.pct === null ? "" : ` (${cell.pct}%)`}</span>
    </td>
  );
}

function pctText(cell: Cell): string {
  if (cell === null) return "too early";
  return cell.pct === null ? "—" : `${cell.pct}%`;
}

function costText(c: CostCell): string {
  if (c.members === 0 || c.averagePence === null) return "—";
  return `${money(c.averagePence)} · ${money(c.p90Pence ?? 0)} · ${money(c.maxPence ?? 0)}${c.soFar ? " (so far)" : ""}`;
}

function money(pence: number): string {
  return `£${(Math.max(0, pence) / 100).toFixed(2)}`;
}

function weekLabel(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric" });
}
