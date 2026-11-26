/**
 * Deal feed (queue Batch 1): the four billing_settings rows, one parser
 * (parseDealFeedSettings). Seeded in supabase/schema.sql's "Deal feed" block
 * (jsonb values); a missing or malformed value falls back to its default,
 * which is the seed (a test reads schema.sql and pins the two together).
 *
 *   deal_stale_credit_enabled   the switch for the 7-day credit (off)
 *   deal_stale_credit_days      how soon after the open a deal must go for the credit
 *   deal_dedupe_enabled         the switch for hiding duplicates on the grid (off)
 *   deal_dedupe_price_pct       how close (%) two prices must be to call a deal a twin
 *
 * Pure: no network, no database, no server-only. The reader is in
 * deal-feed-settings-server.ts.
 */
import { parseSwitch } from '../credit/unit-costs.ts';

export interface DealFeedSettings {
  staleCreditEnabled: boolean;
  staleCreditDays: number;
  dedupeEnabled: boolean;
  /** Percent, may be fractional (2 or 2.5). */
  dedupePricePct: number;
}

export const DEAL_FEED_SETTING_KEYS = {
  staleCreditEnabled: 'deal_stale_credit_enabled',
  staleCreditDays: 'deal_stale_credit_days',
  dedupeEnabled: 'deal_dedupe_enabled',
  dedupePricePct: 'deal_dedupe_price_pct',
} as const satisfies Record<keyof DealFeedSettings, string>;

export const DEFAULT_DEAL_FEED_SETTINGS: DealFeedSettings = {
  staleCreditEnabled: false,
  staleCreditDays: 7,
  dedupeEnabled: false,
  dedupePricePct: 2,
};

export type DealFeedSettingRow = { key: string; value: unknown };

function numberIn(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/** The settings from billing_settings rows (any other key is ignored). */
export function parseDealFeedSettings(rows: readonly DealFeedSettingRow[] | null | undefined): DealFeedSettings {
  const kv = new Map<string, unknown>();
  for (const r of rows ?? []) if (r && typeof r.key === 'string') kv.set(r.key, r.value);
  const d = DEFAULT_DEAL_FEED_SETTINGS;
  const k = DEAL_FEED_SETTING_KEYS;
  const days = numberIn(kv.get(k.staleCreditDays), 1, 90, d.staleCreditDays);
  return {
    staleCreditEnabled: parseSwitch(kv.get(k.staleCreditEnabled)),
    staleCreditDays: Number.isInteger(days) ? days : d.staleCreditDays,
    dedupeEnabled: parseSwitch(kv.get(k.dedupeEnabled)),
    dedupePricePct: numberIn(kv.get(k.dedupePricePct), 0, 20, d.dedupePricePct),
  };
}
