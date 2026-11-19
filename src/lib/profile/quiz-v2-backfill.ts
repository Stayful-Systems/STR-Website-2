/**
 * The one-off move of existing profiles onto the shorter quiz (Batch 30), and
 * what its dry run prints. Run it straight after the release, before the first
 * rate sync (market-warm, 04:45 UK) and the 07:00 sourcing run. A real run that
 * leaves nothing behind stamps billing_settings.quiz_v2_backfill_done_at, and
 * the rate sync waits for that stamp (Review R4, R4-33). Per profile
 * (the member's live profiles.market_goals and every saved search_profiles.criteria):
 *
 *   setup     a profile that held an OLD setup answer (under £3k, £3–6k, £6–10k,
 *             £10k+) is written on the new bands, and keeps judging on it as a
 *             nice-to-have (filter_modes.setup = 'nice', unless the member already
 *             chose) — what it did before. Review R4 (R4-02): setup cash is now a
 *             nice-to-have for everyone by default, so the switch only pins that.
 *   cash      a buyer with a budget but no Buying cash answer gets the band that
 *             budget points to (cashBandFromBudget); Review R4 (R4-43): an older
 *             Buy to let member with no budget, the band their Buy to let cash band
 *             points to (cashBandFromBtl). Marked cashFromBudget: shown on the
 *             profile page as worked out, never a filter (no answered mark is written).
 *   rate      a profile whose member gave a real finance answer, or whose rate is
 *             not the house 5.5%, keeps it: finance.rateSet = true, so today's
 *             average never overwrites it. Only while no average has been synced
 *             yet (finance.rateAsOf is null), so a profile the daily sync has
 *             already moved is never mistaken for one the member chose.
 *
 * Idempotent: each rule fires only on what it moves (an old setup value, a missing
 * cash band, an unsynced unset rate), so a second run changes nothing. Nothing
 * printed is an address, a postcode, an email or a listing: short ids and option keys.
 *
 * Pure: no network, no database, no server-only.
 */
import { DEFAULT_FINANCE_GOALS, LEGACY_SETUP_BUDGET, parseMarketGoals, type MarketGoals } from '../market/goals.ts';
import type { FilterModes } from '../tailoring/profile.ts';
import type { AboutYou } from './about.ts';
import { cashBandFromBtl, cashBandFromBudget } from './buying-power.ts';
import { dealTypesFor } from './deal-types.ts';
import type { AnsweredMap } from './state.ts';

export interface QuizV2Before {
  setup: string | null;
  budget: string | null;
  brrrBudget: string | null;
  cash: string | null;
  rate: number;
  rateSet: boolean;
  rateAsOf: string | null;
  setupMode: string | null;
}

export interface QuizV2After {
  setup: string | null;
  setupMode: 'nice' | null;
  cash: string | null;
  cashFromBudget: boolean;
  rateSet: boolean | null;
}

export type QuizV2Outcome = { status: 'map'; goals: MarketGoals; modes: FilterModes | null; after: QuizV2After } | { status: 'already' | 'no_goals' };

/** The stored setup answer as written (an old band is a string the new vocabulary does not hold). */
function rawSetup(raw: unknown): string | null {
  const r = raw && typeof raw === 'object' ? ((raw as Record<string, unknown>).r2r as Record<string, unknown> | undefined) : undefined;
  return typeof r?.setupBudget === 'string' ? r.setupBudget : null;
}

export function beforeOf(raw: unknown, modes: FilterModes | null): QuizV2Before | null {
  const g = parseMarketGoals(raw);
  if (!g) return null;
  return { setup: rawSetup(raw), budget: g.budget, brrrBudget: g.brrr.budget, cash: g.buyer.cashAvailable, rate: g.finance.mortgageRatePct, rateSet: g.finance.rateSet, rateAsOf: g.finance.rateAsOf, setupMode: modes?.setup ?? null };
}

/**
 * What one profile becomes. `raw`: the stored goals as read (the parsed form
 * hides an old setup value). `modes`: its filter_modes, or null when they cannot
 * be stored (no profile row yet). `marks`: its quiz marks.
 */
export function backfillQuizV2(raw: unknown, about: AboutYou | null, marks: AnsweredMap, modes: FilterModes | null): QuizV2Outcome {
  const goals = parseMarketGoals(raw);
  if (!goals) return { status: 'no_goals' };
  let next = goals;
  let changed = false;

  // Setup: an old band becomes the nearest new one (parse already read it so) and stays a nice-to-have.
  const old = rawSetup(raw);
  const legacy = old !== null && Object.prototype.hasOwnProperty.call(LEGACY_SETUP_BUDGET, old);
  let nextModes: FilterModes | null = null;
  if (legacy) {
    changed = true;
    if (modes && modes.setup === undefined) nextModes = { ...modes, setup: 'nice' };
  }

  // Cash: a buyer with a budget and no cash answer; Review R4 (R4-43): or, with no budget, a Buy to let cash band.
  const buys = dealTypesFor({ goals, about }).some((t) => t === 'buy_str' || t === 'brrr' || t === 'btl');
  const budget = goals.budget ?? goals.brrr.budget;
  if (buys && goals.buyer.cashAvailable === null && (budget || goals.btl.cashBand)) {
    const band = budget ? cashBandFromBudget(budget) : cashBandFromBtl(goals.btl.cashBand);
    if (band) {
      next = { ...next, buyer: { ...next.buyer, cashAvailable: band, cashFromBudget: true } };
      changed = true;
    }
  }

  // Rate: theirs when they gave a real finance answer or it is not the house figure, until an average has been synced.
  const f = goals.finance;
  const mark = marks.finance;
  const chose = (mark !== undefined && !mark.notSure) || f.mortgageRatePct !== DEFAULT_FINANCE_GOALS.mortgageRatePct;
  const keepRate = !f.rateSet && f.rateAsOf === null && chose;
  if (keepRate) {
    next = { ...next, finance: { ...next.finance, rateSet: true } };
    changed = true;
  }

  if (!changed) return { status: 'already' };
  return { status: 'map', goals: next, modes: nextModes, after: { setup: next.r2r.setupBudget, setupMode: nextModes?.setup === 'nice' ? 'nice' : null, cash: next.buyer.cashAvailable, cashFromBudget: next.buyer.cashFromBudget, rateSet: keepRate ? true : null } };
}

/** What the report totals. */
export function summarise(statuses: readonly ('map' | 'already' | 'no_goals')[]): { toMap: number; already: number; noGoals: number } {
  return { toMap: statuses.filter((s) => s === 'map').length, already: statuses.filter((s) => s === 'already').length, noGoals: statuses.filter((s) => s === 'no_goals').length };
}


/** Review R4 (R4-33): the "backfill done" stamp the rate sync waits for (listing/live-rate-sync.ts). */
export { QUIZ_V2_BACKFILL_DONE_KEY } from '../listing/live-rate-sync.ts';

/** A real run is done when every profile could be read and none was left for the next run. */
export function backfillDone(r: { profilesReadable: boolean; left: number; outOfTime: boolean }): boolean {
  return r.profilesReadable && r.left === 0 && !r.outOfTime;
}
