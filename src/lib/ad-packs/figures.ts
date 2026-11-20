/**
 * Batch 38: the one labelled example figure an ad may carry.
 *
 * Pure: no network, no database, no server-only. It takes one bedroom group of
 * an area's market snapshot (a structural copy of MarketBedroomAgg, so this
 * file imports nothing) and turns it into a figure an ad can quote.
 *
 * Units. MarketBedroomAgg (src/lib/market/types.ts, built by aggregate.ts and
 * read by verdict.ts and yield.ts) holds avg_gross_revenue and avg_net_revenue
 * PER YEAR in GBP, and avg_occupancy as a percentage 0 to 100. An ad quotes a
 * landlord a figure PER MONTH, so this divides the yearly values by 12.
 *
 * Rounding. Every £ figure is rounded to the nearest £50 and shown as "about".
 * £10 would read as more precise than an area average is; £50 keeps it honest.
 *
 * Rules (ANGLES.md): one labelled example per ad, never a range, never "you
 * will earn". Every sentence that contains a £ figure also contains the label,
 * so the label can never be separated from the number. FIGURE_LABEL_RE finds it.
 *
 * Take-home. The net figure from the snapshot may or may not already have a
 * management fee taken out; the caller says which (netIncludesFee):
 *   net includes a fee      take-home = net
 *   net excludes the fee    take-home = net minus the operator's fee on the
 *                           gross (only when the operator set a fee), else null
 * With no take-home the example quotes the net ("after costs"), and with no net
 * it quotes the gross ("before costs"). It never claims more than it has.
 */

/** The structural part of MarketBedroomAgg this file reads. */
export interface FigureAgg {
  bedrooms: number;
  sample_count: number;
  avg_gross_revenue: number | null;
  avg_net_revenue: number | null;
  avg_occupancy: number | null;
}

export interface FigureInput {
  /** The area as the website shows it (free text). */
  area_label: string;
  agg: FigureAgg;
  /** The operator's management fee percent, or null when not set. */
  feePct: number | null;
  /** True when agg.avg_net_revenue already has a management fee taken out. */
  netIncludesFee: boolean;
  /** Fewest reports behind a figure (setting ad_pack_min_area_samples, default 5). */
  minSamples?: number;
}

export type FigureBasis = 'take-home' | 'net' | 'gross';

export interface Figure {
  /** "Example: a typical 3-bed in Cambridge, from 14 reports. Every property is different." */
  label: string;
  /** Per month, rounded to £50. */
  gross: number | null;
  net: number | null;
  takeHome: number | null;
  /** Whole percent 0 to 100, or null. */
  occupancyPct: number | null;
  /** The label plus the figure line: the one sentence an ad drops in. Always contains the label. */
  sentence: string;
  /** The same thing written to be spoken (no £, numbers in words). */
  spoken: string;
  bedrooms: number;
  sampleCount: number;
  areaLabel: string;
  /** Which number the sentence quotes. */
  basis: FigureBasis;
  /** The quoted number per month, rounded, and as text ("£2,350 a month"). */
  amount: number;
  amountText: string;
}

export type FigureReason = 'no_area' | 'too_few_samples' | 'no_revenue_data' | 'figure_not_positive';

export const DEFAULT_MIN_SAMPLES = 5;
export const ROUND_TO = 50;

/** Matches the label inside any text. Phase 4's checker uses it. */
export const FIGURE_LABEL_RE = /Example: a typical \d+-bed in .+?, from \d+ reports?\. Every property is different\./;

/** Any £ amount. */
export const POUND_RE = /£\s?\d/;

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function cleanArea(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Nearest £50 of a yearly figure, as a monthly one. */
export function monthlyRounded(yearly: number): number {
  return Math.round(yearly / 12 / ROUND_TO) * ROUND_TO;
}

/** 2350 -> "£2,350". */
export function formatPounds(n: number): string {
  return `£${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${ONES[h]} hundred`);
  if (r > 0) {
    const tail = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? `-${ONES[r % 10]}` : ''}`;
    parts.push(h > 0 ? `and ${tail}` : tail);
  }
  return parts.join(' ');
}

/** A whole number from 0 to 999,999 in words ("two thousand, three hundred and fifty"). Larger or invalid: digits. */
export function numberInWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n);
  if (n < 1000) return n === 0 ? 'zero' : below1000(n);
  const t = Math.floor(n / 1000);
  const r = n % 1000;
  const head = `${below1000(t)} thousand`;
  if (r === 0) return head;
  return `${head}${r < 100 ? ' and' : ','} ${below1000(r)}`;
}

/** A percentage as spoken: 12 -> "twelve percent", 12.5 -> "twelve point five percent". */
export function percentInWords(pct: number): string {
  if (!Number.isFinite(pct) || pct < 0) return String(pct);
  const whole = Math.floor(pct);
  const frac = Math.round((pct - whole) * 10);
  const w = whole <= 999_999 ? numberInWords(whole) : String(whole);
  return frac > 0 ? `${w} point ${ONES[frac]} percent` : `${w} percent`;
}

/** The label text (also used on its own by the image cards). */
export function figureLabel(bedrooms: number, areaLabel: string, sampleCount: number): string {
  return `Example: a typical ${bedrooms}-bed in ${cleanArea(areaLabel)}, from ${sampleCount} ${sampleCount === 1 ? 'report' : 'reports'}. Every property is different.`;
}

/** Why no figure can be built, or null when one can. */
export function figureUnavailableReason(input: FigureInput): FigureReason | null {
  const area = cleanArea(input.area_label);
  if (!area) return 'no_area';
  const min = finite(input.minSamples) && input.minSamples > 0 ? input.minSamples : DEFAULT_MIN_SAMPLES;
  const agg = input.agg;
  if (!agg || !finite(agg.sample_count) || agg.sample_count < min) return 'too_few_samples';
  if (!finite(agg.bedrooms) || agg.bedrooms < 1) return 'no_revenue_data';
  const gross = finite(agg.avg_gross_revenue) && agg.avg_gross_revenue > 0 ? monthlyRounded(agg.avg_gross_revenue) : null;
  const net = finite(agg.avg_net_revenue) && agg.avg_net_revenue > 0 ? monthlyRounded(agg.avg_net_revenue) : null;
  if (gross === null && net === null) return 'no_revenue_data';
  const quoted = quotedOf(input, gross, net);
  if (quoted === null || quoted.amount <= 0) return 'figure_not_positive';
  return null;
}

function takeHomeOf(input: FigureInput): number | null {
  const agg = input.agg;
  const net = finite(agg.avg_net_revenue) && agg.avg_net_revenue > 0 ? agg.avg_net_revenue : null;
  if (net === null) return null;
  if (input.netIncludesFee) return monthlyRounded(net);
  const fee = input.feePct;
  if (!finite(fee) || fee <= 0) return null;
  const gross = finite(agg.avg_gross_revenue) && agg.avg_gross_revenue > 0 ? agg.avg_gross_revenue : null;
  if (gross === null) return null;
  const after = net - (gross * fee) / 100;
  return after > 0 ? monthlyRounded(after) : 0;
}

function quotedOf(input: FigureInput, gross: number | null, net: number | null): { basis: FigureBasis; amount: number; takeHome: number | null } | null {
  const takeHome = takeHomeOf(input);
  if (takeHome !== null) return { basis: 'take-home', amount: takeHome, takeHome };
  if (net !== null) return { basis: 'net', amount: net, takeHome: null };
  if (gross !== null) return { basis: 'gross', amount: gross, takeHome: null };
  return null;
}

/**
 * The example figure for one bedroom group, or null (see figureUnavailableReason
 * for why). Never a range: one number, rounded, with the label in the same text.
 */
export function buildFigure(input: FigureInput): Figure | null {
  if (figureUnavailableReason(input) !== null) return null;
  const agg = input.agg;
  const area = cleanArea(input.area_label);
  const gross = finite(agg.avg_gross_revenue) && agg.avg_gross_revenue > 0 ? monthlyRounded(agg.avg_gross_revenue) : null;
  const net = finite(agg.avg_net_revenue) && agg.avg_net_revenue > 0 ? monthlyRounded(agg.avg_net_revenue) : null;
  const q = quotedOf(input, gross, net);
  if (!q) return null;

  const label = figureLabel(agg.bedrooms, area, agg.sample_count);
  const amountText = `${formatPounds(q.amount)} a month`;
  const line =
    q.basis === 'take-home'
      ? `Take-home: about ${amountText} after costs and fees.`
      : q.basis === 'net'
        ? `After costs: about ${amountText}.`
        : `Bookings: about ${amountText}, before costs.`;

  const bedWord = agg.bedrooms <= 10 ? numberInWords(agg.bedrooms) : String(agg.bedrooms);
  const spokenAmount = `${numberInWords(q.amount)} pounds a month`;
  const spokenLine =
    q.basis === 'take-home'
      ? `The take-home was about ${spokenAmount}, after costs and fees.`
      : q.basis === 'net'
        ? `After costs, it came to about ${spokenAmount}.`
        : `Bookings came to about ${spokenAmount}, before costs.`;
  const spokenLabel = `Here is an example. A typical ${bedWord}-bed in ${area}, from ${numberInWords(agg.sample_count)} ${agg.sample_count === 1 ? 'report' : 'reports'}. Every property is different.`;

  return {
    label,
    gross,
    net,
    takeHome: q.takeHome,
    occupancyPct: finite(agg.avg_occupancy) && agg.avg_occupancy >= 0 ? Math.min(100, Math.round(agg.avg_occupancy)) : null,
    sentence: `${label} ${line}`,
    spoken: `${spokenLabel} ${spokenLine}`,
    bedrooms: agg.bedrooms,
    sampleCount: agg.sample_count,
    areaLabel: area,
    basis: q.basis,
    amount: q.amount,
    amountText,
  };
}

/**
 * True when every £ figure in the text sits in a text block that carries the
 * label: either the text has no £ figure, or it contains the label.
 */
export function figureIsLabelled(text: string): boolean {
  return !POUND_RE.test(text) || FIGURE_LABEL_RE.test(text);
}
