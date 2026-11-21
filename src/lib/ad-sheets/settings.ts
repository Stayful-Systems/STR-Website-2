/**
 * Batch 35: the lead form sheet's billing_settings rows, one parser
 * (parseSheetSettings). Seeded in supabase/schema.sql's Batch 35 block (jsonb
 * values); a missing or malformed value falls back to its default, which is the
 * seed (a test reads schema.sql and pins the two together).
 *
 *   ad_sheets_enabled           master switch for the whole feature (off)
 *   ad_sheet_min_leads          leads an ad needs before it is ranked
 *   ad_sheet_quiet_days         days with no new row before the quiet email
 *   ad_sheet_outcome_pct        percent of older leads that must be past New
 *   ad_sheet_outcome_age_days   how old a lead is before that check counts it
 *   ad_sheet_reminder_age_days  how old a New lead is before the reminder
 *   ad_sheet_dedupe_days        window for merging a sheet row into a lead
 *   ad_sheet_guide_checked_at   when the setup guide screenshots were last checked (null)
 *
 * (ad_packs_enabled is read by ad-packs/eligibility-server.ts.)
 *
 * Pure: no network, no database, no server-only.
 */

export interface SheetSettings {
  enabled: boolean;
  minLeads: number;
  quietDays: number;
  outcomePct: number;
  outcomeAgeDays: number;
  reminderAgeDays: number;
  dedupeDays: number;
  /** ISO date-time the guide screenshots were last checked, or null. */
  guideCheckedAt: string | null;
}

export const SHEET_SETTING_KEYS = {
  enabled: 'ad_sheets_enabled',
  minLeads: 'ad_sheet_min_leads',
  quietDays: 'ad_sheet_quiet_days',
  outcomePct: 'ad_sheet_outcome_pct',
  outcomeAgeDays: 'ad_sheet_outcome_age_days',
  reminderAgeDays: 'ad_sheet_reminder_age_days',
  dedupeDays: 'ad_sheet_dedupe_days',
  guideCheckedAt: 'ad_sheet_guide_checked_at',
} as const satisfies Record<keyof SheetSettings, string>;

export const DEFAULT_SHEET_SETTINGS: SheetSettings = {
  enabled: false,
  minLeads: 5,
  quietDays: 7,
  outcomePct: 50,
  outcomeAgeDays: 14,
  reminderAgeDays: 7,
  dedupeDays: 30,
  guideCheckedAt: null,
};

export type SheetSettingRow = { key: string; value: unknown };

function wholeIn(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/** A switch (jsonb true/false, or the strings "true"/"false"); anything else is OFF. */
export function parseSwitch(raw: unknown): boolean {
  return raw === true || raw === 'true';
}

function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/** The eight settings from billing_settings rows (any other key is ignored). */
export function parseSheetSettings(rows: readonly SheetSettingRow[] | null | undefined): SheetSettings {
  const kv = new Map<string, unknown>();
  for (const r of rows ?? []) if (r && typeof r.key === 'string') kv.set(r.key, r.value);
  const d = DEFAULT_SHEET_SETTINGS;
  const k = SHEET_SETTING_KEYS;
  return {
    enabled: parseSwitch(kv.get(k.enabled)),
    minLeads: wholeIn(kv.get(k.minLeads), 1, 1000, d.minLeads),
    quietDays: wholeIn(kv.get(k.quietDays), 1, 365, d.quietDays),
    outcomePct: wholeIn(kv.get(k.outcomePct), 1, 100, d.outcomePct),
    outcomeAgeDays: wholeIn(kv.get(k.outcomeAgeDays), 1, 365, d.outcomeAgeDays),
    reminderAgeDays: wholeIn(kv.get(k.reminderAgeDays), 1, 365, d.reminderAgeDays),
    dedupeDays: wholeIn(kv.get(k.dedupeDays), 1, 365, d.dedupeDays),
    guideCheckedAt: isoOrNull(kv.get(k.guideCheckedAt)),
  };
}

/**
 * Whether the lead form card may be shown to this viewer: both master switches
 * on (ad packs and lead forms), or the viewer is an admin previewing it.
 */
export function sheetCardAvailable(opts: { adPacksEnabled: boolean; sheetsEnabled: boolean; admin: boolean }): boolean {
  return opts.admin || (opts.adPacksEnabled && opts.sheetsEnabled);
}
