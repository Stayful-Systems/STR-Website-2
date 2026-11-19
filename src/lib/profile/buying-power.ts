/**
 * Batch 30: what a member's Buying cash buys, in one place. The quiz asks how
 * much cash a member can put in (deposit, stamp duty, furnishing) and turns it
 * into a price line ("With a mortgage, that's up to about £155,000"), a budget
 * ceiling for the older readers, and a Buy to let cash band. Nothing existing
 * works backwards from cash (most-you-can-pay.ts works back from profit), so
 * this is the one helper that does.
 *
 * Pure: no network, no database, no server-only.
 */
import { stampDutyLocal } from '../listing/stamp-duty.ts';
import { defaultSetupCost, DEFAULT_FINANCE } from '../listing/deal.ts';
import type { BuyerGoals, BtlGoals, GoalOption, MarketGoals } from '../market/goals.ts';
import type { Budget } from '../market/filters.ts';
import { TAILORING } from '../tailoring/config.ts';

export type CashBand = GoalOption<'cashAvailable'>;
export type FundingChoice = GoalOption<'funding'>;
type BtlBand = NonNullable<BtlGoals['cashBand']>;

/** The bedroom count the price line assumes for furnishing (a 2-bed, £13k). */
export const PRICE_LINE_BEDROOMS = 2;
/** The price line rounds down to this. */
export const PRICE_ROUND = 5_000;

/** Cash needed to buy at a price: deposit (all of it for a cash buyer), stamp duty, furnishing. */
export function cashNeededFor(price: number, cashBuyer: boolean): number {
  const deposit = cashBuyer ? price : (price * DEFAULT_FINANCE.depositPct) / 100;
  return deposit + stampDutyLocal(price, 'england').amount + defaultSetupCost(PRICE_LINE_BEDROOMS);
}

/**
 * The most a member can pay with this much cash, rounded down to £5k. The
 * cash needed only ever rises with the price, so a bisection finds the edge.
 * Zero when the cash does not cover even the furnishing.
 */
export function maxPriceForCash(cashTop: number, opts: { cashBuyer: boolean }): number {
  if (!Number.isFinite(cashTop) || cashNeededFor(0, opts.cashBuyer) > cashTop) return 0;
  let lo = 0;
  let hi = Math.max(cashTop * 8, 100_000); // 25% deposit means ≥ 4× the cash is never reached; 8× is safe headroom
  for (let i = 0; i < 60 && hi - lo > 1; i++) {
    const mid = (lo + hi) / 2;
    if (cashNeededFor(mid, opts.cashBuyer) <= cashTop) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo / PRICE_ROUND) * PRICE_ROUND;
}

/** The ceiling a band sets: its top, or for the open-ended band its floor (the "over about" case). */
function bandTop(band: CashBand): number {
  return TAILORING.cashAvailableTop[band] ?? 200_000;
}

/**
 * The older budget a cash answer implies: a ceiling only (decided). Up to
 * £100k → "Under £100k", up to £200k → "Under £200k" (the legacy value, still
 * valid), anything higher → no band, because a band's floor would cut cheaper
 * deals; the cash filter caps the price there instead.
 */
export function budgetFromCash(cashBand: CashBand | null, funding: FundingChoice | null): Exclude<Budget, 'any'> | null {
  if (!cashBand || TAILORING.cashAvailableTop[cashBand] === null) return null;
  const price = maxPriceForCash(bandTop(cashBand), { cashBuyer: funding === 'cash' });
  if (price <= 100_000) return 'u100';
  if (price <= 200_000) return 'u200';
  return null;
}

/** The Buy to let cash band whose top is at or below the cash band's top (decided), so the benchmark keeps working. */
export function btlBandFromCash(cashBand: CashBand | null): BtlBand | null {
  switch (cashBand) {
    case 'u30':
      return 'under_25k';
    case '30-60':
      return '25k_50k';
    case '60-100':
      return '50k_100k';
    case '100-200':
    case '200+':
      return '100k_plus';
    default:
      return null;
  }
}

/**
 * Review R4 (R4-43): the Buying cash band an older Buy to let member's cash band points to: the smallest band
 * that covers its top (the open £100k+ band: £100–200k). Worked out, not answered: the caller marks it
 * cashFromBudget, so it is shown on the profile page and never filters.
 */
export function cashBandFromBtl(band: BtlBand | null): CashBand | null {
  switch (band) {
    case 'under_25k':
      return 'u30';
    case '25k_50k':
      return '30-60';
    case '50k_100k':
      return '60-100';
    case '100k_plus':
      return '100-200';
    default:
      return null;
  }
}

/** A budget band's top price (null: open-ended). */
const BUDGET_TOP: Record<Exclude<Budget, 'any'>, number | null> = { u100: 100_000, '100-200': 200_000, u200: 200_000, '200-350': 350_000, '350-500': 500_000, '500+': null };

/**
 * The cash band a budget-only member's budget points to: 25% deposit, stamp
 * duty and a 2-bed's furnishing on the band's top, then the smallest cash band
 * that covers it. Worked out, not answered: the caller marks it cashFromBudget.
 */
export function cashBandFromBudget(budget: Exclude<Budget, 'any'> | null): CashBand | null {
  if (!budget) return null;
  const top = BUDGET_TOP[budget];
  if (top === null) return '200+';
  const needed = cashNeededFor(top, false);
  const bands: CashBand[] = ['u30', '30-60', '60-100', '100-200'];
  return bands.find((b) => needed <= (TAILORING.cashAvailableTop[b] as number)) ?? '200+';
}

/** The member's real Buying cash ceiling: null when unanswered or only worked out from a budget. */
export function buyingCashTop(goals: { buyer: Pick<BuyerGoals, 'cashAvailable' | 'cashFromBudget'> } | Pick<MarketGoals, 'buyer'>): number | null {
  const { cashAvailable, cashFromBudget } = goals.buyer;
  if (!cashAvailable || cashFromBudget) return null;
  return TAILORING.cashAvailableTop[cashAvailable];
}

/** £155,000 */
function gbp(n: number): string {
  return `£${n.toLocaleString('en-GB')}`;
}

/** The line under the chosen cash band: what it buys with a mortgage, or with cash. */
export function priceLine(cashBand: CashBand | null, funding: FundingChoice | null): string | null {
  if (!cashBand) return null;
  const cashBuyer = funding === 'cash';
  const price = maxPriceForCash(bandTop(cashBand), { cashBuyer });
  if (price <= 0) return null;
  const open = TAILORING.cashAvailableTop[cashBand] === null;
  const how = cashBuyer ? 'With cash,' : "With a mortgage, that's";
  return `${how} ${open ? 'over' : 'up'} ${open ? 'about' : 'to about'} ${gbp(price)}.`;
}
