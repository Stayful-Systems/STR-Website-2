/**
 * Batch 27: the new value a Stayful Intelligence profile change makes from
 * the member's answers, with its words, or why it can't (steps-server.ts
 * previewCriteria saves it through the profile editor's own save).
 *
 * Review R4 (Zac, 19 Nov 2026):
 *   - R4-07  "budget under £X" sets a price ceiling of £X only. Buying cash is
 *            left as it is (it used to be turned into a cash band priced on
 *            a mortgage, whatever the member's funding). A ceiling is one the
 *            profile can hold: under £100k or under £200k (BUDGET_LABELS); any
 *            other figure is refused with words that say so.
 *   - R4-08  Buying cash, R2R setup cash and what the member is after from
 *            buy to let may be changed too. Each is undone exactly (undo.ts).
 *
 * Pure: no network, no database, no server-only.
 */
import { currentValue, questionById, type Answers } from '../profile/questions.ts';
import { BUDGET_LABELS, type Budget } from '../market/filters.ts';
import { DEAL_TYPE_LABELS, typesShown } from '../profile/deal-types.ts';
import type { CriteriaQuestion } from './config.ts';
import { areaCodes, dealTypeOf } from './validate.ts';

export type NextValue = { value: unknown; label: string } | { reason: 'bad_value' | 'already_there' | 'not_areas_mode'; message?: string };

const gbp = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;

/** "£8k", "8,000", "900pcm": a whole figure in pounds, or null. */
export function asNumber(v: string): number | null {
  const s = v.trim().toLowerCase().replace(/[£,\s]/g, '').replace(/pcm|amonth|pm$/g, '');
  const m = /^(\d+(?:\.\d+)?)(k)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) ? n : null;
}

/** An option's words, from the question's own list ("£30–60k"). */
function optionLabel(questionId: string, value: string): string {
  const options = questionById(questionId)?.options;
  return (Array.isArray(options) ? (options as readonly { value: string; label: string }[]).find((o) => o.value === value)?.label : undefined) ?? value;
}

/** A value given as one of the question's own options: its code, or its words in any case. */
function optionOf(questionId: string, raw: string): string | null {
  const options = questionById(questionId)?.options;
  if (!Array.isArray(options)) return null;
  const v = raw.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/\s*[–-]\s*/g, '-');
  for (const o of options as readonly { value: string; label: string }[]) {
    if (o.value.toLowerCase() === v || o.label.toLowerCase().replace(/[‘’]/g, "'").replace(/\s*[–-]\s*/g, '-') === v) return o.value;
  }
  return null;
}

/** The price ceilings a profile can hold (a ceiling only: no floor), by their top. */
export const PRICE_CEILINGS: readonly { top: number; budget: Exclude<Budget, 'any'> }[] = [
  { top: 100_000, budget: 'u100' },
  { top: 200_000, budget: 'u200' },
];

/** Review R4 (R4-07): the budget a "budget under £X" sets: the ceiling at exactly £X, or null when the profile has none there. */
export function priceCeilingFor(raw: string): Exclude<Budget, 'any'> | null {
  const v = raw.trim().toLowerCase();
  const code = PRICE_CEILINGS.find((c) => c.budget === v);
  if (code) return code.budget;
  const n = asNumber(v.replace(/^(under|up to|below|less than|max(imum)?)\s*/, ''));
  if (n === null) return null;
  return PRICE_CEILINGS.find((c) => c.top === Math.round(n))?.budget ?? null;
}

const CEILING_WORDS = `I can set a price ceiling of ${PRICE_CEILINGS.map((c) => `£${Math.round(c.top / 1000)}k`).join(' or ')}. For a different figure, I can change your Buying cash instead.`;

/** The Buying cash band a figure falls in ("£45k" → £30–60k). */
function cashBandForFigure(n: number): string {
  if (n < 30_000) return 'u30';
  if (n <= 60_000) return '30-60';
  if (n <= 100_000) return '60-100';
  if (n <= 200_000) return '100-200';
  return '200+';
}

/** The R2R setup cash band a figure falls in ("£8k" → under £10k). */
function setupBandForFigure(n: number): string {
  if (n < 10_000) return 'u10k';
  if (n <= 15_000) return '10-15k';
  if (n <= 20_000) return '15-20k';
  return '20k+';
}

const PRIORITY_WORDS: Record<string, readonly string[]> = {
  income: ['income', 'money each month', 'cashflow', 'cash flow', 'monthly income', 'rental income', 'yield'],
  growth: ['growth', 'value going up', 'capital growth', 'prices rising'],
  both: ['both', 'a bit of both', 'mix', 'balance'],
};

/** The new value a change makes from the member's answers, with its words; or why it can't. */
export function nextValue(q: CriteriaQuestion, raw: string, a: Answers): NextValue {
  switch (q) {
    case 'bedrooms': {
      const n = asNumber(raw.replace(/\+|beds?|bedrooms?/gi, ''));
      if (n !== 1 && n !== 2 && n !== 3 && n !== 4) return { reason: 'bad_value' };
      return { value: n, label: `Bedrooms: ${n === 4 ? '4 or more' : `${n} bed`}` };
    }
    case 'budget': {
      // Review R4 (R4-07): a price ceiling only; Buying cash is never touched here.
      const budget = priceCeilingFor(raw);
      if (!budget) return { reason: 'bad_value', message: CEILING_WORDS };
      if (a.goals.budget === budget) return { reason: 'already_there' };
      return { value: budget, label: `Price ceiling: ${BUDGET_LABELS[budget].toLowerCase()}` };
    }
    case 'cash_available': {
      const n = asNumber(raw);
      const band = optionOf('cash_available', raw) ?? (n !== null ? cashBandForFigure(n) : null);
      if (!band) return { reason: 'bad_value' };
      if (band === a.goals.buyer.cashAvailable && !a.goals.buyer.cashFromBudget) return { reason: 'already_there' };
      return { value: band, label: `Buying cash: ${optionLabel('cash_available', band)}` };
    }
    case 'setup_budget': {
      const n = asNumber(raw);
      const band = optionOf('setup_budget', raw) ?? (n !== null ? setupBandForFigure(n) : null);
      if (!band) return { reason: 'bad_value' };
      if (band === a.goals.r2r.setupBudget) return { reason: 'already_there' };
      return { value: band, label: `R2R setup cash: ${optionLabel('setup_budget', band)}` };
    }
    case 'btl_priority': {
      const v = raw.trim().toLowerCase();
      const priority = optionOf('btl_priority', raw) ?? Object.entries(PRIORITY_WORDS).find(([, words]) => words.includes(v))?.[0] ?? null;
      if (!priority) return { reason: 'bad_value' };
      if (priority === a.goals.btl.priority) return { reason: 'already_there' };
      return { value: priority, label: `Buy to let, what you’re after: ${optionLabel('btl_priority', priority)}` };
    }
    case 'min_profit':
    case 'r2r_min_profit': {
      const n = asNumber(raw);
      if (n === null) return { reason: 'bad_value' };
      return { value: Math.round(n), label: `${q === 'r2r_min_profit' ? 'Rent-to-rent minimum profit' : 'Minimum profit'}: ${gbp(n)} a month` };
    }
    case 'property_type': {
      const v = raw.trim().toLowerCase();
      if (v !== 'flat' && v !== 'house' && v !== 'either') return { reason: 'bad_value' };
      return { value: v, label: `Property type: ${v === 'either' ? 'flat or house' : v}` };
    }
    case 'add_deal_type':
    case 'remove_deal_type': {
      const type = dealTypeOf(raw);
      if (!type) return { reason: 'bad_value' };
      const shown = typesShown({ goals: a.goals, about: a.about }) as string[];
      const next = q === 'add_deal_type' ? (shown.includes(type) ? null : [...shown, type]) : shown.filter((t) => t !== type);
      if (next === null) return { reason: 'already_there' };
      if (next.length === 0 || next.length === shown.length) return { reason: q === 'remove_deal_type' && next.length === shown.length ? 'already_there' : 'bad_value' };
      return { value: next, label: `Deal types: ${next.map((t) => DEAL_TYPE_LABELS[t as keyof typeof DEAL_TYPE_LABELS] ?? t).join(', ')}` };
    }
    case 'add_areas': {
      const where = currentValue('where', a) as { mode?: string; areas?: string[] } | null;
      if (!where || where.mode !== 'areas') return { reason: 'not_areas_mode' };
      const current = Array.isArray(where.areas) ? where.areas : [];
      const extra = areaCodes(raw).filter((x) => !current.includes(x));
      if (extra.length === 0) return { reason: 'already_there' };
      const areas = [...current, ...extra];
      return { value: { ...where, mode: 'areas', areas }, label: `Areas: ${areas.join(', ')}` };
    }
  }
}
