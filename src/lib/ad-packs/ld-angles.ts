/**
 * Batch 55 step 5 (Phase 2, 55c A4): the copy of a LEAD DATABASE pack, as FIXED templates.
 *
 * The Academy route keeps angles.ts (its 45 templates, SCRIPT_5B and the type cards) byte for byte. Everything here
 * is chosen only by `ad_packs.route = 'leaddb'`. No AI writes any of this at runtime: every line is reviewed once in the
 * pull request (PROPOSED wording, 55c section 4), and the render functions only fill slots:
 *
 *   {company}   the customer's company name ("Our team" when empty)
 *   {area}      the pack's main area as the calculator shows it ("your area" when empty)
 *   {figure|x}  the labelled example sentence (figures.ts), or x when the area has too little data
 *   {fee|x}     "Our management fee is 12%.", only when the customer set a fee, else x (nothing)
 *
 * Rules every template obeys (ld-angles.test.ts and the gate in ld-gate.ts):
 *   1. offer first: every primary text names the audience, the area, "free" and "report" in its first 125 characters,
 *      and the first spoken line and frame one say the offer; the last line is "Get your free income report"
 *   2. no question mark in the first sentence; a trigger question only as the second line
 *   3. claims only from the facts list (facts.ts): what the report contains, free, about a minute, the customer's
 *      company, area and own fee, you stay the owner. Never "you will earn", a guarantee, a range or Stayful
 *   6. one concept per ad; no line shared word for word with another ad of the pack (the CTA line excepted);
 *      "you stay the owner" in every primary text; headlines about 40 characters, descriptions about 30;
 *      sentence case, UK English, no exclamation marks, no em dashes
 *
 * HOOK VARIANTS: frame one has two wordings (`a`, `b`). The same-area rule (ld-gate.ts chooseLook) picks `b`, and the
 * other base, when another customer's latest pack in the same main area already used `a`. Nothing else changes.
 *
 * Pure: no network, no database, no server-only.
 */
import { ANGLES, type Angle } from './codes.ts';
import { ANGLE_DEFS, feeSentence, type Card, type LeadFormQuestion } from './angles.ts';
import type { AdFormat } from './concepts.ts';
import { AD_LIMITS } from './limits.ts';
import { percentInWords, type Figure } from './figures.ts';

/** The last line of every ad, script and carousel: rule 1. Exempt from the "no line in two ads" rule. */
export const CTA_LINE = 'Get your free income report';
/** The stamp on every frame that shows the example report (55c rule 4). */
export const EXAMPLE_STAMP = 'Example report';

export type HookVariant = 'a' | 'b';
/** The base of the two new videos and the carousel: white, or the report's own cream (#F5F4ED). */
export type LookBase = 'white' | 'cream';
export const LOOK_BASES: readonly LookBase[] = ['cream', 'white'];
export const BASE_HEX: Record<LookBase, string> = { white: '#FFFFFF', cream: '#F5F4ED' };
export type Look = { base: LookBase; hook: HookVariant };
export const DEFAULT_LOOK: Look = { base: 'cream', hook: 'a' };

export type LdConcept = {
  /** concept_id on the ad row (concepts.ts CONCEPT_ID_RE). */
  id: string;
  /** The concept sentence: landlord type + reason to try it + doubt it answers. */
  sentence: string;
  doubt: string;
  /** One plain line for the customer's screen (A7). */
  forWho: string;
  format: AdFormat;
};

export type LdSceneLine = { id: string; text: string };

export type LdAngleDef = {
  angle: Angle;
  concept: LdConcept;
  primary: readonly [string, string, string, string, string];
  headlines: readonly [string, string, string, string, string];
  descriptions: readonly [string, string, string, string, string];
  /** Frame one, two wordings. */
  hooks: Record<HookVariant, string>;
  /** The on-screen lines after frame one (scenes L2 to L4, or carousel cards 2 to 4), in order. The CTA is added last. */
  screen: readonly LdSceneLine[];
  /** The voiceover (videos only). First line the offer, last line the CTA. Spoken: numbers in words. */
  script: readonly string[] | null;
  leadFormQuestions: readonly LeadFormQuestion[];
};

export const LD_ANGLE_DEFS: Record<Angle, LdAngleDef> = {
  '5b': {
    angle: '5b',
    concept: {
      id: '5b-tenant-leaving',
      sentence:
        'Long-let landlord whose tenant is leaving gets a free report on what the property could earn as a short let, before signing another tenant for a year.',
      doubt: 'Is a short let really worth more?',
      forWho: 'For landlords whose tenant is leaving',
      format: 'phone_recording',
    },
    primary: [
      'Landlords in {area}: get a free report on what your property could earn as a short let. Tenant handed in their notice? See it before you sign another year. {company} runs it, and you stay the owner. {fee} Get your free income report.',
      'Landlords in {area}: a free income report puts your property as a short let next to a long let. It takes about a minute. You stay the owner, and {company} looks after the guests. {fee} Get your free income report.',
      'Landlords in {area}: free short-let income report, ready in about a minute. {figure|It shows occupancy, a 12-month forecast and nearby listings like yours.} {company} runs it, and you stay the owner. {fee} Get your free income report.',
      'Landlords in {area} with a tenant on notice: see a free report before you relet. It compares a short let with a long let and shows a 12-month forecast. You stay the owner. {company} does the running. {fee} Get your free income report.',
      'Landlords in {area}: your free report, short let against long let. Is your tenant leaving? Check the figures in about a minute before another year-long tenancy. {company} runs it all, and you stay the owner. {fee} Get your free income report.',
    ],
    headlines: [
      'Tenant leaving? Check a short let first',
      'Free short-let report before you relet',
      'Short let or another tenant',
      'Before you sign another year',
      'Your figures before the next tenant',
    ],
    descriptions: ['Free report, about a minute', 'Short let vs long let, free', 'Free income report for landlords', 'Compare before you relet', 'See it before the next tenancy'],
    hooks: {
      a: 'Landlords in {area}: free short-let income report',
      b: 'Free short-let income report for {area} landlords',
    },
    screen: [
      { id: 'form', text: 'Tenant handed in their notice? Answer a few questions' },
      { id: 'summary', text: 'Your report: what it could earn as a short let' },
      { id: 'compare', text: 'Short let vs long let, side by side' },
    ],
    script: [
      'Landlords in {area}, here is a free report on what your property could earn as a short let.',
      'Has your tenant handed in their notice? Before another year-long tenancy, the report shows a short let against a long let, the occupancy, and a twelve-month forecast.',
      '{figure|}',
      '{company} runs it all, and you stay the owner. {fee}',
      'Get your free income report.',
    ],
    leadFormQuestions: ANGLE_DEFS['5b'].leadFormQuestions,
  },

  '3a': {
    angle: '3a',
    concept: {
      id: '3a-moving-abroad',
      sentence: 'Homeowner moving abroad sees, from a real report, how the home can earn around their own visits and stay theirs.',
      doubt: 'Will I lose my home to a tenant?',
      forWho: 'For homeowners moving abroad who want to keep their home',
      format: 'report_carousel',
    },
    primary: [
      "Homeowners in {area} moving abroad: get a free income report on letting your home as a short let. See what it could earn around your own visits. {company} looks after it while you're away, and you stay the owner. {fee} Get your free income report.",
      'Homeowners in {area} heading abroad: a free report shows what your home could earn while you are away. You block out the weeks you want it, and guests book the rest. You stay the owner. {fee} Get your free income report.',
      'Homeowners in {area} moving abroad: free income report for your home, in about a minute. {figure|It shows a 12-month forecast and similar homes nearby.} {company} runs it, and you stay the owner. {fee} Get your free income report.',
      "Homeowners in {area} going abroad for a while: a free report shows how your home could earn and stay yours. {company} handles the guests while you're away, and you stay the owner. {fee} Get your free income report.",
      'Homeowners in {area} working abroad: see a free income report before you let your home to a tenant. It shows the year ahead around your own trips back. You stay the owner, with {company} on hand. {fee} Get your free income report.',
    ],
    headlines: [
      'Moving abroad? Keep your home yours',
      'Earn around your own visits home',
      'Your home, while you are away',
      'Keep it for your trips back',
      'See the year ahead for your home',
    ],
    descriptions: ['Free report for your home', 'Around your own visits', 'Your home stays yours', 'A 12-month forecast, free', 'Free, about a minute'],
    hooks: {
      a: "Moving abroad from {area}: see what your home could earn while you're away. Free income report",
      b: 'Homeowners in {area} moving abroad: a free report on what your home could earn',
    },
    screen: [
      { id: 'forecast', text: 'A 12-month forecast around your own visits' },
      { id: 'comparables', text: 'Similar homes nearby that guests already book' },
      { id: 'owner', text: 'Your home stays yours' },
    ],
    script: null,
    leadFormQuestions: ANGLE_DEFS['3a'].leadFormQuestions,
  },

  '17': {
    angle: '17',
    concept: {
      id: '17-rules-changed',
      sentence: 'Landlord unsure about renting rules gets the nearby short lets and their occupancy, so the choice is based on the local market.',
      doubt: 'Is there demand where I am?',
      forWho: 'For landlords unsure about the new renting rules',
      format: 'loupe',
    },
    primary: [
      "Landlords in {area}: a free income report on the short lets near you and how often they're booked. The renting rules have changed, so start from the local market. {company} runs it, and you stay the owner. {fee} Get your free income report.",
      'Landlords in {area}: a free report on local demand for short lets, with the occupancy of listings near you. Weighing up the renting rules? Start from the market. You stay the owner. {company} does the running. {fee} Get your free income report.',
      'Landlords in {area}: free report on nearby short lets and their occupancy, in about a minute. {figure|It shows local demand through the year.} {company} runs it, and you stay the owner. {fee} Get your free income report.',
      'Landlords in {area} rethinking long lets: get a free income report built on the short lets around you. The renting rules have changed, and the local market can guide the next step. You stay the owner. {fee} Get your free income report.',
      'Landlords in {area}: a free report on nearby listings like yours, their bookings and demand by month. Is there demand where you are? Check in about a minute. {company} runs it, and you stay the owner. {fee} Get your free income report.',
    ],
    headlines: [
      'See the short lets near you',
      'How often are they booked near you',
      'Renting rules changed? See the market',
      'Local demand, from a free report',
      'Start from the local market',
    ],
    descriptions: ['Local demand, free report', 'Nearby listings and occupancy', 'Your local market, free', 'Short lets near you, free', 'Demand by month near you'],
    hooks: {
      a: "Landlords in {area}: a free report on the short lets near you and how often they're booked",
      b: "{area} landlords: free report on nearby short lets and how often they're booked",
    },
    screen: [
      { id: 'comparables', text: 'Nearby short lets like yours' },
      { id: 'occupancy', text: 'How often they are booked' },
      { id: 'demand', text: 'Local demand, month by month' },
    ],
    script: [
      "Landlords in {area}, see the short lets near you and how often they're booked, in a free income report.",
      'The rules for renting to tenants have changed, so base your next step on the local market.',
      'The report shows nearby listings like yours, their occupancy, and local demand through the year.',
      'With {company} running it, you stay the owner. {fee}',
      'Get your free income report.',
    ],
    leadFormQuestions: ANGLE_DEFS['17'].leadFormQuestions,
  },
};

export function ldAngleDef(angle: Angle): LdAngleDef {
  return LD_ANGLE_DEFS[angle];
}

/** The concept and format of each lead database ad (55c A6, Phase 2 values; concepts.ts conceptFor returns the same, a test pins it). */
export function ldConceptFor(angle: Angle): { conceptId: string; format: AdFormat } {
  const c = LD_ANGLE_DEFS[angle].concept;
  return { conceptId: c.id, format: c.format };
}

// ── Filling ──

export type LdBrand = { company: string; area: string; feePct: number | null };

type Slots = { company: string; area: string; fee: string; figure: string | null };

const SLOT_RE = /\{(company|area|figure|fee)(?:\|([^{}]*))?\}/g;

function tidy(s: string): string {
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,!?:])/g, '$1')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function atSentenceStart(before: string): boolean {
  const t = before.trimEnd();
  return t === '' || /[.!?:]$/.test(t);
}

function fill(template: string, s: Slots): string {
  return tidy(
    template.replace(SLOT_RE, (_m: string, name: string, fallback: string | undefined, offset: number, whole: string) => {
      switch (name) {
        case 'company': {
          const c = s.company.replace(/\s+/g, ' ').trim();
          if (c) return c;
          return atSentenceStart(whole.slice(0, offset)) ? 'Our team' : 'our team';
        }
        case 'area':
          return s.area.replace(/\s+/g, ' ').trim() || 'your area';
        case 'fee':
          return s.fee || fallback || '';
        case 'figure':
          return s.figure ?? fallback ?? '';
        default:
          return '';
      }
    }),
  );
}

function spokenFee(feePct: number | null): string {
  return feeSentence(feePct) ? `Our management fee is ${percentInWords(feePct as number)}.` : '';
}

function slotsOf(brand: LdBrand, figure: Figure | null, spoken = false): Slots {
  return {
    company: String(brand.company ?? ''),
    area: String(brand.area ?? ''),
    fee: spoken ? spokenFee(brand.feePct) : feeSentence(brand.feePct),
    figure: figure ? (spoken ? figure.spoken : figure.sentence) : null,
  };
}

/** A primary text: the fee goes first, then the figure, when the filled text would be over Meta's 300 characters. */
function fillPrimary(t: string, brand: LdBrand, figure: Figure | null): string {
  const full = slotsOf(brand, figure);
  let last = '';
  for (const s of [full, { ...full, fee: '' }, { ...full, fee: '', figure: null }]) {
    last = fill(t, s);
    if (last.length <= AD_LIMITS.primary.hard) return last;
  }
  return last;
}

export type LdRendered = {
  primary: string[];
  headlines: string[];
  descriptions: string[];
  /** Frame one, then the scene lines, then the CTA: every line the viewer reads on screen. */
  screenLines: string[];
  /** The voiceover lines (videos), else null. */
  script: string[] | null;
};

export function renderLdTexts(input: { angle: Angle; brand: LdBrand; figure: Figure | null; look?: Look }): LdRendered {
  const def = LD_ANGLE_DEFS[input.angle];
  if (!def) throw new Error('renderLdTexts: unknown angle');
  const look = input.look ?? DEFAULT_LOOK;
  const slots = slotsOf(input.brand, input.figure);
  const spoken = slotsOf(input.brand, input.figure, true);
  return {
    primary: def.primary.map((t) => fillPrimary(t, input.brand, input.figure)),
    headlines: def.headlines.map((t) => fill(t, slots)),
    descriptions: def.descriptions.map((t) => fill(t, slots)),
    screenLines: [fill(def.hooks[look.hook], slots), ...def.screen.map((l) => fill(l.text, slots)), CTA_LINE],
    script: def.script ? def.script.map((t) => fill(t, spoken)).filter((l) => l !== '') : null,
  };
}

/** Every angle's rendered texts, for the gate and the tests. */
export function renderLdPack(brand: LdBrand, figure: Figure | null, look: Look = DEFAULT_LOOK): Record<Angle, LdRendered> {
  const out = {} as Record<Angle, LdRendered>;
  for (const a of ANGLES) out[a] = renderLdTexts({ angle: a, brand, figure, look });
  return out;
}

/**
 * The type-only cards a lead database image ad shows until (or instead of) the example report pages: one card per
 * on-screen line, the last one the CTA. Used for 3a (the carousel's fallback) and 17 (the loupe's static fallback) when
 * the example report failed (55c section 8), and as the placeholder while it is being made.
 */
export function ldFallbackCards(r: Pick<LdRendered, 'screenLines'>): Card[] {
  const lines = r.screenLines.filter((l) => l.trim() !== '');
  return lines.map((line, i) => {
    const last = i === lines.length - 1;
    return { id: last ? 'cta' : `line${i + 1}`, headline: line, body: last ? ['You stay the owner.'] : [], cta: last ? CTA_LINE : 'Swipe', big: null, label: null, figure: false };
  });
}
