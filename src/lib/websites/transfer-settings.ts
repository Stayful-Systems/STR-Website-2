/**
 * Batch 37: the website transfer billing_settings rows, one parser
 * (parseTransfer). Seeded in supabase/schema.sql's Batch 37 section; a missing
 * or malformed value falls back to its default, per key.
 *
 *   website_transfer_overlap_days  days our copy keeps serving after a transfer
 *                                  starts (whole number, 1 to 365)
 *   website_transfer_stuck_days    days a requested domain move may sit before the
 *                                  admin is told, once (whole number, 1 to 90)
 *   website_transfer_code_from     the date (YYYY-MM-DD, a real calendar day) from
 *                                  which .uk moves use a Transfer Authorisation
 *                                  Code instead of an IPS tag (Nominet retires
 *                                  the tag on 9 Feb 2027)
 *
 * Pure: no network, no database, no server-only.
 */

export interface TransferSettings {
  overlapDays: number;
  stuckDays: number;
  /** YYYY-MM-DD: the first day the transfer code (not the IPS tag) is the method. */
  codeFrom: string;
}

export const TRANSFER_KEYS = {
  overlapDays: 'website_transfer_overlap_days',
  stuckDays: 'website_transfer_stuck_days',
  codeFrom: 'website_transfer_code_from',
} as const satisfies Record<keyof TransferSettings, string>;

export const DEFAULT_TRANSFER: TransferSettings = {
  overlapDays: 30,
  stuckDays: 5,
  codeFrom: '2027-02-09',
};

export const TRANSFER_OVERLAP_DAYS_MAX = 365;
export const TRANSFER_STUCK_DAYS_MAX = 90;

function wholeIn(raw: unknown, min: number, max: number): number | null {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || (typeof raw === 'string' && raw.trim() === '')) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** A real calendar day written YYYY-MM-DD (no 31 Feb), or null. */
export function parseCodeFrom(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return s;
}

export function parseTransfer(get: (key: string) => unknown): TransferSettings {
  const d = DEFAULT_TRANSFER;
  const k = TRANSFER_KEYS;
  return {
    overlapDays: wholeIn(get(k.overlapDays), 1, TRANSFER_OVERLAP_DAYS_MAX) ?? d.overlapDays,
    stuckDays: wholeIn(get(k.stuckDays), 1, TRANSFER_STUCK_DAYS_MAX) ?? d.stuckDays,
    codeFrom: parseCodeFrom(get(k.codeFrom)) ?? d.codeFrom,
  };
}

/**
 * A value an admin typed for one of the three settings, checked: the value to
 * store (a number, or the YYYY-MM-DD string), or null when it is not allowed.
 * An unknown key is never stored.
 */
export function checkTransferSetting(key: string, raw: unknown): { key: string; value: number | string } | null {
  if (key === TRANSFER_KEYS.overlapDays) {
    const n = wholeIn(raw, 1, TRANSFER_OVERLAP_DAYS_MAX);
    return n === null ? null : { key, value: n };
  }
  if (key === TRANSFER_KEYS.stuckDays) {
    const n = wholeIn(raw, 1, TRANSFER_STUCK_DAYS_MAX);
    return n === null ? null : { key, value: n };
  }
  if (key === TRANSFER_KEYS.codeFrom) {
    const s = parseCodeFrom(raw);
    return s === null ? null : { key, value: s };
  }
  return null;
}
