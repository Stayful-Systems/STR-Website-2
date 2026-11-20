/**
 * Batch 38: the pure half of the pack's area: matching what an operator typed
 * to a market area, choosing which level a figure rests on, and what the
 * market's net revenue figure does and does not deduct.
 *
 * area-server.ts loads the market data and calls these; the tests call them
 * directly, so nothing here touches a database.
 *
 * ── What `avg_net_revenue` deducts (read from the code, not assumed) ──
 *
 * The figure an ad quotes starts from `MarketBedroomAgg.avg_net_revenue`
 * (src/lib/market/types.ts), which src/lib/market/aggregate.ts `bedroomGroups`
 * builds as the plain mean of `ReportRow.net_revenue` over the analyser reports
 * in that bedroom group (non-null, positive values only). `net_revenue` is
 * the `analyser_reports.net_revenue` column, read by src/lib/market/source.ts
 * and src/lib/market/report-row.ts and written by the analyser itself.
 *
 * Evidence for what the analyser takes off:
 *   - src/lib/analysis.ts `calculateFinancials` (the one source of truth the
 *     address analyser and the market verdict share): "Total operating costs:
 *     15% platform + 15% management + 18% cleaning = 48%. Net = gross * 0.52".
 *   - src/lib/pdf/derive.ts: the same 15 / 15 / 18 split, `netAnnual = gross -
 *     platformFee - mgmtFee - cleaning`.
 *   - src/lib/sections-data.ts: "Net revenue is shown after platform fees,
 *     cleaning and management".
 *   - src/lib/market/tab-model.ts: "after platform, management and cleaning;
 *     before bills and mortgage".
 * So the net figure is gross less platform fees (15%), a MANAGEMENT fee (15%,
 * the source brand's own rate) and cleaning (18%); it is before bills (utilities,
 * council tax), mortgage and tax. A deal-quality check row writes net_revenue
 * null (src/lib/deal-quality/checks.ts), so those rows never feed this average.
 *
 * Confidence: medium. The writer of the stored column is the analyser, which is
 * outside this repository (nothing here inserts a 'analyser' row), so the 48%
 * model above is what the in-repo code says the analyser does, not something a
 * test here can prove. Because that 15% is the source brand's rate, not the
 * operator's, taking it as "the operator's fee already deducted" would put
 * someone else's fee in the operator's ad. So the conservative reading is used:
 *
 *   NET_INCLUDES_MANAGEMENT_FEE = false
 *
 * which makes figures.ts take-home = net minus the OPERATOR's own fee on the
 * gross (and, with no fee set, quote the net "after costs"). That can only
 * understate what an operator keeps, never overstate it. If the analyser's
 * column is ever confirmed to exclude the management fee, nothing changes; if
 * it is confirmed to include a fee of the operator's own rate, change this
 * constant (a test pins it so a change forces a re-read of this block).
 *
 * Pure: no network, no database, no server-only.
 */

import type { MarketBedroomAgg } from '../market/types.ts';

export const NET_INCLUDES_MANAGEMENT_FEE: boolean = false;

/** Default fewest reports a figure may rest on (setting ad_pack_min_area_samples). */
export const DEFAULT_MIN_AREA_SAMPLES = 5;

/** A level the operator can pick: a postcode district (NG7) or a whole postcode area (NG). */
export type AreaOption = {
  /** 'NG7' (district) or 'NG' (postcode area): the pack's area_key. */
  areaKey: string;
  level: 'district' | 'area';
  /** For the pick list, e.g. "Nottingham · Lenton (NG7)". */
  label: string;
  /** The place name an ad can use: "Nottingham", "Lenton, Nottingham" or "Nottingham NG7". */
  adLabel: string;
  /** The postcode area (NG) this level belongs to. */
  areaCode: string;
  /** The postcode area's place name ("Nottingham"). */
  areaName: string;
  /** Every locality on file for a district, lead first; empty for an area. */
  localities: string[];
  /** Analyser reports behind it (all bedroom counts). */
  samples: number;
};

/** A setting value from billing_settings (jsonb): a whole number from 1 to 1000, else the default. */
export function parseMinAreaSamples(raw: unknown): number {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return DEFAULT_MIN_AREA_SAMPLES;
  if (typeof raw === 'string' && raw.trim() === '') return DEFAULT_MIN_AREA_SAMPLES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : DEFAULT_MIN_AREA_SAMPLES;
}

// ── Which level a figure rests on ──

/**
 * The bedroom group with the most reports (the first on a tie, lowest bedroom
 * count, as `modalBedrooms` in the market code picks), or null with no groups.
 */
export function modalGroup(groups: readonly MarketBedroomAgg[]): MarketBedroomAgg | null {
  let best: MarketBedroomAgg | null = null;
  let bestN = -1;
  for (const g of groups) {
    if (g.sample_count > bestN) {
      bestN = g.sample_count;
      best = g;
    }
  }
  return best;
}

export type ChosenSource = { level: 'district' | 'area'; group: MarketBedroomAgg; fellBack: boolean };

/**
 * District first; the postcode area when the district's most common bedroom
 * group has fewer than `minSamples` reports (or the district has no data).
 * Null when neither has enough.
 */
export function chooseSource(input: {
  district: { by_bedrooms: readonly MarketBedroomAgg[] } | null;
  area: { by_bedrooms: readonly MarketBedroomAgg[] } | null;
  minSamples: number;
}): ChosenSource | null {
  const min = Number.isFinite(input.minSamples) && input.minSamples > 0 ? input.minSamples : DEFAULT_MIN_AREA_SAMPLES;
  if (input.district) {
    const g = modalGroup(input.district.by_bedrooms);
    if (g && g.sample_count >= min) return { level: 'district', group: g, fellBack: false };
  }
  if (input.area) {
    const g = modalGroup(input.area.by_bedrooms);
    if (g && g.sample_count >= min) return { level: 'area', group: g, fellBack: input.district !== null };
  }
  return null;
}

/** The kind of key: 'NG7' is a district, 'NG' a postcode area, anything else null. Upper-cased. */
export function parseAreaKey(raw: unknown): { key: string; level: 'district' | 'area'; areaCode: string } | null {
  const key = String(raw ?? '').trim().toUpperCase();
  const d = /^([A-Z]{1,2})\d[A-Z\d]?$/.exec(key);
  if (d) return { key, level: 'district', areaCode: d[1] };
  if (/^[A-Z]{1,2}$/.test(key)) return { key, level: 'area', areaCode: key };
  return null;
}

// ── Matching what the operator typed ──

function norm(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const OUTWARD = /^([a-z]{1,2}\d[a-z\d]?)(?:\s*\d[a-z]{0,2})?$/;
const POSTCODE_AREA = /^[a-z]{1,2}$/;

function byBest(a: AreaOption, b: AreaOption): number {
  return b.samples - a.samples || a.areaKey.localeCompare(b.areaKey);
}

/** The names an option answers to: an area its place name, a district its localities. */
function namesOf(o: AreaOption): string[] {
  return (o.level === 'area' ? [o.areaName] : o.localities).map(norm).filter(Boolean);
}

/**
 * Pre-selects the pick-list entry for the first area an operator typed on
 * their website ("Cambridge", "Lenton", "NG7 2AB", "Nottingham city centre").
 * Deterministic: tiers from the most to the least exact, and within a tier the
 * entry with most reports (then the lower key) wins. Case and punctuation do
 * not matter. Null when nothing matches; the operator then picks from the list.
 *
 *   1  a postcode: its outward code if that district is listed, else its area
 *   2  the typed text equals a place name (an area's town, a district's locality)
 *   3  one starts with the other, on a word boundary (min 3 letters)
 *   4  one contains the other as whole words (min 4 letters)
 */
export function matchArea(areas: readonly string[], options: readonly AreaOption[]): AreaOption | null {
  const typed = norm(Array.isArray(areas) ? (areas[0] ?? '') : '');
  if (typed === '' || options.length === 0) return null;
  const sorted = [...options].sort(byBest);

  // 1. Postcode or outward code.
  const pc = OUTWARD.exec(typed);
  if (pc) {
    const outward = pc[1].toUpperCase();
    const district = sorted.find((o) => o.level === 'district' && o.areaKey === outward);
    if (district) return district;
    const letters = /^[A-Z]{1,2}/.exec(outward)?.[0] ?? '';
    const area = sorted.find((o) => o.level === 'area' && o.areaKey === letters);
    if (area) return area;
  } else if (POSTCODE_AREA.test(typed)) {
    const area = sorted.find((o) => o.level === 'area' && o.areaKey === typed.toUpperCase());
    if (area) return area;
  }

  // 2 to 4. By name.
  const tiers: ((name: string) => boolean)[] = [
    (n) => n === typed,
    (n) => (n.length >= 3 && (typed === n || typed.startsWith(`${n} `))) || (typed.length >= 3 && n.startsWith(`${typed} `)),
    (n) => (n.length >= 4 && ` ${typed} `.includes(` ${n} `)) || (typed.length >= 4 && ` ${n} `.includes(` ${typed} `)),
  ];
  for (const test of tiers) {
    const hit = sorted.find((o) => namesOf(o).some(test));
    if (hit) return hit;
  }
  return null;
}
