/**
 * Batch 36: the customer websites' grace billing_settings rows, one parser
 * (parseGrace). Seeded in supabase/schema.sql's Batch 36 section; a missing or
 * malformed value falls back to its default, per key.
 *
 *   website_abandon_days        days with no login and no website lead before the
 *                               warnings start (whole number, 1 to 3650)
 *   website_warning_days        the warnings, as "days before switch-off":
 *                               "30,14,3" (unique whole numbers 1 to 365, at most 5;
 *                               stored as a string, read as a string or a list)
 *   website_delete_after_days   days a site stays switched off before its data
 *                               is deleted (whole number, 1 to 3650)
 *
 * The largest warning day is also the shortest notice a site always gets: the
 * switch-off date is never earlier than the first warning plus it.
 *
 * Pure: no network, no database, no server-only.
 */

export interface GraceSettings {
  abandonDays: number;
  /** Largest first, unique, 1 to 5 entries. */
  warningDays: number[];
  deleteAfterDays: number;
}

export const GRACE_KEYS = {
  abandonDays: 'website_abandon_days',
  warningDays: 'website_warning_days',
  deleteAfterDays: 'website_delete_after_days',
} as const satisfies Record<keyof GraceSettings, string>;

export const DEFAULT_GRACE: GraceSettings = {
  abandonDays: 90,
  warningDays: [30, 14, 3],
  deleteAfterDays: 90,
};

export const GRACE_DAYS_MAX = 3650;
export const GRACE_WARNING_DAY_MAX = 365;
export const GRACE_WARNINGS_MAX = 5;

function wholeIn(raw: unknown, min: number, max: number): number | null {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || (typeof raw === 'string' && raw.trim() === '')) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/**
 * The warning days from a stored value ("30,14,3" or [30, 14, 3]), largest
 * first; null when any entry is bad, one repeats, there are none or more than five.
 */
export function parseWarningDays(raw: unknown): number[] | null {
  let parts: unknown[];
  if (typeof raw === 'string') parts = raw.split(',').map((s) => s.trim());
  else if (Array.isArray(raw)) parts = raw;
  else return null;
  if (parts.length < 1 || parts.length > GRACE_WARNINGS_MAX) return null;
  const days: number[] = [];
  for (const p of parts) {
    const n = wholeIn(p, 1, GRACE_WARNING_DAY_MAX);
    if (n === null || days.includes(n)) return null;
    days.push(n);
  }
  return days.sort((a, b) => b - a);
}

export function parseGrace(get: (key: string) => unknown): GraceSettings {
  const d = DEFAULT_GRACE;
  const k = GRACE_KEYS;
  return {
    abandonDays: wholeIn(get(k.abandonDays), 1, GRACE_DAYS_MAX) ?? d.abandonDays,
    warningDays: parseWarningDays(get(k.warningDays)) ?? [...d.warningDays],
    deleteAfterDays: wholeIn(get(k.deleteAfterDays), 1, GRACE_DAYS_MAX) ?? d.deleteAfterDays,
  };
}

/** The largest warning day: the shortest notice a site gets before it is switched off. */
export function largestWarningDay(s: GraceSettings): number {
  return Math.max(...s.warningDays);
}

/**
 * A value an admin typed for one of the three settings, checked: the value to
 * store (a number, or the normalised "30,14,3" string), or null when it is not
 * allowed. An unknown key is never stored.
 */
export function checkGraceSetting(key: string, raw: unknown): { key: string; value: number | string } | null {
  if (key === GRACE_KEYS.abandonDays || key === GRACE_KEYS.deleteAfterDays) {
    const n = wholeIn(raw, 1, GRACE_DAYS_MAX);
    return n === null ? null : { key, value: n };
  }
  if (key === GRACE_KEYS.warningDays) {
    const days = parseWarningDays(raw);
    return days === null ? null : { key, value: days.join(',') };
  }
  return null;
}
