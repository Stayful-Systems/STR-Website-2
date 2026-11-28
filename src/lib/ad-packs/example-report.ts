/**
 * Batch 55 step 5 (Phase 2, 55c A2): the EXAMPLE REPORT a lead database pack is built from. Pure parts.
 *
 * Zac's decision (PROPOSED default "run"): an AnalysisInput is built directly for "Example property, <area>" at the main
 * area's representative postcode (AREA_REPRESENTATIVE_POSTCODE) and the pack's bedroom count, and run as HOUSE SPEND
 * (billedUserId null). When that run fails, the fallback is the newest finished analyser_reports row for that postcode
 * area and bedroom count, STRIPPED: only its figures are reused. Never a real landlord's address, email, name or notes.
 * The example report is NEVER saved to analyser_reports.
 *
 * Before the PDF is drawn, `exampleResultFor` makes the result safe to show in an ad whatever its source:
 *   - the address reads "Example property, <area>" (the cover, the header of every page and the file metadata)
 *   - every short-let comparable's title reads "Nearby listing N", its link and photo are dropped (a title can name a
 *     place or a host)
 *   - every long-let comparable's address reads "Nearby rental N"
 *   - the source listing, the deal, the project and the second opinion are dropped
 *
 * MASKING (Zac: "choose the robust option"). The £ figures are blurred in the render sandbox, not guessed in image
 * space: poppler's `pdftotext -bbox-layout` gives the exact box of every word the PDF drew, and
 * ad-render/example_pages.py blurs the box of every word that carries a £ (EXAMPLE_MASK.pound) and every percentage
 * (EXAMPLE_MASK.percent), stamps "Example report"
 * on every page, and finds the loupe's three stops from the section headings (EXAMPLE_MASK.targets). The positions come
 * from the PDF itself, so nothing in the react-pdf components (and nothing in a customer's real report) changes.
 *
 * Pure: no network, no database, no server-only.
 */
import type { AnalysisInput } from '../analysis/input.ts';
import type { AnalysisResult } from '../types.ts';
import { AREA_REPRESENTATIVE_POSTCODE } from '../market/area-postcodes.ts';
import { EXAMPLE_STAMP } from './ld-angles.ts';

/** The report pages the ads use (1 verdict, 2 numbers, 3 market, 4 location), rendered at 144 dpi (2x). */
export const EXAMPLE_PAGES = { first: 1, last: 4, dpi: 144 } as const;

/** What the sandbox masks and looks for (ad-render/example_pages.py reads this from the job file). */
export const EXAMPLE_MASK = {
  stamp: EXAMPLE_STAMP,
  /** Every word carrying one of these is blurred (55c decision 1: blur every £ figure). */
  pound: ['£'],
  /** Every percentage is blurred too (Zac, 28 Nov: "Management 15%", "Platform fees 15%", occupancy). */
  percent: true,
  /** The loupe's three stops, in order, each found by the first heading that matches on any page. */
  targets: [
    { id: 'comparables', headings: ['Other listings', 'How it stacks up against the neighbours'] },
    { id: 'occupancy', headings: ['OCCUPANCY', 'Occupancy'] },
    { id: 'demand', headings: ['Market demand', 'Why guests will book here'] },
  ],
} as const;

export const exampleAddress = (area: string): string => `Example property, ${String(area ?? '').replace(/\s+/g, ' ').trim() || 'your area'}`;

/** The postcode area of a market key ("NG7" → "NG", "LE" → "LE"). */
export function postcodeAreaOf(areaKey: string): string {
  const m = /^([A-Z]{1,2})/.exec(String(areaKey ?? '').trim().toUpperCase());
  return m ? m[1] : '';
}

/** The input the example run uses, or null when the area has no representative postcode (then the fallback row). */
export function exampleInputFor(i: { areaKey: string; areaLabel: string; bedrooms: number }): AnalysisInput | null {
  const postcode = AREA_REPRESENTATIVE_POSTCODE[postcodeAreaOf(i.areaKey)];
  if (!postcode) return null;
  const bedrooms = Number.isInteger(i.bedrooms) && i.bedrooms >= 1 && i.bedrooms <= 10 ? i.bedrooms : 2;
  return {
    property: { address: exampleAddress(i.areaLabel), postcode, bedrooms, guests: Math.min(16, bedrooms * 2) },
    email: null,
    propertyType: 'flat',
    bathrooms: undefined,
    parkingSpaces: 0,
    hasParking: false,
    outdoorSpace: 'none',
    askingPrice: null,
    rentPcm: null,
    sourceListing: null,
    checkedListingId: null,
    fromDeal: false,
    enhancedRequested: false,
  };
}

function looksLikeResult(v: unknown): v is AnalysisResult {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return !!o.property && !!o.shortLet && !!o.longLet && !!o.financials && typeof o.property === 'object';
}

/**
 * The figures of a finished analyser_reports row, or null. Only `raw_response` (the stored result) is read, and only
 * when it is a whole result; the row's address, lead_email, filename and anything else are never read.
 */
export function strippedFromRow(row: { raw_response?: unknown; bedrooms?: unknown } | null | undefined): AnalysisResult | null {
  if (!row || !looksLikeResult(row.raw_response)) return null;
  return structuredClone(row.raw_response);
}

/** The result made safe for an ad (see the header). Never changes the figures. */
export function exampleResultFor(result: AnalysisResult, areaLabel: string): AnalysisResult {
  const r = structuredClone(result) as AnalysisResult & Record<string, unknown>;
  const address = exampleAddress(areaLabel);
  r.property = { ...r.property, address, locality: String(areaLabel ?? '').trim() || r.property.locality };
  if (r.shortLet && Array.isArray(r.shortLet.comparables)) {
    r.shortLet = {
      ...r.shortLet,
      comparables: r.shortLet.comparables.map((c, i) => {
        const out = { ...c, title: `Nearby listing ${i + 1}`, url: '' };
        delete (out as { thumbnailUrl?: string }).thumbnailUrl;
        return out;
      }),
    };
  }
  if (r.longLet && Array.isArray(r.longLet.comparables)) {
    r.longLet = { ...r.longLet, comparables: r.longLet.comparables.map((c, i) => ({ ...c, address: `Nearby rental ${i + 1}` })) };
  }
  // The EPC, council tax and due diligence belong to one real address; an example property has none of its own.
  for (const k of ['sourceListing', 'deal', 'project', 'secondOpinion', 'epc', 'councilTax', 'dueDiligence', 'leadEmail', 'email', 'notes', 'name', 'preparedFor']) delete r[k];
  return r;
}

/** Every string in a value (for the test that no real address, email or title survives). */
export function stringsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out);
  return out;
}

/** True when the result has the figures an ad page needs (a short-let revenue and some comparables). */
export function hasExampleFigures(r: AnalysisResult): boolean {
  const rev = Number((r.shortLet as unknown as { annualRevenue?: number })?.annualRevenue ?? (r.financials as unknown as { grossRevenue?: number })?.grossRevenue ?? 0);
  return Number.isFinite(rev) && rev > 0 && Array.isArray(r.shortLet?.comparables) && r.shortLet.comparables.length > 0;
}

/** The example report's pages as stored: `<owner>/<pack>/v<n>/example/page-<i>.png`. */
export function examplePagePath(ownerId: string, packId: string, version: number, i: number): string {
  return `${ownerId}/${packId}/v${version}/example/page-${i}.png`;
}

export type ExamplePages = {
  /** The masked pages, in order (bucket refs). */
  pages: { name: string; path: string; width: number; height: number; contentType: 'image/png'; bytes: number }[];
  /** The loupe's three stops (fractions of the page), from the headings. */
  targets: { page: number; x: number; y: number; w: number; h: number }[];
  /** How many £ words were blurred (the test pins that it is never 0 on a page with a £ figure). */
  masked: number;
  /** 'run' (the engine) or 'snapshot' (a stripped finished report). */
  source: 'run' | 'snapshot';
};

/** pages.json as written by ad-render/example_pages.py, or null when it is not that shape. */
export function parsePagesJson(bytes: Uint8Array | null): { pages: { file: string; width: number; height: number; masked: number; stamped: boolean }[]; targets: ExamplePages['targets'] } | null {
  if (!bytes) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (!Array.isArray(j.pages) || !Array.isArray(j.targets)) return null;
    const pages = (j.pages as Record<string, unknown>[])
      .filter((p) => p && typeof p.file === 'string' && /^page-\d+\.png$/.test(p.file as string))
      .map((p) => ({ file: p.file as string, width: Number(p.width) || 0, height: Number(p.height) || 0, masked: Number(p.masked) || 0, stamped: p.stamped === true }));
    const targets = (j.targets as Record<string, unknown>[])
      .map((t) => ({ page: Number(t.page), x: Number(t.x), y: Number(t.y), w: Number(t.w), h: Number(t.h) }))
      .filter((t) => Number.isInteger(t.page) && [t.x, t.y, t.w, t.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1));
    return { pages, targets };
  } catch {
    return null;
  }
}
