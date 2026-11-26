import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { readDealFeedSettings } from "@/lib/marketplace/deal-feed-settings-server";
import { hiddenDuplicateCount } from "@/lib/marketplace/dedupe-server";
import { loadSalesRows } from "@/lib/marketplace/weekly-sales-server";
import { reportsThisMonth, salesTotals, weeklySales } from "@/lib/marketplace/weekly-sales";
import { grantStaleCreditAction, saveDealFeedSettingsAction } from "./actions";

const gbp = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const input = "rounded-md border border-border bg-card px-2.5 py-1.5 text-sm";

/**
 * Deal feed (queue Batch 1): the stale-deal credit, duplicate hiding and the weekly count of
 * opens and full reports by category. Counts and ids only: never an address or a listing.
 */
export async function DealFeedPanel() {
  const admin = createAdminClient();
  const now = new Date();
  const [settings, hidden, rows, credited] = await Promise.all([
    readDealFeedSettings(),
    hiddenDuplicateCount(admin),
    loadSalesRows(admin, now),
    admin.from("deal_opens").select("stale_credit_pence").not("stale_credit_at", "is", null).gt("stale_credit_pence", 0).gte("stale_credit_at", new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString()).limit(5000),
  ]);
  const weeks = rows ? weeklySales(rows, now) : null;
  const totals = weeks ? salesTotals(weeks) : null;
  const month = rows ? reportsThisMonth(rows, now) : null;
  const creditedRows = credited.error ? null : ((credited.data ?? []) as { stale_credit_pence: number | string }[]);
  const creditedPence = creditedRows?.reduce((sum, r) => sum + Number(r.stale_credit_pence), 0) ?? 0;

  return (
    <section className="mt-8 rounded-xl border border-border bg-card p-5">
      <h2 className="text-base font-semibold text-foreground">Deal feed</h2>

      <h3 className="mt-3 text-sm font-semibold text-foreground">What sold, by week</h3>
      {weeks && totals && month ? (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            Opens and full reports over the last 8 UK weeks (Monday to Sunday), by the kind of deal. Reports in {month.monthLabel}: <strong className="text-foreground">{month.count}</strong> against a target of {month.target} ({Math.round((month.count / month.target) * 100)}%).
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1">Week of</th>
                  <th>Rent-to-rent opens</th>
                  <th>Rent-to-rent reports</th>
                  <th>Buy-to-let opens</th>
                  <th>Buy-to-let reports</th>
                </tr>
              </thead>
              <tbody>
                {[...weeks].reverse().map((w) => (
                  <tr key={w.weekStart} className="border-t border-border">
                    <td className="py-1">{w.label}</td>
                    <td>{w.rent.opens}</td>
                    <td>{w.rent.reports}</td>
                    <td>{w.sale.opens}</td>
                    <td>{w.sale.reports}</td>
                  </tr>
                ))}
                <tr className="border-t border-border font-semibold">
                  <td className="py-1">8 weeks</td>
                  <td>{totals.rent.opens}</td>
                  <td>{totals.rent.reports}</td>
                  <td>{totals.sale.opens}</td>
                  <td>{totals.sale.reports}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">The weekly counts could not be read just now.</p>
      )}

      <h3 className="mt-5 text-sm font-semibold text-foreground">Duplicates and the stale-deal credit</h3>
      <p className="mt-1 text-sm text-foreground">
        Hidden as duplicates: <strong>{hidden ?? "—"}</strong>
        <span className="text-xs text-muted-foreground"> {hidden === null ? "(run the Deal feed block of schema.sql first)" : settings.dedupeEnabled ? "· hidden from the grid now" : "· would be hidden once the switch below is on; check this before turning it on"}</span>
      </p>
      <p className="mt-1 text-sm text-foreground">
        Credited back in the last 30 days: <strong>{creditedRows ? `${creditedRows.length} open${creditedRows.length === 1 ? "" : "s"}, ${gbp(creditedPence)}` : "—"}</strong>
        <span className="text-xs text-muted-foreground"> {settings.staleCreditEnabled ? "· the hourly job is on" : "· the hourly job is off"}</span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Before turning the credit on, read the dry run: <code>/api/internal/deal-stale-credits?dry=1</code> (it lists open ids and pence, and grants nothing).
      </p>

      <form action={saveDealFeedSettingsAction} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="stale_enabled" defaultChecked={settings.staleCreditEnabled} /> Credit back a deal that goes
        </label>
        <label className="text-xs text-muted-foreground">
          <span className="block">within (days)</span>
          <input name="stale_days" type="number" min={1} max={90} step={1} defaultValue={settings.staleCreditDays} className={`${input} w-20`} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="dedupe_enabled" defaultChecked={settings.dedupeEnabled} /> Hide duplicates
        </label>
        <label className="text-xs text-muted-foreground">
          <span className="block">price within (%)</span>
          <input name="dedupe_pct" type="number" min={0} max={20} step="0.5" defaultValue={settings.dedupePricePct} className={`${input} w-20`} />
        </label>
        <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90">Save</button>
      </form>

      <form action={grantStaleCreditAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3">
        <label className="text-xs text-muted-foreground">
          <span className="block">Grant stale credit for an open (its id, ignoring the time window)</span>
          <input name="open_id" required placeholder="open id" className={`${input} w-80 font-mono text-xs`} />
        </label>
        <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted">Grant stale credit</button>
        <span className="text-xs text-muted-foreground">Once only per open. Nothing is credited when nothing was spent. See <Link href="/admin/billing" className="text-primary hover:underline">billing</Link> for the member&rsquo;s balance.</span>
      </form>
    </section>
  );
}
