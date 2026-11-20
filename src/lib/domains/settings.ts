/**
 * Batch 33: the customer website domains' billing_settings rows, one parser
 * (parseDomains). Seeded in supabase/schema.sql's Batch 33 section; a missing
 * or malformed value falls back to its default. The switches read true/false
 * (or "true"/"false") and nothing else: anything unreadable is the default.
 *
 *   domain_charge_on               false: the yearly charge never runs
 *   domain_daily_spend_cap_pence   most Stayful spends on domains per UK day
 *                                  (0 stops all buying; 0 to 100000)
 *   domain_auto_buy                true: buy as soon as a member chooses a name;
 *                                  false: the admin presses Buy
 *
 * The cap is also read in SQL (website_domain_spend_claim reads it itself);
 * this parser is what the app and the admin panel show.
 *
 * Pure: no network, no database, no server-only.
 */

export interface DomainSettings {
  chargeOn: boolean;
  dailySpendCapPence: number;
  autoBuy: boolean;
}

export const DOMAIN_KEYS = {
  chargeOn: 'domain_charge_on',
  dailySpendCapPence: 'domain_daily_spend_cap_pence',
  autoBuy: 'domain_auto_buy',
} as const satisfies Record<keyof DomainSettings, string>;

export const DEFAULT_DOMAINS: DomainSettings = {
  chargeOn: false,
  dailySpendCapPence: 5000,
  autoBuy: true,
};

/** The most the daily cap may be set to (£1,000). */
export const DOMAIN_CAP_MAX_PENCE = 100000;

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

export function parseDomains(get: (key: string) => unknown): DomainSettings {
  const d = DEFAULT_DOMAINS;
  const k = DOMAIN_KEYS;
  return {
    chargeOn: switchIn(get(k.chargeOn), d.chargeOn),
    dailySpendCapPence: wholeIn(get(k.dailySpendCapPence), 0, DOMAIN_CAP_MAX_PENCE, d.dailySpendCapPence),
    autoBuy: switchIn(get(k.autoBuy), d.autoBuy),
  };
}

/** A value an admin typed for one of the three settings, checked: the value to store, or null when it is not allowed. */
export function checkDomainSetting(key: string, raw: unknown): { key: string; value: boolean | number } | null {
  if (key === DOMAIN_KEYS.chargeOn || key === DOMAIN_KEYS.autoBuy) {
    if (raw === true || raw === 'true') return { key, value: true };
    if (raw === false || raw === 'false') return { key, value: false };
    return null;
  }
  if (key === DOMAIN_KEYS.dailySpendCapPence) {
    if (raw === null || raw === undefined || typeof raw === 'boolean' || (typeof raw === 'string' && raw.trim() === '')) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > DOMAIN_CAP_MAX_PENCE) return null;
    return { key, value: n };
  }
  return null;
}
