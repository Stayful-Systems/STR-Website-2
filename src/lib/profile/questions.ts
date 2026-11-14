/**
 * The profile quiz: every question, in the order it is asked, with its
 * "why we ask" line, its photo, its answers and where each answer is stored.
 *
 * Section A ("about you") is asked of everyone and stored on
 * profiles.about_you (about.ts); "which deals do you want to see?", the
 * "where" and money questions and Sections B–E are search criteria, stored on
 * profiles.market_goals (goals.ts). Which follow-ups a profile gets follows
 * the deal types it chose (Batch 17, deal-types.ts): the buyer's for Buy and
 * let or BRRR (asked once), BRRR's own for BRRR, the rent-to-rent ones for
 * Rent-to-rent; the sourcing and management sections follow the roles ticked.
 * The mandatory questions — which describes you, which deals, where should we
 * look, and one money question per chosen type — gate the rest of the app
 * (src/lib/profile/state.ts); every other question can be answered "Not sure".
 *
 * Batch 30 shortened the quiz: "what are you looking for" merged the old
 * "which describes you" and "which deals" questions, the two money questions
 * became Buying cash and R2R setup cash, and several pairs became one
 * (stage, property, short-let rules). Every older question id is kept as a
 * RETIRED question: never asked, still parsed, still stored and read, so no
 * member loses a filter or progress (MARKS_WRITTEN, PREDECESSORS below).
 *
 * This module also does the two translations the quiz needs: an answer
 * (applyAnswer) into new goals / about-you objects, and stored values back
 * into a label for the profile page (answerLabel). Both are pure and tested.
 * Nothing here ranks or filters: the only thing an answer changes in Batch 12
 * is the match count (matching.ts); Batch 14 decides what each one does.
 */
import {
  BREAK_EVEN_OPTIONS,
  DISTANCE_MILES,
  GROWTH_OPTIONS,
  MAX_RENT_PCM_RANGE,
  PAYBACK_OPTIONS,
  areaCodeList,
  goalOption,
  normalisePostcode,
  parseFinanceGoals,
  parseMaxDistance,
  parseMaxRentPcm,
  type BuyerGoals,
  type DealType,
  type MarketGoals,
  type ProfilePath,
  type R2rGoals,
  type SourcerGoals,
  type ManagerGoals,
} from '../market/goals.ts';
import { BUDGET_CHOICES, BUDGET_LABELS, isBudget } from '../market/filters.ts';
import { DEFAULT_FINANCE } from '../listing/deal.ts';
import { areaMetaForCode } from '../market/areas.ts';
import { ABOUT_OPTIONS, DEFAULT_ABOUT, RISK_TO_APPETITE, ROLE_OPTIONS, STAGE_TO_ABOUT, TIME_TO_MANAGEMENT, aboutOption, pathFor, roleList, stageOf, type AboutYou, type Role } from './about.ts';
import { btlBandFromCash, budgetFromCash, priceLine } from './buying-power.ts';
import { AVAILABLE_DEAL_TYPES, availableTypes, COMING_SOON_DEAL_TYPES, DEAL_TYPE_LABELS, DEAL_TYPE_LONG_LABELS, DEAL_TYPES, dealTypesFor, isAvailableDealType, kindsFor } from './deal-types.ts';
import type { ImageKey } from './images.ts';

export type SectionId = 'about' | 'buy' | 'r2r' | 'source' | 'manage';

export const SECTION_TITLES: Record<SectionId, string> = { about: 'About you', buy: 'Buying', r2r: 'Rent-to-rent', source: 'Sourcing', manage: 'Your management company' };

export const PATH_LABELS: Record<ProfilePath, string> = { buy: 'Buying', r2r: 'Rent-to-rent', source: 'Sourcing', manage: 'Management company' };

/**
 * The section as the activity log records it. 'r2r' reads like a UK outcode
 * to the log's own filter (src/lib/activity/event.ts) and would be dropped,
 * so every section goes in as a word.
 */
export const SECTION_TOKENS: Record<SectionId, string> = { about: 'about', buy: 'buying', r2r: 'rent_to_rent', source: 'sourcing', manage: 'management' };

export type QuestionId =
  | 'roles'
  | 'deal_types'
  | 'where'
  | 'budget'
  | 'brrr_budget'
  | 'max_rent'
  | 'btl_priority'
  | 'btl_cash'
  | 'deals_done'
  | 'units_now'
  | 'unit_areas'
  | 'time'
  | 'next_deal'
  | 'deals_wanted'
  | 'blocker'
  | 'risk'
  | 'cash_available'
  | 'funding'
  | 'finance'
  | 'entity'
  | 'main_goal'
  | 'min_profit'
  | 'property_type'
  | 'bedrooms'
  | 'brrr_work'
  | 'leasehold'
  | 'restricted_areas'
  | 'r2r_min_profit'
  | 'setup_budget'
  | 'deal_structure'
  | 'break_even'
  | 'payback'
  | 'furnished'
  | 'sourcing_fee'
  | 'deals_per_month'
  | 'motivated_sellers'
  | 'units_managed'
  | 'operating_areas'
  | 'looking_for'
  | 'growth_target'
  // Batch 30
  | 'stage'
  | 'property'
  | 'short_let_rules';

/**
 *   single   one tap card
 *   multi    tick all that apply
 *   where    a mode, plus a postcode and radius or a list of areas
 *   budget   the purchase budget bands
 *   rent     a monthly rent: presets or typed
 *   finance  deposit % and mortgage rate, prefilled
 *   profit   a £ per month, presets or typed
 *   areas    postcode areas picked from the list
 *   property Batch 30: flat / house / either, then the bedrooms; both required
 */
export type QuestionKind = 'single' | 'multi' | 'where' | 'budget' | 'rent' | 'finance' | 'profit' | 'areas' | 'property';

/** Everything an answer can be read from or written to. */
export interface Answers {
  goals: MarketGoals;
  about: AboutYou;
  /** saved_areas: the "specific areas" answer, which the picks and the grid already read. */
  savedAreas: string[];
}

export interface Option {
  value: string;
  label: string;
  help?: string;
  /** A photo on the answer card itself ('plain' draws the card without one). */
  image?: ImageKey | 'plain';
  /** Shown greyed out with this badge ("Coming soon"), never selectable, and never ticked by "All of them". */
  soon?: string;
}

type Text = string | ((a: Answers) => string);

export interface Question {
  id: QuestionId;
  section: SectionId;
  kind: QuestionKind;
  title: Text;
  /** The one-line "Why we ask". */
  why: Text;
  /** The photo above the question, or 'cards' when the answer cards carry the photos. */
  image: ImageKey | ((a: Answers) => ImageKey) | 'cards';
  /** Short label for the profile page row. */
  short: string;
  options?: readonly Option[] | ((a: Answers) => readonly Option[]);
  /** The three that gate the app. Everything else can be "Not sure". */
  mandatory?: boolean;
  /** Changing it moves the match count. */
  affectsMatch?: boolean;
  /** Whether it is asked of this member. Default: everyone. */
  applies?: (a: Answers) => boolean;
  /** For 'rent' and 'profit': the preset amounts. */
  presets?: readonly number[];
  /** For 'multi': the option that ticks every other one ("All of them"). */
  allOption?: string;
  /** Batch 30: for 'multi' with an allOption, the values "All of them" ticks (default: every option). */
  allCovers?: readonly string[];
  /** Batch 30: a small heading above the title ("Rent-to-rent", "Buying"). */
  label?: Text;
  /**
   * Batch 30: not asked of anyone any more. Kept so its id still parses and its
   * stored answer is still read. 'editable': the profile page, chat, what-if,
   * the Home card and a rate "change" link can still save it (the server
   * accepts it though it is not in the member's questions).
   */
  retired?: true | 'editable';
  /** Batch 30: a line shown under the chosen answer, from the answer and the member's other answers. */
  lineFor?: (value: string, a: Answers) => string | null;
}

export const RENT_PRESETS_PCM: readonly number[] = [1000, 1500, 2000, 3000];
export const PROFIT_PRESETS_PCM: readonly number[] = [300, 500, 800, 1000];
export const MIN_PROFIT_RANGE = { min: 0, max: 20_000 } as const;

const opt = (value: string, label: string, help?: string, image?: Option['image']): Option => ({ value, label, ...(help ? { help } : {}), ...(image ? { image } : {}) });

const ROLE_LABELS: Record<(typeof ROLE_OPTIONS)[number], string> = { investor: 'Investor buying', r2r: 'Rent-to-rent operator', sourcer: 'Deal sourcer', manager: 'Management company', exploring: 'Just exploring' };

/** The deal types this profile wants (chosen, or mapped from older answers until it chooses). */
const typesOf = (a: Answers): DealType[] => dealTypesFor({ goals: a.goals, about: a.about });

/** Asked when the profile wants any of these types. */
const wants = (...types: DealType[]) => (a: Answers) => typesOf(a).some((t) => types.includes(t));

const hasRole = (role: Role) => (a: Answers) => a.about.roles.includes(role);

/**
 * Whose money a budget question is about: the member's own, unless they only
 * source (their clients') or only manage (the deals they take on). Anyone who
 * also invests or runs rent-to-rent answers for themselves.
 */
function budgetVoice(a: Answers): 'own' | 'clients' | 'manager' {
  const r = a.about.roles;
  if (r.includes('investor') || r.includes('r2r')) return 'own';
  if (r.includes('sourcer')) return 'clients';
  if (r.includes('manager')) return 'manager';
  return 'own';
}

/** The "All of them" option of "What are you looking for?". */
export const ALL_DEAL_TYPES = 'all';
/** Batch 30: the three ticks of "What are you looking for?" that are roles, not deal types. */
export const SOURCE_TICK = 'source';
export const MANAGE_TICK = 'manage';
export const EXPLORING_TICK = 'exploring';

/** The line under each deal type in the question. */
const DEAL_TYPE_HELP: Record<DealType, string> = {
  buy_str: 'Buy a property that’s ready to go, and run it as a holiday let',
  brrr: 'A property that needs work, priced for it',
  r2r: 'Rent from a landlord and let it short-term',
  btl: 'Buy a property and let it to long-term tenants',
};

/** Batch 28: "What are you after?" (btl/rules.ts BTL_PRIORITY_LABELS) and the cash bands (btl_bands' default edges). */
const BTL_PRIORITY_OPTIONS: readonly Option[] = [opt('income', 'Money each month', 'The best cashflow for the cash you put in'), opt('growth', 'Value going up', 'Where prices have been rising'), opt('both', 'A bit of both')];
const BTL_CASH_OPTIONS: readonly Option[] = [opt('under_25k', 'Under £25k'), opt('25k_50k', '£25k to £50k'), opt('50k_100k', '£50k to £100k'), opt('100k_plus', '£100k or more')];

// Batch 22c: five brackets, "Under £200k" split in two. A stored 'u200' is still accepted and labelled "Under £200k", never offered.
const BUDGET_OPTIONS: readonly Option[] = BUDGET_CHOICES.map((b) => opt(b, BUDGET_LABELS[b]));

const DEFINITIONS: readonly Question[] = [
  // ── Section A: about you ──
  {
    id: 'roles',
    section: 'about',
    kind: 'multi',
    title: 'Which describes you?',
    why: 'So we show you deals that fit how you actually do property.',
    image: 'roles',
    short: 'What you do',
    options: ROLE_OPTIONS.map((r) => opt(r, ROLE_LABELS[r])),
    mandatory: true,
  },
  {
    id: 'deal_types',
    section: 'about',
    kind: 'multi',
    title: 'What are you looking for?',
    why: 'Tick everything. I’ll only ask what each one needs.',
    image: 'deal_types',
    short: 'What you’re looking for',
    // Batch 30: the older "Which describes you?" and "Which deals?" in one. The first four are
    // deal types; "All of them" ticks those four; the last three are roles that are not a deal type.
    options: [
      opt('buy_str', 'Buy a ready short-let', DEAL_TYPE_HELP.buy_str),
      opt('brrr', 'Buy a project (BRRR)', DEAL_TYPE_HELP.brrr),
      opt('r2r', 'Rent-to-rent', DEAL_TYPE_HELP.r2r),
      opt('btl', 'Buy to let', DEAL_TYPE_HELP.btl),
      opt(ALL_DEAL_TYPES, 'All of them'),
      opt(SOURCE_TICK, 'I source deals for clients'),
      opt(MANAGE_TICK, 'I run a management company'),
      opt(EXPLORING_TICK, 'Just exploring'),
    ],
    allOption: ALL_DEAL_TYPES,
    allCovers: ['buy_str', 'brrr', 'r2r', 'btl'],
    mandatory: true,
    affectsMatch: true,
  },
  {
    id: 'where',
    section: 'about',
    kind: 'where',
    title: 'Where should we look?',
    why: 'So your deals are somewhere you’d actually buy or run.',
    image: 'where',
    short: 'Where to look',
    options: [
      opt('near', 'Near me', 'Your home or your current units, and how far you’d go'),
      opt('areas', 'Specific areas', 'Pick from Stayful’s ranked areas'),
      opt('anywhere', 'Most profitable anywhere in the UK', 'No area limit, just the strongest numbers'),
      opt('near_plus_best', 'Near me + the best elsewhere', 'Your area first, plus the strongest deals anywhere'),
    ],
    mandatory: true,
    affectsMatch: true,
  },
  {
    id: 'budget',
    section: 'about',
    kind: 'budget',
    title: (a) => (budgetVoice(a) === 'clients' ? 'What do your clients typically spend?' : budgetVoice(a) === 'manager' ? 'What’s the budget for deals you take on?' : 'What’s your budget?'),
    why: (a) => (budgetVoice(a) === 'clients' ? 'So we find deals your clients can actually buy.' : budgetVoice(a) === 'manager' ? 'So we pitch deals at the right price for you.' : 'So every deal is one you could actually buy.'),
    image: (a) => (budgetVoice(a) === 'clients' ? 'budget_source' : budgetVoice(a) === 'manager' ? 'budget_manage' : 'budget_buy'),
    short: 'Short-let budget',
    options: BUDGET_OPTIONS,
    mandatory: true,
    affectsMatch: true,
    applies: wants('buy_str'),
  },
  {
    id: 'brrr_budget',
    section: 'about',
    kind: 'budget',
    title: (a) => (budgetVoice(a) === 'clients' ? 'What would your clients pay for a project, before works?' : 'What’s the most you’d pay for a project, before works?'),
    why: 'The works come on top, so a project’s price is judged on its own.',
    image: 'brrr_budget',
    short: 'Project budget',
    options: BUDGET_OPTIONS,
    mandatory: true,
    affectsMatch: true,
    applies: wants('brrr'),
  },
  {
    id: 'max_rent',
    section: 'about',
    kind: 'rent',
    title: (a) => (budgetVoice(a) === 'clients' ? 'What’s the most rent your clients would pay a landlord each month?' : 'What’s the most rent you’d pay a landlord each month?'),
    why: (a) => (budgetVoice(a) === 'clients' ? 'So we find deals your clients will actually take on.' : 'So we never show you a rent you wouldn’t pay.'),
    image: (a) => (budgetVoice(a) === 'clients' ? 'client_rent' : 'max_rent'),
    short: 'Max rent',
    presets: RENT_PRESETS_PCM,
    mandatory: true,
    affectsMatch: true,
    applies: wants('r2r'),
  },
  // Batch 28: Buy to let's two answers, asked once and only for a profile that chose it.
  {
    id: 'btl_priority',
    section: 'about',
    kind: 'single',
    title: 'What are you after?',
    why: 'Buy to let deals are judged on what you want from them.',
    image: 'main_goal',
    short: 'Buy to let: what you’re after',
    options: BTL_PRIORITY_OPTIONS,
    mandatory: true,
    affectsMatch: true,
    applies: wants('btl'),
  },
  {
    id: 'btl_cash',
    section: 'about',
    kind: 'single',
    title: 'How much cash can you put in?',
    why: 'Deposit, tax and buying costs: so every buy-to-let deal is one you could fund.',
    image: 'cash_available',
    short: 'Buy to let: cash in',
    options: BTL_CASH_OPTIONS,
    mandatory: true,
    affectsMatch: true,
    applies: wants('btl'),
  },
  {
    id: 'deals_done',
    section: 'about',
    kind: 'single',
    title: 'How many deals have you done so far?',
    why: 'So we explain as much or as little as you need.',
    image: 'deals_done',
    short: 'Deals done',
    options: [opt('0', 'None yet'), opt('1-3', '1 to 3'), opt('4-10', '4 to 10'), opt('10+', 'More than 10')],
  },
  {
    id: 'units_now',
    section: 'about',
    kind: 'single',
    title: 'How many short-let units do you own or run now?',
    why: 'Bigger operators need different deals from first-timers.',
    image: 'units_now',
    short: 'Units now',
    options: [opt('0', 'None'), opt('1-2', '1 or 2'), opt('3-5', '3 to 5'), opt('6-15', '6 to 15'), opt('16+', '16 or more')],
  },
  {
    id: 'unit_areas',
    section: 'about',
    kind: 'areas',
    title: 'Where are your current units?',
    why: 'Deals near what you already run are cheaper to clean and manage.',
    image: 'unit_areas',
    short: 'Where your units are',
    applies: (a) => a.about.unitsNow !== null && a.about.unitsNow !== '0',
  },
  {
    id: 'time',
    section: 'about',
    kind: 'single',
    title: 'How much time can you give it?',
    why: 'Hands-off investors need deals that work with a manager’s fees.',
    image: 'time',
    short: 'Time you can give',
    options: [opt('hands_on', 'Hands-on', 'I’ll run it myself'), opt('part_time', 'Part-time', 'Some of it, with help'), opt('hands_off', 'Hands-off', 'A manager runs it')],
  },
  {
    id: 'next_deal',
    section: 'about',
    kind: 'single',
    title: 'When do you want your next deal?',
    why: 'So we know how urgently to tell you about new deals.',
    image: 'next_deal',
    short: 'Next deal',
    options: [opt('this_month', 'This month'), opt('1-3m', '1 to 3 months'), opt('3-6m', '3 to 6 months'), opt('exploring', 'Just exploring')],
  },
  {
    id: 'deals_wanted',
    section: 'about',
    kind: 'single',
    title: 'How many deals do you want in the next 12 months?',
    why: 'So we send the right number of deals, not too many.',
    image: 'deals_wanted',
    short: 'Deals wanted',
    options: [opt('1', 'One'), opt('2-5', '2 to 5'), opt('6+', '6 or more')],
  },
  {
    id: 'blocker',
    section: 'about',
    kind: 'single',
    title: 'What’s the biggest thing holding you back?',
    why: 'So we help with the part you’re actually stuck on.',
    image: 'blocker',
    short: 'Holding you back',
    options: [opt('finding', 'Finding deals'), opt('numbers', 'Knowing the numbers'), opt('funding', 'Funding'), opt('consent', 'Landlord or agent consent'), opt('time', 'Time')],
  },
  {
    id: 'risk',
    section: 'about',
    kind: 'single',
    title: 'Profit is shown as a range, like £450–£700 a month. When should a deal count as hitting your minimum?',
    why: 'I’ll judge every deal’s range this way.',
    image: 'cards',
    short: 'Profit range',
    // The stored values stay avoid / consider / go (low / middle / top end of the range).
    options: [
      opt('avoid', 'Play it safe', 'Even the low end hits it', 'risk_avoid'),
      opt('consider', 'The middle of the range hits it', undefined, 'plain'),
      opt('go', 'The top end hits it', undefined, 'risk_go'),
    ],
  },
  {
    id: 'stage',
    section: 'about',
    kind: 'single',
    title: 'Where are you at?',
    why: 'So I explain as much or as little as you need.',
    image: 'units_now',
    short: 'Where you’re at',
    options: [opt('none', 'Not started yet'), opt('1-2', '1–2 units'), opt('3-10', '3–10 units'), opt('10+', 'More than 10')],
  },

  // ── Section B: investor buying ──
  {
    id: 'cash_available',
    section: 'about',
    kind: 'single',
    label: 'Buying',
    title: (a) => (budgetVoice(a) === 'clients' ? 'How much cash can your clients put into buying a property?' : 'How much cash can you put into buying a property?'),
    why: 'Your deposit, stamp duty and furnishing. For a project, the works too.',
    image: 'cash_available',
    short: 'Buying cash',
    options: [opt('u30', 'Under £30k'), opt('30-60', '£30–60k'), opt('60-100', '£60–100k'), opt('100-200', '£100–200k'), opt('200+', '£200k+')],
    mandatory: true,
    affectsMatch: true,
    applies: wants('buy_str', 'brrr', 'btl'),
    lineFor: (v, a) => priceLine(goalOption('cashAvailable', v), a.goals.buyer.funding),
  },
  {
    id: 'funding',
    section: 'buy',
    kind: 'single',
    title: 'How will you fund it?',
    why: 'Cash and mortgage buyers judge deals differently.',
    image: 'funding',
    short: 'Funding',
    options: [opt('cash', 'Cash'), opt('btl', 'Buy-to-let mortgage'), opt('holiday_let', 'Holiday-let mortgage'), opt('bridging', 'Bridging')],
    applies: wants('buy_str', 'brrr'),
    lineFor: (v, a) => priceLine(a.goals.buyer.cashAvailable, goalOption('funding', v)),
  },
  {
    id: 'finance',
    section: 'buy',
    kind: 'finance',
    title: 'Your deposit and mortgage rate',
    why: 'So every profit figure uses your numbers, not ours.',
    image: 'finance',
    short: 'Deposit and rate',
    applies: wants('buy_str', 'brrr'),
  },
  {
    id: 'entity',
    section: 'buy',
    kind: 'single',
    title: 'Buying in your own name or a company?',
    why: 'Company and personal mortgages are priced differently.',
    image: 'entity',
    short: 'Buying as',
    options: [opt('own_name', 'Own name'), opt('company', 'Limited company'), opt('undecided', 'Undecided')],
    applies: wants('buy_str', 'brrr'),
  },
  {
    id: 'main_goal',
    section: 'buy',
    kind: 'single',
    title: 'What’s the main goal?',
    why: 'So we rank by what matters to you.',
    image: 'main_goal',
    short: 'Main goal',
    options: [opt('cashflow', 'Monthly cashflow'), opt('growth', 'Long-term growth'), opt('both', 'Both')],
    applies: wants('buy_str', 'brrr'),
  },
  {
    id: 'min_profit',
    section: 'about',
    kind: 'profit',
    title: 'What’s the least profit a deal should make each month?',
    why: 'So you never see deals that aren’t worth your time.',
    image: 'min_profit',
    short: 'Minimum profit',
    presets: PROFIT_PRESETS_PCM,
  },
  {
    id: 'property_type',
    section: 'buy',
    kind: 'single',
    title: 'Flat or house?',
    why: 'Some investors only want flats, some only houses.',
    image: 'cards',
    short: 'Property type',
    options: [opt('flat', 'Flat', undefined, 'property_flat'), opt('house', 'House', undefined, 'property_house'), opt('either', 'Either', undefined, 'plain')],
    applies: wants('buy_str', 'brrr'),
  },
  {
    id: 'bedrooms',
    section: 'buy',
    kind: 'single',
    title: 'How many bedrooms?',
    why: 'Bigger places earn more but cost more to run.',
    image: 'bedrooms',
    short: 'Bedrooms',
    options: [opt('1', '1 bed'), opt('2', '2 bed'), opt('3', '3 bed'), opt('4', '4 or more')],
    applies: wants('buy_str', 'brrr'),
  },
  {
    id: 'property',
    section: 'about',
    kind: 'property',
    title: 'What kind of property?',
    why: 'Some people only want flats, some only houses, and bigger places earn more but cost more to run.',
    image: 'cards',
    short: 'Property',
    options: [opt('flat', 'Flat', undefined, 'property_flat'), opt('house', 'House', undefined, 'property_house'), opt('either', 'Either', undefined, 'plain')],
    affectsMatch: true,
  },
  {
    id: 'short_let_rules',
    section: 'buy',
    kind: 'single',
    title: 'Leasehold and council short-let rules?',
    why: 'Many leases and some councils limit short lets.',
    image: 'leasehold',
    short: 'Short-let rules',
    options: [opt('hide', 'Hide anything risky'), opt('warn', 'Show them with a warning')],
    applies: wants('buy_str', 'brrr'),
  },
  {
    id: 'brrr_work',
    section: 'buy',
    kind: 'single',
    title: 'How much work would you take on?',
    why: 'Projects can be great value if you’re up for the work.',
    image: 'cards',
    short: 'Work you’d take on',
    options: [opt('light', 'Light refresh', 'Paint, carpets, a kitchen', 'condition_ready'), opt('full', 'Full project', 'Strip-out and refit', 'condition_project'), opt('either', 'Either', undefined, 'plain')],
    applies: wants('brrr'),
  },
  {
    id: 'leasehold',
    section: 'buy',
    kind: 'single',
    title: 'Leasehold OK?',
    why: 'Many leases ban short lets, so some buyers avoid them.',
    image: 'leasehold',
    short: 'Leasehold',
    options: [opt('yes', 'Yes'), opt('no', 'No'), opt('depends', 'Depends on the lease')],
    applies: wants('buy_str', 'brrr'),
  },
  {
    id: 'restricted_areas',
    section: 'buy',
    kind: 'single',
    title: 'Areas with short-let restrictions?',
    why: 'Some councils limit short lets. We can hide them or warn you.',
    image: 'restricted_areas',
    short: 'Restricted areas',
    options: [opt('avoid', 'Avoid them'), opt('warn', 'Show them with a warning')],
    applies: wants('buy_str', 'brrr'),
  },

  // ── Section C: rent-to-rent operator ──
  {
    id: 'r2r_min_profit',
    section: 'r2r',
    kind: 'profit',
    title: 'What’s the least profit a deal should make each month?',
    why: 'So every deal clears your bar after rent and bills.',
    image: 'r2r_min_profit',
    short: 'Minimum profit',
    presets: PROFIT_PRESETS_PCM,
    applies: wants('r2r'),
  },
  {
    id: 'setup_budget',
    section: 'about',
    kind: 'single',
    label: 'Rent-to-rent',
    title: (a) => (budgetVoice(a) === 'clients' ? 'How much can your clients spend setting up a rent-to-rent property?' : 'How much can you spend setting up a rent-to-rent property?'),
    why: 'Furniture and getting it guest-ready. My setup figure doesn’t include the landlord’s deposit or first month’s rent.',
    image: 'setup_budget',
    short: 'R2R setup cash',
    options: [opt('u10k', 'Under £10k'), opt('10-15k', '£10–15k'), opt('15-20k', '£15–20k'), opt('20k+', '£20k+')],
    mandatory: true,
    affectsMatch: true,
    applies: wants('r2r'),
  },
  {
    id: 'deal_structure',
    section: 'r2r',
    kind: 'single',
    title: 'Which deal structure do you use?',
    why: 'So we give you the right pitch for the landlord.',
    image: 'deal_structure',
    short: 'Deal structure',
    options: [opt('company_let', 'Company let'), opt('management', 'Management agreement'), opt('guaranteed_rent', 'Guaranteed rent'), opt('any', 'Any')],
    applies: wants('r2r'),
  },
  {
    id: 'break_even',
    section: 'r2r',
    kind: 'single',
    title: 'What break-even occupancy are you comfortable with?',
    why: 'The lower this is, the safer the deal in a quiet month.',
    image: 'break_even',
    short: 'Break-even occupancy',
    options: BREAK_EVEN_OPTIONS.map((n) => opt(String(n), `Up to ${n}%`)),
    applies: wants('r2r'),
  },
  {
    id: 'payback',
    section: 'r2r',
    kind: 'single',
    title: 'How fast do you want your setup money back?',
    why: 'How fast you want your setup money back.',
    image: 'payback',
    short: 'Target payback',
    options: PAYBACK_OPTIONS.map((n) => opt(String(n), `${n} months`)),
    applies: wants('r2r'),
  },
  {
    id: 'furnished',
    section: 'r2r',
    kind: 'single',
    title: 'Furnished or unfurnished?',
    why: 'Furnished lets cut your setup cost.',
    image: 'furnished',
    short: 'Furnished',
    options: [opt('either', 'Either'), opt('furnished', 'Furnished only'), opt('unfurnished', 'Unfurnished only')],
    applies: wants('r2r'),
  },

  // ── Section D: deal sourcer ──
  {
    id: 'sourcing_fee',
    section: 'source',
    kind: 'single',
    title: 'What’s your typical sourcing fee?',
    why: 'A deal needs enough room in it to cover your fee.',
    image: 'sourcing_fee',
    short: 'Sourcing fee',
    options: [opt('u2k', 'Under £2k'), opt('2-4k', '£2k to £4k'), opt('4k+', '£4k or more')],
    applies: hasRole('sourcer'),
  },
  {
    id: 'deals_per_month',
    section: 'source',
    kind: 'single',
    title: 'How many deals do you need a month?',
    why: 'So we keep your pipeline full.',
    image: 'deals_per_month',
    short: 'Deals per month',
    options: [opt('1-2', '1 or 2'), opt('3-5', '3 to 5'), opt('6+', '6 or more')],
    applies: hasRole('sourcer'),
  },
  {
    id: 'motivated_sellers',
    section: 'source',
    kind: 'single',
    title: 'Motivated sellers?',
    why: 'Motivated sellers are more open to below-asking offers.',
    image: 'motivated_sellers',
    short: 'Motivated sellers',
    options: [opt('prefer', 'Prefer them'), opt('only', 'Only motivated sellers'), opt('off', 'No preference')],
    applies: hasRole('sourcer'),
  },

  // ── Section E: management company ──
  {
    id: 'units_managed',
    section: 'manage',
    kind: 'single',
    title: 'How many units do you manage now?',
    why: 'So we pitch deals at your scale.',
    image: 'units_managed',
    short: 'Units managed',
    options: [opt('1-10', '1 to 10'), opt('11-30', '11 to 30'), opt('31-75', '31 to 75'), opt('76+', '76 or more')],
    applies: hasRole('manager'),
  },
  {
    id: 'operating_areas',
    section: 'manage',
    kind: 'areas',
    title: 'Which cities do you operate in?',
    why: 'Deals where your team already works are easier to take on.',
    image: 'operating_areas',
    short: 'Where you operate',
    applies: hasRole('manager'),
  },
  {
    id: 'looking_for',
    section: 'manage',
    kind: 'single',
    title: 'What are you looking for?',
    why: 'Some management companies want landlords, some want their own deals.',
    image: 'looking_for',
    short: 'Looking for',
    options: [opt('landlords', 'Landlords to manage'), opt('own_deals', 'Our own deals'), opt('both', 'Both')],
    applies: hasRole('manager'),
  },
  {
    id: 'growth_target',
    section: 'manage',
    kind: 'single',
    title: 'Growth target for the next 12 months?',
    why: 'So we send enough to hit your target.',
    image: 'growth_target',
    short: 'Growth target',
    options: GROWTH_OPTIONS.map((n) => opt(String(n), `+${n} units`)),
    applies: hasRole('manager'),
  },
];

/**
 * The questions a member is asked, in the order they are asked (Batch 30).
 * Everything not listed here is retired.
 */
export const LIVE_ORDER: readonly QuestionId[] = [
  'deal_types',
  'where',
  'setup_budget',
  'cash_available',
  'funding',
  'min_profit',
  'stage',
  'time',
  'risk',
  'main_goal',
  'property',
  'short_let_rules',
  'brrr_work',
  'btl_priority',
  'next_deal',
  'sourcing_fee',
  'motivated_sellers',
  'looking_for',
  'operating_areas',
];

/**
 * The retired questions: kept in QuestionId and here so an id still parses and
 * its stored answer is still read, but never asked. The editable ones can
 * still be saved from the profile page, chat, what-if, the Home card and a
 * rate "change" link.
 */
export const RETIRED: Readonly<Partial<Record<QuestionId, true | 'editable'>>> = {
  roles: true,
  budget: 'editable',
  brrr_budget: 'editable',
  max_rent: 'editable',
  btl_cash: true,
  deals_done: true,
  units_now: true,
  unit_areas: true,
  deals_wanted: true,
  blocker: 'editable',
  finance: 'editable',
  entity: true,
  // Still saved by id from chat and what-if ("3 bedrooms", "flats as well as houses"), so editable.
  property_type: 'editable',
  bedrooms: 'editable',
  leasehold: true,
  restricted_areas: true,
  r2r_min_profit: 'editable',
  deal_structure: true,
  break_even: true,
  payback: true,
  furnished: true,
  deals_per_month: true,
  units_managed: true,
  growth_target: true,
};

/** Live questions first, in LIVE_ORDER; then the retired ones: never mandatory, never asked (questionsFor skips them). */
export const QUESTIONS: readonly Question[] = (() => {
  const byDef = new Map(DEFINITIONS.map((q) => [q.id, q]));
  const live = LIVE_ORDER.map((id) => byDef.get(id)!);
  // `applies` is kept: asked() in tailoring/profile.ts still routes an old answer by it (a buyer's answers do not judge a profile that no longer buys).
  const retired = DEFINITIONS.filter((q) => RETIRED[q.id]).map((q): Question => ({ ...q, retired: RETIRED[q.id], mandatory: false }));
  return [...live, ...retired];
})();

const BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));

export function questionById(id: string): Question | null {
  return BY_ID.get(id as QuestionId) ?? null;
}

export function isQuestionId(v: unknown): v is QuestionId {
  return typeof v === 'string' && BY_ID.has(v as QuestionId);
}

/** The questions this member is asked, in order. */
export function questionsFor(a: Answers): Question[] {
  return QUESTIONS.filter((q) => !q.retired && (!q.applies || q.applies(a)));
}

export function text(t: Text, a: Answers): string {
  return typeof t === 'function' ? t(a) : t;
}

export function optionsOf(q: Question, a: Answers): readonly Option[] {
  if (!q.options) return [];
  return typeof q.options === 'function' ? q.options(a) : q.options;
}

export function imageOf(q: Question, a: Answers): ImageKey | 'cards' {
  return typeof q.image === 'function' ? q.image(a) : q.image;
}

/**
 * The money question(s) for the chosen types (mandatory): Buying cash for a
 * short-let, a project or a buy to let (one question, shared), and R2R setup
 * cash for rent-to-rent (Batch 30; it used to be a budget, a project budget, a
 * rent ceiling and a buy-to-let cash question).
 */
export function moneyQuestionsFor(types: readonly DealType[]): QuestionId[] {
  const out: QuestionId[] = [];
  if (types.includes('r2r')) out.push('setup_budget');
  if (types.includes('buy_str') || types.includes('brrr') || types.includes('btl')) out.push('cash_available');
  return out;
}

/**
 * Batch 30: the marks a new question also writes, so a reader that asks "was
 * the old question answered?" (asked() / realAnswer() in tailoring/profile.ts)
 * works unchanged.
 */
export const MARKS_WRITTEN: Readonly<Partial<Record<QuestionId, readonly QuestionId[]>>> = {
  deal_types: ['roles'],
  stage: ['deals_done', 'units_now'],
  property: ['property_type', 'bedrooms'],
  short_let_rules: ['leasehold', 'restricted_areas'],
  min_profit: ['r2r_min_profit'],
};

/**
 * Batch 30: a new question counts as answered (for progress and gating) when
 * any old question it replaces was answered, so a member who answered the old
 * ones is not asked again and is not blocked.
 */
export const PREDECESSORS: Readonly<Partial<Record<QuestionId, readonly QuestionId[]>>> = {
  cash_available: ['budget', 'brrr_budget', 'btl_cash'],
  setup_budget: ['max_rent'],
  stage: ['deals_done', 'units_now'],
  property: ['property_type', 'bedrooms'],
  short_let_rules: ['leasehold', 'restricted_areas'],
  min_profit: ['r2r_min_profit'],
};

// ── Answering ──

/** What the quiz posts for a "where" answer. */
export interface WhereAnswer {
  mode: string;
  postcode?: string | null;
  miles?: number | string | null;
  areas?: string[] | null;
}

export type Applied = { ok: true; answers: Answers } | { ok: false; error: string };

const fail = (error: string): Applied => ({ ok: false, error });

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.replace(/[£,\s]/g, '')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * New about-you answers into the goals: the kind the profile searches follows
 * its deal types (chosen, or mapped from the roles until it chooses). The old
 * path is still written for any reader that has not moved on, but decides
 * nothing (Batch 17).
 */
function withRoles(a: Answers, about: AboutYou): Answers {
  const next = { ...a, about };
  const types = typesOf(next);
  const goals: MarketGoals = { ...a.goals, path: pathFor(about), sourcingKind: types.length > 0 ? kindsFor(types) : a.goals.sourcingKind };
  return { ...next, goals };
}

/**
 * The deal types as the question posts them: "All of them" ticks every
 * available type, and a type that is not available yet (Buy to let) is never
 * kept, whatever is posted.
 */
export function dealTypesFromAnswer(raw: unknown): DealType[] {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.includes(ALL_DEAL_TYPES)) return [...AVAILABLE_DEAL_TYPES];
  return availableTypes(list.filter((v): v is DealType => (DEAL_TYPES as readonly unknown[]).includes(v)));
}

/** The ticked values of "What are you looking for?" as a list; "All of them" is the four deal types. */
function tickList(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string');
}

/**
 * What the roles alone imply as deal types, for a member who ticked no deal
 * type: a sourcer sees Short-let and Rent-to-rent, a management company
 * Short-let, and someone just exploring every available type. Written
 * explicitly so the profile does not depend on the old role mapping.
 */
function typesForRoles(roles: readonly Role[], sourceFor: SourcerGoals['sourceFor']): DealType[] {
  if (roles.includes('exploring')) return [...AVAILABLE_DEAL_TYPES];
  const out = new Set<DealType>();
  if (roles.includes('sourcer')) {
    if (sourceFor !== 'r2r') out.add('buy_str');
    if (sourceFor !== 'buyers') out.add('r2r');
  }
  if (roles.includes('manager')) out.add('buy_str');
  return availableTypes(out);
}

/** The roles and deal types "What are you looking for?" posts mean. */
export function lookingForFrom(raw: unknown, current: { roles: readonly Role[]; sourceFor: SourcerGoals['sourceFor'] }): { roles: Role[]; types: DealType[] } {
  const ticks = tickList(raw);
  const types = dealTypesFromAnswer(ticks);
  const roles = new Set<Role>();
  if (types.some((t) => t === 'buy_str' || t === 'brrr' || t === 'btl')) roles.add('investor');
  if (types.includes('r2r')) roles.add('r2r');
  if (ticks.includes(SOURCE_TICK)) roles.add('sourcer');
  if (ticks.includes(MANAGE_TICK)) roles.add('manager');
  if (ticks.includes(EXPLORING_TICK)) roles.add('exploring');
  const roleList_ = ROLE_OPTIONS.filter((r) => roles.has(r));
  return { roles: roleList_, types: types.length > 0 ? types : typesForRoles(roleList_, current.sourceFor) };
}

const setBuyer = (a: Answers, patch: Partial<BuyerGoals>): Answers => ({ ...a, goals: { ...a.goals, buyer: { ...a.goals.buyer, ...patch } } });
const setR2r = (a: Answers, patch: Partial<R2rGoals>): Answers => ({ ...a, goals: { ...a.goals, r2r: { ...a.goals.r2r, ...patch } } });
const setSourcer = (a: Answers, patch: Partial<SourcerGoals>): Answers => ({ ...a, goals: { ...a.goals, sourcer: { ...a.goals.sourcer, ...patch } } });
const setManager = (a: Answers, patch: Partial<ManagerGoals>): Answers => ({ ...a, goals: { ...a.goals, manager: { ...a.goals.manager, ...patch } } });
const setAbout = (a: Answers, patch: Partial<AboutYou>): Answers => ({ ...a, about: { ...a.about, ...patch } });

/**
 * A real answer to one question, as new goals / about-you / saved areas.
 * Every value is checked: a wrong one is refused with a message the screen
 * can show, and nothing else changes. The reads and writes are the server's
 * (src/lib/profile/server.ts).
 */
export function applyAnswer(id: QuestionId, raw: unknown, a: Answers): Applied {
  const q = BY_ID.get(id);
  if (!q) return fail('Unknown question.');
  const goals = a.goals;
  switch (id) {
    case 'roles': {
      const roles = roleList(raw);
      if (roles.length === 0) return fail('Tick at least one.');
      const mainRole = roles.length === 1 ? roles[0] : a.about.mainRole && roles.includes(a.about.mainRole) ? a.about.mainRole : null;
      return { ok: true, answers: withRoles(a, { ...a.about, roles, mainRole }) };
    }
    case 'deal_types': {
      const posted = tickList(raw);
      const soon = COMING_SOON_DEAL_TYPES.filter((t) => posted.includes(t));
      const { roles, types } = lookingForFrom(raw, { roles: a.about.roles, sourceFor: goals.sourcer.sourceFor });
      if (types.length === 0 && roles.length === 0 && soon.length > 0) return fail(`${soon.map((t) => DEAL_TYPE_LABELS[t]).join(' and ')} ${soon.length === 1 ? 'is' : 'are'} coming soon. Tick one of the others for now.`);
      if (roles.length === 0 || types.length === 0) return fail('Tick at least one.');
      const mainRole = roles.length === 1 ? roles[0] : a.about.mainRole && roles.includes(a.about.mainRole) ? a.about.mainRole : null;
      const about: AboutYou = { ...a.about, roles, mainRole };
      const next = { ...a, about, goals: { ...goals, dealTypes: types, sourcingKind: kindsFor(types), path: pathFor(about) } };
      return { ok: true, answers: next };
    }
    case 'where': {
      const w = (raw && typeof raw === 'object' ? raw : {}) as WhereAnswer;
      const mode = goalOption('where', w.mode);
      if (!mode) return fail('Choose where you want to look.');
      if (mode === 'near' || mode === 'near_plus_best') {
        const postcode = normalisePostcode(typeof w.postcode === 'string' ? w.postcode : '');
        if (!postcode) return fail('Enter a full UK postcode, like NG2 5GB.');
        const miles = parseMaxDistance(w.miles);
        if (miles === null) return fail(`Choose how far you would go, ${DISTANCE_MILES.min} to ${DISTANCE_MILES.max} miles.`);
        // The same postcode keeps its coordinates (placed once, metered); a new one is placed by the server.
        const same = goals.home && goals.home.postcode === postcode ? goals.home : null;
        return { ok: true, answers: { ...a, goals: { ...goals, where: mode, home: same ?? { postcode, lat: null, lng: null }, maxDistanceMiles: miles }, savedAreas: [] } };
      }
      if (mode === 'areas') {
        const areas = areaCodeList(w.areas);
        if (areas.length === 0) return fail('Pick at least one area.');
        return { ok: true, answers: { ...a, goals: { ...goals, where: mode, home: null, maxDistanceMiles: null }, savedAreas: areas } };
      }
      return { ok: true, answers: { ...a, goals: { ...goals, where: mode, home: null, maxDistanceMiles: null }, savedAreas: [] } };
    }
    case 'budget': {
      if (!isBudget(raw) || raw === 'any') return fail('Choose a budget.');
      return { ok: true, answers: { ...a, goals: { ...goals, budget: raw } } };
    }
    case 'brrr_budget': {
      if (!isBudget(raw) || raw === 'any') return fail('Choose a budget.');
      return { ok: true, answers: { ...a, goals: { ...goals, brrr: { ...goals.brrr, budget: raw } } } };
    }
    case 'brrr_work': {
      const v = goalOption('brrrWork', raw);
      if (!v) return fail('Choose one.');
      return { ok: true, answers: { ...a, goals: { ...goals, brrr: { ...goals.brrr, work: v } } } };
    }
    case 'btl_priority': {
      const v = goalOption('btlPriority', raw);
      if (!v) return fail('Choose one.');
      return { ok: true, answers: { ...a, goals: { ...goals, btl: { ...goals.btl, priority: v } } } };
    }
    case 'btl_cash': {
      const v = goalOption('btlCash', raw);
      if (!v) return fail('Choose how much cash you can put in.');
      return { ok: true, answers: { ...a, goals: { ...goals, btl: { ...goals.btl, cashBand: v } } } };
    }
    case 'max_rent': {
      const rent = parseMaxRentPcm(raw);
      if (rent === null) return fail(`Enter a monthly rent between £${MAX_RENT_PCM_RANGE.min} and £${MAX_RENT_PCM_RANGE.max.toLocaleString('en-GB')}.`);
      return { ok: true, answers: { ...a, goals: { ...goals, maxRentPcm: rent } } };
    }
    case 'deals_done':
    case 'units_now':
    case 'next_deal':
    case 'deals_wanted':
    case 'blocker': {
      const key = ({ deals_done: 'dealsDone', units_now: 'unitsNow', next_deal: 'nextDeal', deals_wanted: 'dealsWanted12m', blocker: 'blocker' } as const)[id];
      const v = aboutOption(key, raw);
      if (!v) return fail('Choose one.');
      const about: AboutYou = { ...a.about, [key]: v };
      if (id === 'units_now' && v === '0') about.unitAreas = [];
      return { ok: true, answers: { ...a, about } };
    }
    case 'unit_areas': {
      const areas = areaCodeList(raw);
      if (areas.length === 0) return fail('Pick at least one area.');
      return { ok: true, answers: setAbout(a, { unitAreas: areas }) };
    }
    case 'time': {
      const v = aboutOption('time', raw);
      if (!v) return fail('Choose one.');
      return { ok: true, answers: { ...a, about: { ...a.about, time: v }, goals: { ...goals, management: TIME_TO_MANAGEMENT[v] } } };
    }
    case 'risk': {
      const v = aboutOption('risk', raw);
      if (!v) return fail('Choose one.');
      return { ok: true, answers: { ...a, about: { ...a.about, risk: v }, goals: { ...goals, riskAppetite: RISK_TO_APPETITE[v] } } };
    }
    case 'cash_available': {
      const v = goalOption('cashAvailable', raw);
      if (!v) return fail('Choose how much cash you can put in.');
      // A real answer: it sets the older budget as a ceiling (so the readers that
      // still use it keep working) and the Buy to let band, and is no longer "worked out".
      const budget = budgetFromCash(v, goals.buyer.funding);
      const withCash = setBuyer(a, { cashAvailable: v, cashFromBudget: false });
      return { ok: true, answers: { ...withCash, goals: { ...withCash.goals, budget, brrr: { ...withCash.goals.brrr, budget }, btl: { ...withCash.goals.btl, cashBand: btlBandFromCash(v) } } } };
    }
    case 'funding': {
      const v = goalOption('funding', raw);
      if (!v) return fail('Choose one.');
      const withFunding = setBuyer(a, { funding: v });
      const cash = withFunding.goals.buyer;
      // The price a band buys depends on how it is funded, so the ceiling follows (only for a real cash answer).
      if (cash.cashAvailable && !cash.cashFromBudget) {
        const budget = budgetFromCash(cash.cashAvailable, v);
        return { ok: true, answers: { ...withFunding, goals: { ...withFunding.goals, budget, brrr: { ...withFunding.goals.brrr, budget } } } };
      }
      return { ok: true, answers: withFunding };
    }
    case 'entity':
    case 'main_goal':
    case 'property_type':
    case 'leasehold':
    case 'restricted_areas': {
      const key = ({ entity: 'entity', main_goal: 'mainGoal', property_type: 'propertyType', leasehold: 'leaseholdOk', restricted_areas: 'restrictedAreas' } as const)[id];
      const v = goalOption(key, raw);
      if (!v) return fail('Choose one.');
      return { ok: true, answers: setBuyer(a, { [key]: v }) };
    }
    case 'property': {
      const p = (raw && typeof raw === 'object' ? raw : {}) as { type?: unknown; bedrooms?: unknown };
      const type = goalOption('propertyType', p.type);
      const beds = num(p.bedrooms);
      if (!type) return fail('Choose flat, house or either.');
      if (beds !== 1 && beds !== 2 && beds !== 3 && beds !== 4) return fail('Choose the bedrooms.');
      const withType = setBuyer(a, { propertyType: type });
      return { ok: true, answers: { ...withType, goals: { ...withType.goals, bedrooms: beds } } };
    }
    case 'short_let_rules': {
      if (raw !== 'hide' && raw !== 'warn') return fail('Choose one.');
      return { ok: true, answers: setBuyer(a, raw === 'hide' ? { leaseholdOk: 'no', restrictedAreas: 'avoid' } : { leaseholdOk: 'depends', restrictedAreas: 'warn' }) };
    }
    case 'stage': {
      const v = aboutOption('stage', raw);
      if (!v) return fail('Choose one.');
      const w = STAGE_TO_ABOUT[v];
      const about: AboutYou = { ...a.about, stage: v, dealsDone: w.dealsDone, unitsNow: w.unitsNow };
      if (v === 'none') about.unitAreas = [];
      return { ok: true, answers: { ...a, about } };
    }
    case 'finance': {
      const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const deposit = num(f.depositPct);
      const rate = num(f.mortgageRatePct);
      if (deposit === null || deposit < 0 || deposit > 100) return fail('Enter a deposit between 0% and 100%.');
      if (rate === null || rate < 0 || rate > 25) return fail('Enter a mortgage rate between 0% and 25%.');
      // Batch 30: "Use today's average" keeps the member on the daily average (rateSet false); typing a rate makes it theirs.
      const average = f.useAverage === true;
      const rateAsOf = average && typeof f.rateAsOf === 'string' ? f.rateAsOf : goals.finance.rateAsOf;
      return { ok: true, answers: { ...a, goals: { ...goals, finance: parseFinanceGoals({ ...goals.finance, depositPct: deposit, mortgageRatePct: rate, rateSet: !average, rateAsOf }) } } };
    }
    case 'min_profit':
    case 'r2r_min_profit': {
      const n = num(raw);
      if (n === null || n < MIN_PROFIT_RANGE.min || n > MIN_PROFIT_RANGE.max) return fail(`Enter a monthly profit between £0 and £${MIN_PROFIT_RANGE.max.toLocaleString('en-GB')}.`);
      // Batch 30: one minimum profit for everyone writes both fields; the retired rent-to-rent one still saves just its own.
      if (id === 'r2r_min_profit') return { ok: true, answers: setR2r(a, { minMarginPcm: Math.round(n) }) };
      const both = setR2r(a, { minMarginPcm: Math.round(n) });
      return { ok: true, answers: { ...both, goals: { ...both.goals, finance: { ...both.goals.finance, targetMarginPcm: Math.round(n) } } } };
    }
    case 'bedrooms': {
      const n = num(raw);
      if (n !== 1 && n !== 2 && n !== 3 && n !== 4) return fail('Choose one.');
      return { ok: true, answers: { ...a, goals: { ...goals, bedrooms: n } } };
    }
    case 'setup_budget':
    case 'deal_structure':
    case 'furnished': {
      const key = ({ setup_budget: 'setupBudget', deal_structure: 'dealStructure', furnished: 'furnished' } as const)[id];
      const v = goalOption(key, raw);
      if (!v) return fail('Choose one.');
      return { ok: true, answers: setR2r(a, { [key]: v }) };
    }
    case 'break_even': {
      const n = num(raw);
      const v = BREAK_EVEN_OPTIONS.find((x) => x === n);
      if (!v) return fail('Choose one.');
      return { ok: true, answers: setR2r(a, { breakEvenOccupancyPct: v }) };
    }
    case 'payback': {
      const n = num(raw);
      const v = PAYBACK_OPTIONS.find((x) => x === n);
      if (!v) return fail('Choose one.');
      return { ok: true, answers: setR2r(a, { paybackMonths: v }) };
    }
    case 'sourcing_fee':
    case 'deals_per_month': {
      const key = ({ sourcing_fee: 'sourcingFee', deals_per_month: 'dealsPerMonth' } as const)[id];
      const v = goalOption(key, raw);
      if (!v) return fail('Choose one.');
      return { ok: true, answers: setSourcer(a, { [key]: v }) };
    }
    case 'motivated_sellers': {
      if (raw !== 'prefer' && raw !== 'only' && raw !== 'off') return fail('Choose one.');
      return { ok: true, answers: { ...a, goals: { ...goals, motivation: { ...goals.motivation, mode: raw } } } };
    }
    case 'units_managed':
    case 'looking_for': {
      const key = ({ units_managed: 'unitsManaged', looking_for: 'lookingFor' } as const)[id];
      const v = goalOption(key, raw);
      if (!v) return fail('Choose one.');
      return { ok: true, answers: setManager(a, { [key]: v }) };
    }
    case 'operating_areas': {
      const areas = areaCodeList(raw);
      if (areas.length === 0) return fail('Pick at least one area.');
      return { ok: true, answers: setManager(a, { operatingAreas: areas }) };
    }
    case 'growth_target': {
      const n = num(raw);
      const v = GROWTH_OPTIONS.find((x) => x === n);
      if (!v) return fail('Choose one.');
      return { ok: true, answers: setManager(a, { growthTarget: v }) };
    }
  }
}

/**
 * "Not sure": the stored value goes back to "no preference", so an earlier
 * real answer never lingers behind a shrug. Only for the questions that
 * allow it; a mandatory one is returned unchanged.
 */
export function clearAnswer(id: QuestionId, a: Answers): Answers {
  const goals = a.goals;
  switch (id) {
    case 'roles':
    case 'deal_types':
    case 'where':
    case 'budget':
    case 'brrr_budget':
    case 'btl_priority':
    case 'btl_cash':
    case 'cash_available':
    case 'setup_budget':
      return a;
    case 'max_rent':
      // Retired (Batch 30) but editable: a member can clear a ceiling they set before.
      return { ...a, goals: { ...goals, maxRentPcm: null } };
    case 'stage':
      return setAbout(a, { stage: null, dealsDone: null, unitsNow: null, unitAreas: [] });
    case 'property': {
      const x = setBuyer(a, { propertyType: null });
      return { ...x, goals: { ...x.goals, bedrooms: null } };
    }
    case 'short_let_rules':
      return setBuyer(a, { leaseholdOk: null, restrictedAreas: null });
    case 'brrr_work':
      return { ...a, goals: { ...goals, brrr: { ...goals.brrr, work: null } } };
    case 'deals_done':
      return setAbout(a, { dealsDone: null });
    case 'units_now':
      return setAbout(a, { unitsNow: null, unitAreas: [] });
    case 'unit_areas':
      return setAbout(a, { unitAreas: [] });
    case 'time':
      return { ...a, about: { ...a.about, time: null }, goals: { ...goals, management: 'managed' } };
    case 'next_deal':
      return setAbout(a, { nextDeal: null });
    case 'deals_wanted':
      return setAbout(a, { dealsWanted12m: null });
    case 'blocker':
      return setAbout(a, { blocker: null });
    case 'risk':
      return { ...a, about: { ...a.about, risk: null }, goals: { ...goals, riskAppetite: 'balanced' } };
    case 'funding':
      return setBuyer(a, { funding: null });
    case 'finance':
      return { ...a, goals: { ...goals, finance: { ...goals.finance, depositPct: DEFAULT_FINANCE.depositPct, mortgageRatePct: DEFAULT_FINANCE.mortgageRatePct, rateSet: false } } };
    case 'entity':
      return setBuyer(a, { entity: null });
    case 'main_goal':
      return setBuyer(a, { mainGoal: null });
    case 'min_profit':
      return setR2r({ ...a, goals: { ...goals, finance: { ...goals.finance, targetMarginPcm: DEFAULT_FINANCE.targetMarginPcm } } }, { minMarginPcm: null });
    case 'r2r_min_profit':
      return setR2r(a, { minMarginPcm: null });
    case 'property_type':
      return setBuyer(a, { propertyType: null });
    case 'bedrooms':
      return { ...a, goals: { ...goals, bedrooms: null } };
    case 'leasehold':
      return setBuyer(a, { leaseholdOk: null });
    case 'restricted_areas':
      return setBuyer(a, { restrictedAreas: null });
    case 'deal_structure':
      return setR2r(a, { dealStructure: null });
    case 'break_even':
      return setR2r(a, { breakEvenOccupancyPct: null });
    case 'payback':
      return setR2r(a, { paybackMonths: null });
    case 'furnished':
      return setR2r(a, { furnished: null });
    case 'sourcing_fee':
      return setSourcer(a, { sourcingFee: null });
    case 'deals_per_month':
      return setSourcer(a, { dealsPerMonth: null });
    case 'motivated_sellers':
      return { ...a, goals: { ...goals, motivation: { ...goals.motivation, mode: 'off' } } };
    case 'units_managed':
      return setManager(a, { unitsManaged: null });
    case 'operating_areas':
      return setManager(a, { operatingAreas: [] });
    case 'looking_for':
      return setManager(a, { lookingFor: null });
    case 'growth_target':
      return setManager(a, { growthTarget: null });
  }
}

// ── Reading back ──

/** The stored value in the shape applyAnswer takes, for the quiz to preselect; null when there is none. */
export function currentValue(id: QuestionId, a: Answers): unknown {
  const g = a.goals;
  const b = a.about;
  switch (id) {
    case 'roles':
      return b.roles.length > 0 ? b.roles : null;
    case 'deal_types': {
      // The deal types, plus a tick for each role that is not a deal type, prefilled from the roles so
      // answering again keeps them (a sourcer's or manager's own types are left out: they follow the role).
      const types = typesOf(a);
      const noInvesting = !b.roles.includes('investor') && !b.roles.includes('r2r');
      const implied = noInvesting ? typesForRoles(b.roles, g.sourcer.sourceFor) : [];
      const sameAsRoles = implied.length > 0 && implied.length === types.length && implied.every((t) => types.includes(t));
      const ticks: string[] = sameAsRoles ? [] : [...types];
      if (b.roles.includes('sourcer')) ticks.push(SOURCE_TICK);
      if (b.roles.includes('manager')) ticks.push(MANAGE_TICK);
      if (b.roles.includes('exploring')) ticks.push(EXPLORING_TICK);
      return ticks.length > 0 ? ticks : null;
    }
    case 'where':
      if (!g.where) return null;
      return { mode: g.where, postcode: g.home?.postcode ?? null, miles: g.maxDistanceMiles, areas: a.savedAreas } satisfies WhereAnswer;
    case 'budget':
      return g.budget;
    case 'brrr_budget':
      return g.brrr.budget;
    case 'brrr_work':
      return g.brrr.work;
    case 'max_rent':
      return g.maxRentPcm;
    case 'btl_priority':
      return g.btl.priority;
    case 'btl_cash':
      return g.btl.cashBand;
    case 'deals_done':
      return b.dealsDone;
    case 'units_now':
      return b.unitsNow;
    case 'unit_areas':
      return b.unitAreas.length > 0 ? b.unitAreas : null;
    case 'time':
      return b.time;
    case 'next_deal':
      return b.nextDeal;
    case 'deals_wanted':
      return b.dealsWanted12m;
    case 'blocker':
      return b.blocker;
    case 'risk':
      return b.risk;
    case 'cash_available':
      return g.buyer.cashAvailable;
    case 'stage':
      return stageOf(b);
    case 'property':
      return g.buyer.propertyType && g.bedrooms !== null ? { type: g.buyer.propertyType, bedrooms: String(g.bedrooms) } : null;
    case 'short_let_rules': {
      const { leaseholdOk, restrictedAreas } = g.buyer;
      if (leaseholdOk === null && restrictedAreas === null) return null;
      return leaseholdOk === 'no' || restrictedAreas === 'avoid' ? 'hide' : 'warn';
    }
    case 'funding':
      return g.buyer.funding;
    case 'finance':
      return { depositPct: g.finance.depositPct, mortgageRatePct: g.finance.mortgageRatePct };
    case 'entity':
      return g.buyer.entity;
    case 'main_goal':
      return g.buyer.mainGoal;
    case 'min_profit':
      return g.finance.targetMarginPcm;
    case 'r2r_min_profit':
      return g.r2r.minMarginPcm;
    case 'property_type':
      return g.buyer.propertyType;
    case 'bedrooms':
      return g.bedrooms === null ? null : String(g.bedrooms);
    case 'leasehold':
      return g.buyer.leaseholdOk;
    case 'restricted_areas':
      return g.buyer.restrictedAreas;
    case 'setup_budget':
      return g.r2r.setupBudget;
    case 'deal_structure':
      return g.r2r.dealStructure;
    case 'break_even':
      return g.r2r.breakEvenOccupancyPct === null ? null : String(g.r2r.breakEvenOccupancyPct);
    case 'payback':
      return g.r2r.paybackMonths === null ? null : String(g.r2r.paybackMonths);
    case 'furnished':
      return g.r2r.furnished;
    case 'sourcing_fee':
      return g.sourcer.sourcingFee;
    case 'deals_per_month':
      return g.sourcer.dealsPerMonth;
    case 'motivated_sellers':
      return g.motivation.mode;
    case 'units_managed':
      return g.manager.unitsManaged;
    case 'operating_areas':
      return g.manager.operatingAreas.length > 0 ? g.manager.operatingAreas : null;
    case 'looking_for':
      return g.manager.lookingFor;
    case 'growth_target':
      return g.manager.growthTarget === null ? null : String(g.manager.growthTarget);
  }
}

const gbp = (n: number) => `£${n.toLocaleString('en-GB')}`;

const areaNames = (codes: readonly string[]) => codes.map((c) => areaMetaForCode(c).name).join(', ');

/** The stored answer as the profile page shows it; null when there is none. */
export function answerLabel(id: QuestionId, a: Answers): string | null {
  const q = BY_ID.get(id);
  if (!q) return null;
  const v = currentValue(id, a);
  if (v === null || v === undefined) return null;
  switch (q.kind) {
    case 'single': {
      const o = optionsOf(q, a).find((x) => x.value === String(v));
      if (!o) return null;
      // Batch 30: a cash band worked out from an older budget says so.
      return id === 'cash_available' && a.goals.buyer.cashFromBudget ? `${o.label} (worked out from your budget)` : o.label;
    }
    case 'property': {
      const p = v as { type: string; bedrooms: string };
      const type = optionsOf(q, a).find((x) => x.value === p.type)?.label ?? p.type;
      return `${type}, ${p.bedrooms === '4' ? '4+' : p.bedrooms} bed`;
    }
    case 'multi': {
      const opts = optionsOf(q, a);
      const picked = v as string[];
      // "All of them": every option it covers that can be chosen (never one that is coming soon).
      if (q.allOption) {
        const covered = opts.filter((o) => o.value !== q.allOption && !o.soon && (!q.allCovers || q.allCovers.includes(o.value)));
        if (covered.every((o) => picked.includes(o.value))) {
          const rest = picked.filter((x) => !covered.some((o) => o.value === x)).map((x) => opts.find((o) => o.value === x)?.label).filter((x): x is string => Boolean(x));
          return [opts.find((o) => o.value === q.allOption)?.label ?? 'All of them', ...rest].join(', ');
        }
      }
      const labels = picked.map((x) => opts.find((o) => o.value === x)?.label).filter((x): x is string => Boolean(x));
      return labels.length > 0 ? labels.join(', ') : null;
    }
    case 'where': {
      const w = v as WhereAnswer;
      if (w.mode === 'near' || w.mode === 'near_plus_best') {
        const near = `Within ${w.miles} miles of ${String(w.postcode ?? '').split(' ')[0]}`;
        return w.mode === 'near' ? near : `${near}, plus the best elsewhere`;
      }
      if (w.mode === 'areas') return w.areas && w.areas.length > 0 ? areaNames(w.areas) : 'Specific areas';
      return 'Anywhere in the UK';
    }
    case 'budget':
      return isBudget(v) ? BUDGET_LABELS[v] : null;
    case 'rent':
      return `Up to ${gbp(Number(v))} a month`;
    case 'finance': {
      const f = v as { depositPct: number; mortgageRatePct: number };
      return `${f.depositPct}% deposit, ${f.mortgageRatePct}% rate`;
    }
    case 'profit':
      return `${gbp(Number(v))} a month`;
    case 'areas':
      return areaNames(v as string[]);
  }
}

/** Fresh answers for a member with nothing stored yet. */
export function emptyAnswers(goals: MarketGoals, about: AboutYou | null, savedAreas: string[]): Answers {
  return { goals, about: about ?? DEFAULT_ABOUT, savedAreas };
}

export { ABOUT_OPTIONS };
