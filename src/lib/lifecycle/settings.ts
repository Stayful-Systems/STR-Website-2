/**
 * Batch 20's numbers: the £10 starter pack, the £5 low-credit decision and
 * the inactivity rules. Every one is a billing_settings row (seeded by the
 * "Batch 20" schema section, edited on /admin/lifecycle); this module is the
 * one place they are parsed, with the defaults the brief set.
 *
 *   starter_pack_from          the cutover: accounts created at or after it get
 *                              the pack offer and no welcome credit. Empty = the
 *                              pack is off and new members get the welcome
 *                              credit exactly as before.
 *   starter_pack_price_pence   what the pack costs (the Stripe price must match)
 *   starter_pack_credit_pence  the credit it gives in total (paid part + bonus)
 *   starter_pack_snooze_days   how long "Not now" hides the Today card
 *   low_credit_pence           the low-credit decision for members with no plan
 *   inactive_reengage_days     no qualifying action for this long: Re-engage
 *   picks_pause_inactive_days  no qualifying action for this long: picks pause
 *   inactivity_from            inactivity is never counted from before this
 *                              (the release date). Empty = the rules are off.
 *
 * Batch 29 (starter pack guardrails; the rules are src/lib/credit/pack-rules.ts):
 *   pack_bonus_expiry_days     the pack's bonus expires this many days after it is granted
 *   pack_fresh_report_cap      fresh full analyses a pack-only member may run
 *   pack_early_offer_pence     the one-off offer when a pack-only member's balance falls to this
 *   pack_picks_pause_days      a pack-only member's picks pause after this many days without a visit
 *   places_cache_days          Google Places nearby results are reused for this long
 *
 * Batch 30 (shorter signup questions):
 *   home_blocker_card_day      the Home "What's holding you back?" card shows from this day since sign-up (0: from the first visit)
 *   quiz_shorter_from          when the shorter quiz went live: /admin/profile compares members before and after it
 *   pack_paying_*_pct, pack_cost_*_pence   the lines on /admin/weekly-active's "Pack → paying"
 *
 * Pure: no network, no database, no server-only.
 */
import { parseDateSetting } from '../credit/deal-pricing.ts';

export interface LifecycleSettings {
  starterPackFrom: string | null;
  starterPackPricePence: number;
  starterPackCreditPence: number;
  starterPackSnoozeDays: number;
  lowCreditPence: number;
  inactiveReengageDays: number;
  picksPauseInactiveDays: number;
  inactivityFrom: string | null;
  packBonusExpiryDays: number;
  packFreshReportCap: number;
  packEarlyOfferPence: number;
  packPicksPauseDays: number;
  placesCacheDays: number;
  packPayingHeadlineFloorPct: number;
  packPayingHeadlineTargetPct: number;
  packPayingRundownPaidFloorPct: number;
  packPayingRundownPaidTargetPct: number;
  packCostTargetPence: number;
  packCostCeilingPence: number;
  homeBlockerCardDay: number;
  quizShorterFrom: string | null;
}

export const LIFECYCLE_KEYS = {
  starterPackFrom: 'starter_pack_from',
  starterPackPricePence: 'starter_pack_price_pence',
  starterPackCreditPence: 'starter_pack_credit_pence',
  starterPackSnoozeDays: 'starter_pack_snooze_days',
  lowCreditPence: 'low_credit_pence',
  inactiveReengageDays: 'inactive_reengage_days',
  picksPauseInactiveDays: 'picks_pause_inactive_days',
  inactivityFrom: 'inactivity_from',
  packBonusExpiryDays: 'pack_bonus_expiry_days',
  packFreshReportCap: 'pack_fresh_report_cap',
  packEarlyOfferPence: 'pack_early_offer_pence',
  packPicksPauseDays: 'pack_picks_pause_days',
  placesCacheDays: 'places_cache_days',
  packPayingHeadlineFloorPct: 'pack_paying_headline_floor_pct',
  packPayingHeadlineTargetPct: 'pack_paying_headline_target_pct',
  packPayingRundownPaidFloorPct: 'pack_paying_rundown_paid_floor_pct',
  packPayingRundownPaidTargetPct: 'pack_paying_rundown_paid_target_pct',
  packCostTargetPence: 'pack_cost_target_pence',
  packCostCeilingPence: 'pack_cost_ceiling_pence',
  homeBlockerCardDay: 'home_blocker_card_day',
  quizShorterFrom: 'quiz_shorter_from',
} as const satisfies Record<keyof LifecycleSettings, string>;

export const DEFAULT_LIFECYCLE: LifecycleSettings = {
  starterPackFrom: null,
  starterPackPricePence: 1000,
  starterPackCreditPence: 3000,
  starterPackSnoozeDays: 7,
  lowCreditPence: 500,
  inactiveReengageDays: 14,
  picksPauseInactiveDays: 25,
  inactivityFrom: null,
  packBonusExpiryDays: 30,
  packFreshReportCap: 3,
  packEarlyOfferPence: 1500,
  packPicksPauseDays: 7,
  placesCacheDays: 90,
  packPayingHeadlineFloorPct: 10,
  packPayingHeadlineTargetPct: 22,
  packPayingRundownPaidFloorPct: 35,
  packPayingRundownPaidTargetPct: 50,
  packCostTargetPence: 190,
  packCostCeilingPence: 250,
  homeBlockerCardDay: 3,
  quizShorterFrom: null,
};

function wholeAtLeast(raw: unknown, min: number, fallback: number): number {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && Number.isInteger(n) ? n : fallback;
}

/**
 * The settings from billing_settings' key/value rows. A malformed value falls
 * back to its default; the pack's credit is never less than its price, so the
 * bonus can never be negative.
 */
export function parseLifecycle(get: (key: string) => unknown): LifecycleSettings {
  const d = DEFAULT_LIFECYCLE;
  const price = wholeAtLeast(get(LIFECYCLE_KEYS.starterPackPricePence), 1, d.starterPackPricePence);
  const credit = wholeAtLeast(get(LIFECYCLE_KEYS.starterPackCreditPence), 1, d.starterPackCreditPence);
  return {
    starterPackFrom: parseDateSetting(get(LIFECYCLE_KEYS.starterPackFrom)),
    starterPackPricePence: price,
    starterPackCreditPence: credit >= price ? credit : price,
    starterPackSnoozeDays: wholeAtLeast(get(LIFECYCLE_KEYS.starterPackSnoozeDays), 1, d.starterPackSnoozeDays),
    lowCreditPence: wholeAtLeast(get(LIFECYCLE_KEYS.lowCreditPence), 0, d.lowCreditPence),
    inactiveReengageDays: wholeAtLeast(get(LIFECYCLE_KEYS.inactiveReengageDays), 1, d.inactiveReengageDays),
    picksPauseInactiveDays: wholeAtLeast(get(LIFECYCLE_KEYS.picksPauseInactiveDays), 1, d.picksPauseInactiveDays),
    inactivityFrom: parseDateSetting(get(LIFECYCLE_KEYS.inactivityFrom)),
    packBonusExpiryDays: wholeAtLeast(get(LIFECYCLE_KEYS.packBonusExpiryDays), 1, d.packBonusExpiryDays),
    packFreshReportCap: wholeAtLeast(get(LIFECYCLE_KEYS.packFreshReportCap), 0, d.packFreshReportCap),
    packEarlyOfferPence: wholeAtLeast(get(LIFECYCLE_KEYS.packEarlyOfferPence), 0, d.packEarlyOfferPence),
    packPicksPauseDays: wholeAtLeast(get(LIFECYCLE_KEYS.packPicksPauseDays), 1, d.packPicksPauseDays),
    placesCacheDays: wholeAtLeast(get(LIFECYCLE_KEYS.placesCacheDays), 0, d.placesCacheDays),
    packPayingHeadlineFloorPct: pctOr(get(LIFECYCLE_KEYS.packPayingHeadlineFloorPct), d.packPayingHeadlineFloorPct),
    packPayingHeadlineTargetPct: pctOr(get(LIFECYCLE_KEYS.packPayingHeadlineTargetPct), d.packPayingHeadlineTargetPct),
    packPayingRundownPaidFloorPct: pctOr(get(LIFECYCLE_KEYS.packPayingRundownPaidFloorPct), d.packPayingRundownPaidFloorPct),
    packPayingRundownPaidTargetPct: pctOr(get(LIFECYCLE_KEYS.packPayingRundownPaidTargetPct), d.packPayingRundownPaidTargetPct),
    packCostTargetPence: wholeAtLeast(get(LIFECYCLE_KEYS.packCostTargetPence), 0, d.packCostTargetPence),
    packCostCeilingPence: wholeAtLeast(get(LIFECYCLE_KEYS.packCostCeilingPence), 0, d.packCostCeilingPence),
    homeBlockerCardDay: wholeAtLeast(get(LIFECYCLE_KEYS.homeBlockerCardDay), 0, d.homeBlockerCardDay),
    quizShorterFrom: parseDateSetting(get(LIFECYCLE_KEYS.quizShorterFrom)),
  };
}

function pctOr(raw: unknown, fallback: number): number {
  const n = wholeAtLeast(raw, 0, fallback);
  return n <= 100 ? n : fallback;
}

/** The pack's free part: the credit it gives beyond what was paid. */
export function starterPackBonusPence(s: Pick<LifecycleSettings, 'starterPackPricePence' | 'starterPackCreditPence'>): number {
  return Math.max(0, s.starterPackCreditPence - s.starterPackPricePence);
}

function time(iso: string | Date | null | undefined): number | null {
  if (!iso) return null;
  const t = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * The accounts a change of cutover strands: when it moves later (or is
 * cleared), accounts created from the old cutover up to the new one were
 * decided as pack accounts (no welcome credit) and are now before it, so
 * their welcome check must be made again. Null when nobody is stranded: a
 * first cutover, one moved earlier (those accounts already had the £20, and
 * the pack is never offered to anyone who did) or no change.
 */
export function strandedByCutoverMove(oldFrom: string | null, newFrom: string | null): { from: string; to: string | null } | null {
  const was = time(oldFrom);
  if (was === null) return null;
  const now = time(newFrom);
  if (now !== null && now <= was) return null;
  return { from: new Date(was).toISOString(), to: now === null ? null : new Date(now).toISOString() };
}

/** The welcome credit's grant (src/lib/credit/welcome.ts): one per account, found by this source_ref. */
export function welcomeGrantRef(userId: string): string {
  return `welcome:${userId}`;
}

/**
 * Is this an account the starter pack is for (created at or after the
 * cutover)? False whenever the cutover is not set or the date is unreadable,
 * so an account whose age is unknown keeps the old welcome credit.
 */
export function isPackAccount(createdAt: string | Date | null | undefined, s: Pick<LifecycleSettings, 'starterPackFrom'>): boolean {
  const cutover = time(s.starterPackFrom);
  const created = time(createdAt);
  return cutover !== null && created !== null && created >= cutover;
}
