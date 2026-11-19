import type { AnalysisResult } from "@/lib/types";
import { btlSheet } from "@/lib/btl/sheet";
import { DEFAULT_BTL_SETTINGS } from "@/lib/btl/config";

/**
 * Batch 28, Part H: the Full analysis's "Buy to let instead?". The same
 * buy-to-let maths as a buy-to-let deal, on this report's own long-let
 * valuation (already bought: no extra charge). It does not repeat the
 * short-let vs long-let comparison above it: this is the home let to
 * long-term tenants on a buy-to-let mortgage, every figure a range.
 *
 * Review R4 (R4-24): the figures are worked out on the server when the
 * report is built (src/lib/analysis/run.ts, with the stored settings and a
 * flat's service charge) and carried on the result; this only shows them.
 * A report from before that has none, and the section is not shown.
 */
export function BuyToLetInstead({ result }: { result: AnalysisResult }) {
  const card = result.btlInstead ?? null;
  if (!card) return null;
  // The rent test's cover, as the card was worked out with it (the stored setting), for its label.
  const t = card.rentTest;
  const icrPct = card.loan > 0 && t.stressRatePct > 0 ? Math.round((t.requiredRent * 12 * 100 * 100) / (card.loan * t.stressRatePct)) : DEFAULT_BTL_SETTINGS.finance.icrPct;
  const sheet = btlSheet(card, { priority: "both", benchmark: null, settings: { finance: { ...DEFAULT_BTL_SETTINGS.finance, icrPct }, costs: DEFAULT_BTL_SETTINGS.costs } });
  const keep = new Set(["Rent a month", "Cashflow a month", "Cash in", "ROI", "Gross yield", "Value in 5 years"]);
  const ltvPct = card.price > 0 ? Math.round((card.loan / card.price) * 100) : null;
  return (
    <section aria-labelledby="buy-to-let-instead" className="mt-6 rounded-xl border border-border bg-card p-5">
      <h3 id="buy-to-let-instead" className="text-base font-semibold text-foreground">Buy to let instead?</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">Let to long-term tenants on {ltvPct !== null ? `a ${ltvPct}%` : "an"} interest-only buy-to-let mortgage, from this report’s own long-let valuation. Included in this analysis.</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {sheet.rows
          .filter((row) => keep.has(row.label))
          .map((row) => (
            <div key={row.label} className="min-w-0">
              <dd className="text-sm font-bold text-foreground">{row.value}</dd>
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              {row.sub && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{row.sub}</p>}
            </div>
          ))}
      </dl>
      <p className={"mt-3 text-xs font-medium " + (sheet.rentTest.pass ? "text-foreground" : "text-destructive")}>{sheet.rentTest.text}</p>
      {sheet.rentTest.tight && <p className="text-xs text-foreground">{sheet.rentTest.tight}</p>}
      <p className="mt-0.5 text-[11px] text-muted-foreground">{sheet.rate}</p>
      {sheet.epc && <p className="mt-2 text-xs font-medium text-warning">{sheet.epc}</p>}
      <p className="mt-2 text-xs text-muted-foreground">{sheet.rules}</p>
      <p className="mt-2 text-xs font-medium text-foreground">{sheet.disclaimer}</p>
    </section>
  );
}
