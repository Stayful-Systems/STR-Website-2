import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { buildSnapshot } from '../market/aggregate';
import { loadReportRows } from '../market/source';
import { areaMetaForCode } from '../market/areas';
import { districtLocalities } from '../market/district-localities';
import { districtLabel } from '../market/labels';
import { MIN_DISTRICT_SAMPLES } from '../market/confidence';
import { modalBedrooms } from '../market/area-longlet';
import type { MarketArea, MarketBedroomAgg, MarketSnapshot } from '../market/types';
import { DEFAULT_MIN_AREA_SAMPLES, chooseSourceFor, parseAreaKey, parseMinAreaSamples, type AreaOption } from './area.ts';

export { NET_INCLUDES_MANAGEMENT_FEE, matchArea, type AreaOption } from './area.ts';

/**
 * Batch 38: the market areas an operator can build a pack for, and the one
 * bedroom group of market data a pack's example figure rests on.
 *
 *   readMinAreaSamples()   the setting ad_pack_min_area_samples (default 5)
 *   listDistricts()        the pick list: every postcode area with data, and
 *                          every district with at least MIN_DISTRICT_SAMPLES
 *   areaFigureSource()     district first, the postcode area when the district
 *                          is too thin, or { error: 'not_enough_data' }
 *
 * SERVER ONLY. The market snapshot the explorer shows (cached.ts) holds cards,
 * which do not carry net revenue; this builds the raw snapshot itself
 * (loadReportRows + buildSnapshot, the same two calls the explorer's build
 * makes) and keeps it in memory for ten minutes, so a screen that lists the
 * areas and then builds a figure reads the reports once. The reports are
 * the same rows with the same quality filter as the explorer's.
 *
 * What avg_net_revenue deducts is written up in area.ts (NET_INCLUDES_MANAGEMENT_FEE).
 * Never log an address or a report: nothing here selects one.
 */

const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
let memo: { at: number; snapshot: MarketSnapshot } | null = null;
let inflight: Promise<MarketSnapshot | null> | null = null;

async function snapshot(): Promise<MarketSnapshot | null> {
  if (memo && Date.now() - memo.at < SNAPSHOT_TTL_MS) return memo.snapshot;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await loadReportRows();
      if (rows.length === 0) return null;
      const built = buildSnapshot(rows);
      memo = { at: Date.now(), snapshot: built };
      return built;
    } catch (err) {
      console.error('[ad-packs] market snapshot failed:', err instanceof Error ? err.name : 'error');
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** The setting ad_pack_min_area_samples; a missing or unreadable value is the default (5). */
export async function readMinAreaSamples(): Promise<number> {
  if (!hasServiceRole()) return DEFAULT_MIN_AREA_SAMPLES;
  const { data, error } = await createAdminClient().from('billing_settings').select('value').eq('key', 'ad_pack_min_area_samples').maybeSingle();
  if (error) {
    console.error('[ad-packs] min samples read failed, using the default:', error.code ?? 'error');
    return DEFAULT_MIN_AREA_SAMPLES;
  }
  return parseMinAreaSamples((data as { value?: unknown } | null)?.value);
}

function areaOptionOf(a: MarketArea): AreaOption {
  const name = areaMetaForCode(a.postcode_area).name;
  return {
    areaKey: a.postcode_area,
    level: 'area',
    label: `${name} (${a.postcode_area})`,
    adLabel: name,
    areaCode: a.postcode_area,
    areaName: name,
    localities: [],
    samples: a.total_sample_count,
  };
}

/**
 * The pick list, sorted by name: each postcode area that has market data, then
 * its districts that have enough reports to show their own figures. Empty when
 * the market data cannot be read.
 */
export async function listDistricts(): Promise<AreaOption[]> {
  const snap = await snapshot();
  if (!snap) return [];
  const out: AreaOption[] = [];
  for (const area of snap.areas) {
    const base = areaOptionOf(area);
    out.push(base);
    for (const d of area.districts ?? []) {
      if (d.total_sample_count < MIN_DISTRICT_SAMPLES) continue;
      const localities = districtLocalities(d.district);
      const lead = localities[0] ?? null;
      out.push({
        areaKey: d.district,
        level: 'district',
        label: lead ? `${base.areaName} · ${districtLabel({ code: d.district, locality: lead })}` : `${base.areaName} ${d.district}`,
        adLabel: lead ? `${lead}, ${base.areaName}` : `${base.areaName} ${d.district}`,
        areaCode: area.postcode_area,
        areaName: base.areaName,
        localities,
        samples: d.total_sample_count,
      });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label) || a.areaKey.localeCompare(b.areaKey));
}

export type AreaFigureSource = {
  /** The key the figure actually rests on: the district asked for, or its postcode area after a fall-back. Store THIS as the pack's area_key. */
  areaKey: string;
  /** The place name an ad can use ("Lenton, Nottingham", or "Nottingham" after a fall-back). */
  areaLabel: string;
  level: 'district' | 'area';
  /** True when the district was too thin and the postcode area was used instead. */
  fellBack: boolean;
  /** The most common bedroom count in that level (modalBedrooms). */
  bedrooms: number;
  /** That bedroom group: yearly gross and net, occupancy 0 to 100, sample_count. */
  agg: MarketBedroomAgg;
  /** The area's average monthly long-let rent (PropertyData, cached), or null. */
  longLetRent: number | null;
  /** Reports behind the figure (agg.sample_count). */
  samples: number;
};

export type AreaFigureResult = AreaFigureSource | { error: 'not_enough_data'; message: string };

const NOT_ENOUGH: AreaFigureResult = { error: 'not_enough_data', message: 'There is not enough data in your area yet.' };

type Resolved = {
  area: MarketArea;
  district: NonNullable<MarketArea['districts']>[number] | null;
  chosen: NonNullable<ReturnType<typeof chooseSourceFor>>;
  useDistrict: boolean;
  name: string;
};

/** District first, the postcode area when the district is too thin; null when neither has enough. Reads no paid data. */
async function resolveSource(input: { areaKey: string; minSamples?: number; bedrooms?: number | null }): Promise<Resolved | null> {
  const parsed = parseAreaKey(input.areaKey);
  if (!parsed) return null;
  const minSamples = input.minSamples && input.minSamples > 0 ? input.minSamples : await readMinAreaSamples();
  const snap = await snapshot();
  if (!snap) return null;
  const area = snap.areas.find((a) => a.postcode_area.toUpperCase() === parsed.areaCode) ?? null;
  if (!area) return null;
  const district = parsed.level === 'district' ? ((area.districts ?? []).find((d) => d.district.toUpperCase() === parsed.key) ?? null) : null;
  // Batch 55 step 5: a preferred bedroom count (lead database route) is tried first; without one this is chooseSource.
  const chosen = chooseSourceFor({ district, area, minSamples, bedrooms: input.bedrooms });
  if (!chosen) return null;
  return { area, district, chosen, useDistrict: chosen.level === 'district' && district !== null, name: areaMetaForCode(area.postcode_area).name };
}

/** What the operator screen tells someone choosing an area: where the figure will rest and the bedroom size it will use. */
export type AreaPreview = { areaKey: string; areaLabel: string; level: 'district' | 'area'; fellBack: boolean; bedrooms: number; samples: number };
export type AreaPreviewResult = AreaPreview | { error: 'not_enough_data'; message: string };

/**
 * The same choice areaFigureSource makes, without the long-let rent lookup
 * (which is house-paid PropertyData): safe to call on every change of the pick
 * list. Phase 8's confirm-your-area step shows it.
 */
export async function areaPreview(input: { areaKey: string; minSamples?: number; bedrooms?: number | null }): Promise<AreaPreviewResult> {
  const r = await resolveSource(input);
  if (!r) return NOT_ENOUGH;
  const { area, district, chosen, useDistrict, name } = r;
  const lead = useDistrict && district ? (districtLocalities(district.district)[0] ?? null) : null;
  const rentArea: MarketArea = useDistrict && district ? { ...district, postcode_area: area.postcode_area } : area;
  return {
    areaKey: useDistrict && district ? district.district : area.postcode_area,
    areaLabel: useDistrict && district ? (lead ? `${lead}, ${name}` : `${name} ${district.district}`) : name,
    level: useDistrict ? 'district' : 'area',
    fellBack: chosen.fellBack,
    bedrooms: chosen.preferred ? chosen.group.bedrooms : (modalBedrooms(rentArea) ?? chosen.group.bedrooms),
    samples: chosen.group.sample_count,
  };
}

/**
 * The market data a pack's example figure rests on. `areaKey` is a district
 * ("NG7") or a postcode area ("NG"). A district is used when its most common
 * bedroom group has at least `minSamples` reports, otherwise its postcode
 * area; if that is too thin as well, `{ error: 'not_enough_data' }`.
 */
export async function areaFigureSource(input: { areaKey: string; minSamples?: number; bedrooms?: number | null }): Promise<AreaFigureResult> {
  const r = await resolveSource(input);
  if (!r) return NOT_ENOUGH;
  const { area, district, chosen, useDistrict, name } = r;

  const lead = useDistrict && district ? (districtLocalities(district.district)[0] ?? null) : null;
  const rentArea: MarketArea = useDistrict && district ? { ...district, postcode_area: area.postcode_area } : area;
  // A preferred count that has enough reports is the count the figure rests on; otherwise the most common, as before.
  const bedrooms = chosen.preferred ? chosen.group.bedrooms : (modalBedrooms(rentArea) ?? chosen.group.bedrooms);
  // No long-let rent lookup here: it is house-paid PropertyData, no ad uses it, and this read also runs on refused
  // requests and dry runs, ahead of the cost caps. The field stays (null) so the shape does not change.
  const longLetRent: number | null = null;
  return {
    areaKey: useDistrict && district ? district.district : area.postcode_area,
    areaLabel: useDistrict && district ? (lead ? `${lead}, ${name}` : `${name} ${district.district}`) : name,
    level: useDistrict ? 'district' : 'area',
    fellBack: chosen.fellBack,
    bedrooms,
    agg: chosen.group,
    longLetRent,
    samples: chosen.group.sample_count,
  };
}
