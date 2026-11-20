/**
 * Batch 38: the ad pack's billing_settings rows, one parser (parseAdPackSettings).
 * Seeded in supabase/schema.sql's Batch 38 block (values are jsonb numbers); a
 * missing or malformed value falls back to its default.
 *
 *   ad_pack_free_regens         free regenerations of a pack per owner (after a brand change)
 *   ad_pack_voice_changes       voice changes per owner, before approving (38b)
 *   ad_pack_max_raw_pence       most one generation may cost in raw spend
 *   ad_pack_monthly_cap_pence   most all generations may cost in a UK month
 *   ad_pack_min_area_samples    fewest reports an area figure may rest on
 *   ad_pack_render_max_seconds  hard time limit of one notice-video render (38b; also read by render-store.ts)
 *   ad_pack_sandbox_vcpus       vCPUs of the render sandbox (38b; also read by render-store.ts)
 *
 * (ad_packs_enabled, the master switch, is read by eligibility-server.ts.)
 *
 * Pure: no network, no database, no server-only.
 */
import { DEFAULT_MIN_AREA_SAMPLES, parseMinAreaSamples } from './area.ts';

export interface AdPackSettings {
  freeRegens: number;
  voiceChanges: number;
  maxRawPence: number;
  monthlyCapPence: number;
  minAreaSamples: number;
  /** Seconds a render may take (the sandbox timeout). The cost guard prices this worst case. */
  renderMaxSeconds: number;
  /** vCPUs asked for per render sandbox. The cost guard prices this worst case. */
  sandboxVcpus: number;
}

/**
 * The most seconds one render really runs: the route's 300 s less 30 s for the voice, the uploads and the bookkeeping
 * (render-core.ts ROUTE_MAX_SECONDS - ROUTE_RESERVE_SECONDS; a test pins the two together).
 */
export const SANDBOX_SECONDS_CAP = 270;

export const AD_PACK_KEYS = {
  freeRegens: 'ad_pack_free_regens',
  voiceChanges: 'ad_pack_voice_changes',
  maxRawPence: 'ad_pack_max_raw_pence',
  monthlyCapPence: 'ad_pack_monthly_cap_pence',
  minAreaSamples: 'ad_pack_min_area_samples',
  renderMaxSeconds: 'ad_pack_render_max_seconds',
  sandboxVcpus: 'ad_pack_sandbox_vcpus',
} as const satisfies Record<keyof AdPackSettings, string>;

export const DEFAULT_AD_PACK_SETTINGS: AdPackSettings = {
  freeRegens: 1,
  voiceChanges: 1,
  maxRawPence: 500,
  monthlyCapPence: 5000,
  minAreaSamples: DEFAULT_MIN_AREA_SAMPLES,
  renderMaxSeconds: 300,
  sandboxVcpus: 2,
};

/** Highest values the admin may set (a typo guard, also what the parser accepts). */
export const AD_PACK_LIMITS = {
  freeRegens: 10,
  voiceChanges: 10,
  maxRawPence: 100_000,
  monthlyCapPence: 1_000_000,
} as const;

function wholeIn(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export type SettingRow = { key: string; value: unknown };

/** The seven settings from billing_settings rows (any other key is ignored). */
export function parseAdPackSettings(rows: readonly SettingRow[] | null | undefined): AdPackSettings {
  const kv = new Map<string, unknown>();
  for (const r of rows ?? []) if (r && typeof r.key === 'string') kv.set(r.key, r.value);
  const d = DEFAULT_AD_PACK_SETTINGS;
  const k = AD_PACK_KEYS;
  return {
    freeRegens: wholeIn(kv.get(k.freeRegens), 0, AD_PACK_LIMITS.freeRegens, d.freeRegens),
    voiceChanges: wholeIn(kv.get(k.voiceChanges), 0, AD_PACK_LIMITS.voiceChanges, d.voiceChanges),
    maxRawPence: wholeIn(kv.get(k.maxRawPence), 0, AD_PACK_LIMITS.maxRawPence, d.maxRawPence),
    monthlyCapPence: wholeIn(kv.get(k.monthlyCapPence), 0, AD_PACK_LIMITS.monthlyCapPence, d.monthlyCapPence),
    minAreaSamples: parseMinAreaSamples(kv.get(k.minAreaSamples)),
    renderMaxSeconds: wholeIn(kv.get(k.renderMaxSeconds), 60, 900, d.renderMaxSeconds),
    sandboxVcpus: wholeIn(kv.get(k.sandboxVcpus), 1, 8, d.sandboxVcpus),
  };
}

/** The monthly cap's rule (mirrors fitsCap in knowledge/gap/plan.ts): a cap of 0 stops everything. */
export function fitsCap(spentPence: number, worstPence: number, capPence: number): boolean {
  return capPence > 0 && spentPence + worstPence <= capPence;
}
