/**
 * Batch 31: what a landlord sees after step 2 of a website's form, and what
 * the report API returns: a few headline figures, labelled as an estimate,
 * never the report itself and never an address.
 *
 * The figures are the ones the funnel and PDF lead with: the short-let gross
 * income for the year (shortLet.annualRevenue), the same per month, the
 * occupancy and the nightly rate. They are copied one by one from an allow
 * list of fields, so nothing else on the AnalysisResult (address, postcode,
 * town, comparables, listing links) can reach the output.
 *
 * When the report's quality is not OK (policy.qualityOk: complete AND
 * trustworthy) the summary carries the caveat "early estimate, limited local
 * data" and no other time.
 *
 * Pure: no network, no database, no server-only.
 */
import type { AnalysisResult } from '../types.ts';

export const SUMMARY_LABEL = 'Estimate';
export const EARLY_ESTIMATE_CAVEAT = 'early estimate, limited local data';

/** The headline figures. Whole numbers: annual and monthly to the nearest £10, rate to the nearest £1, occupancy a whole percent. */
export interface SummaryFigures {
  /** Estimated gross income for a year, GBP. */
  annualIncome: number;
  /** annualIncome / 12, GBP. */
  monthlyIncome: number;
  /** Estimated occupancy, 0-100. */
  occupancyPct: number;
  /** Estimated average nightly rate, GBP. */
  nightlyRate: number;
  bedrooms: number;
}

/** What the report API returns for a finished report with figures. Serialisable; carries no address. */
export interface ReportSummary {
  kind: 'estimate';
  /** Always "Estimate": the figures are never presented as a promise. */
  label: typeof SUMMARY_LABEL;
  /** Every figure's label says estimated and gross. */
  figureLabels: Record<keyof SummaryFigures, string>;
  figures: SummaryFigures;
  /** True when quality is not OK. */
  early: boolean;
  /** EARLY_ESTIMATE_CAVEAT when early, otherwise null. */
  caveat: string | null;
}

export const FIGURE_LABELS: Record<keyof SummaryFigures, string> = {
  annualIncome: 'Estimated gross income per year',
  monthlyIncome: 'Estimated gross income per month',
  occupancyPct: 'Estimated occupancy',
  nightlyRate: 'Estimated nightly rate',
  bedrooms: 'Bedrooms',
};

const round = (n: number, to: number) => Math.round(n / to) * to;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The summary for a finished report, or null when it has no figures (a failed
 * lookup stores zero revenue: that is "will be in touch", not a £0 estimate).
 * `qualityOk` is policy.qualityOk(...) for the same report.
 */
export function buildSummary(result: Pick<AnalysisResult, 'shortLet'> & { property?: Pick<AnalysisResult['property'], 'bedrooms'> }, qualityOk: boolean): ReportSummary | null {
  const sl = result?.shortLet;
  const annual = num(sl?.annualRevenue);
  if (annual === null || annual <= 0) return null;

  const occ = num(sl?.occupancyRate);
  const adr = num(sl?.averageDailyRate);
  const beds = num(result.property?.bedrooms);
  const early = qualityOk !== true;

  return {
    kind: 'estimate',
    label: SUMMARY_LABEL,
    figureLabels: { ...FIGURE_LABELS },
    figures: {
      annualIncome: round(annual, 10),
      monthlyIncome: round(annual / 12, 10),
      // The analyser stores occupancy as 0-1.
      occupancyPct: occ === null ? 0 : Math.max(0, Math.min(100, Math.round(occ * 100))),
      nightlyRate: adr === null ? 0 : Math.max(0, Math.round(adr)),
      bedrooms: beds === null ? 0 : Math.max(0, Math.round(beds)),
    },
    early,
    caveat: early ? EARLY_ESTIMATE_CAVEAT : null,
  };
}

const gbp = (n: number) => `£${n.toLocaleString('en-GB')}`;

/** The summary as plain lines for an email or a screen reader: label first, caveat last. No address. */
export function summaryLines(s: ReportSummary): string[] {
  const f = s.figures;
  const lines = [
    `${FIGURE_LABELS.annualIncome}: ${gbp(f.annualIncome)}`,
    `${FIGURE_LABELS.monthlyIncome}: ${gbp(f.monthlyIncome)}`,
    `${FIGURE_LABELS.occupancyPct}: ${f.occupancyPct}%`,
    `${FIGURE_LABELS.nightlyRate}: ${gbp(f.nightlyRate)}`,
  ];
  if (s.caveat) lines.push(`Note: ${s.caveat}`);
  return lines;
}
