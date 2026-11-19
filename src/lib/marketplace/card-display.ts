/**
 * Batch 30: two short lines a deal card (and the deal page) shows next to the
 * profit range, so a member can always see how it was worked out:
 *
 *   "Using 5.4%, today's average · change"   the mortgage rate in the figures, from the
 *   "Using your 6% · change"                  finance on the profile (the daily average, or their own)
 *   "Low end used, as you asked"              which end of the range their minimum is judged on
 *   "Middle of the range used, as you asked"  (only when they have a minimum profit)
 *   "Top end used, as you asked"
 *   "Low end used"                            Review R4 (R4-04): with no answer to the new question
 *                                             (or one given before Batch 30), the end is named, never "as you asked"
 *
 * Nothing here changes a figure: the card, the page behind it and Today all
 * read the same finance and the same judgeDeal.
 *
 * Pure: no network, no database, no server-only.
 */
import { ratePctLabel } from '../listing/deal.ts';
import type { FinanceGoals } from '../market/goals.ts';
import { profitEndNote, wantsFor, type ProfitEnd } from '../tailoring/criteria.ts';
import type { TailoringProfile } from '../tailoring/profile.ts';

export interface CardDisplay {
  /** The rate line for a purchase at a mortgage (null for a cash buyer or no goals). */
  rateLine: string | null;
  /** True when the member typed their own rate: the card then offers "Use today's average". */
  rateSet: boolean;
  /** The end used for a sale / a rental, when the member has a minimum profit that judges it. */
  endSale: string | null;
  endRent: string | null;
  /** Review R4 (R4-03): the end the member is judged on, so "Most you can pay" sizes for the same end; null with no goals. */
  profitEnd: ProfitEnd | null;
}

export const NO_DISPLAY: CardDisplay = { rateLine: null, rateSet: false, endSale: null, endRent: null, profitEnd: null };

/** "Using 5.4%, today's average" / "Using your 6%" / "Using 5.5%, a typical rate" (no average has been synced yet). */
export function rateLineFor(finance: Pick<FinanceGoals, 'mortgageRatePct' | 'rateSet' | 'rateAsOf'> | null | undefined, cashBuyer: boolean): string | null {
  if (!finance || cashBuyer) return null;
  const rate = ratePctLabel(finance.mortgageRatePct);
  if (finance.rateSet) return `Using your ${rate}`;
  return finance.rateAsOf ? `Using ${rate}, today’s average` : `Using ${rate}, a typical rate`;
}

/** Both lines for this member, from their tailoring profile (null: neither). */
export function cardDisplayFor(tailoring: TailoringProfile | null | undefined, cashBuyer: boolean): CardDisplay {
  const g = tailoring?.goals;
  if (!tailoring || !g) return NO_DISPLAY;
  const w = wantsFor(tailoring);
  const end = profitEndNote(w.profitEnd, w.profitEndAsked);
  return { rateLine: rateLineFor(g.finance, cashBuyer), rateSet: g.finance.rateSet, endSale: w.minProfit !== null ? end : null, endRent: w.minProfitR2r !== null ? end : null, profitEnd: w.profitEnd };
}

/** Where "change" goes: the rate screen, then back to the page. */
export function changeRateHref(next: string): string {
  return `/welcome?q=finance&next=${encodeURIComponent(next)}`;
}
