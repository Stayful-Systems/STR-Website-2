/**
 * Batch 31: the customer websites' billing_settings rows, one parser
 * (parseWebsite). Seeded in supabase/schema.sql's Batch 31 section; a missing
 * or malformed value falls back to its default. The switches read true/false
 * (or "true"/"false") and nothing else: anything unreadable is the default,
 * which is OFF for both switches.
 *
 *   website_report_charge_on               false: reports are free (house-paid)
 *   website_report_pence                   the price when charging is on
 *   website_plan_gate_on                   false: no plan needed for a site
 *   website_free_reports_per_day           free reports, all sites, per UK day
 *   website_free_reports_per_site_per_day  free reports, one site, per UK day
 *                                          (inside the daily total; 0 stops it)
 *
 * The same limits are enforced in SQL (website_free_report_claim reads the
 * two limits itself); this parser is what the app and the admin panel show.
 *
 * Pure: no network, no database, no server-only.
 */

export interface WebsiteSettings {
  reportChargeOn: boolean;
  reportPence: number;
  planGateOn: boolean;
  freeReportsPerDay: number;
  freeReportsPerSitePerDay: number;
}

export const WEBSITE_KEYS = {
  reportChargeOn: 'website_report_charge_on',
  reportPence: 'website_report_pence',
  planGateOn: 'website_plan_gate_on',
  freeReportsPerDay: 'website_free_reports_per_day',
  freeReportsPerSitePerDay: 'website_free_reports_per_site_per_day',
} as const satisfies Record<keyof WebsiteSettings, string>;

export const DEFAULT_WEBSITE: WebsiteSettings = {
  reportChargeOn: false,
  reportPence: 300,
  planGateOn: false,
  freeReportsPerDay: 20,
  freeReportsPerSitePerDay: 5,
};

/** A switch: true / "true" is on, false / "false" is off, anything else is the default. */
function switchIn(raw: unknown, fallback: boolean): boolean {
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return fallback;
}

function wholeIn(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export function parseWebsite(get: (key: string) => unknown): WebsiteSettings {
  const d = DEFAULT_WEBSITE;
  const k = WEBSITE_KEYS;
  return {
    reportChargeOn: switchIn(get(k.reportChargeOn), d.reportChargeOn),
    reportPence: wholeIn(get(k.reportPence), 1, 10000, d.reportPence),
    planGateOn: switchIn(get(k.planGateOn), d.planGateOn),
    freeReportsPerDay: wholeIn(get(k.freeReportsPerDay), 0, 1000, d.freeReportsPerDay),
    freeReportsPerSitePerDay: wholeIn(get(k.freeReportsPerSitePerDay), 0, 1000, d.freeReportsPerSitePerDay),
  };
}

/**
 * Batch 55 (Part A): the calculator sites' report limit, a bot guard (not billing). Seeded in
 * supabase/schema.sql's Batch 55 block. It is NOT a field of WebsiteSettings on purpose: that
 * object is the admin panel's five website settings (saved key by key), and this one has no
 * panel of its own.
 *
 *   ad_calc_reports_per_day   reports one owner's calculator site may start per UK day (0 stops it)
 */
export const AD_CALC_REPORTS_PER_DAY_KEY = 'ad_calc_reports_per_day';
export const DEFAULT_AD_CALC_REPORTS_PER_DAY = 50;
export const AD_CALC_REPORTS_PER_DAY_MAX = 10_000;

/** The per-day calculator report limit from a raw billing_settings value; anything unreadable is the default. */
export function parseAdCalcReportsPerDay(raw: unknown): number {
  return wholeIn(raw, 0, AD_CALC_REPORTS_PER_DAY_MAX, DEFAULT_AD_CALC_REPORTS_PER_DAY);
}
