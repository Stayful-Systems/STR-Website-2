/**
 * Batch 55 step 5 (Phase 2, 55c A4): the copy of a LEAD DATABASE pack, as FIXED templates.
 *
 * The Academy route keeps angles.ts (its 45 templates, SCRIPT_5B and the type cards) byte for byte. Everything here
 * is chosen only by `ad_packs.route = 'leaddb'`. No AI writes any of this at runtime: every line is reviewed once in the
 * pull request (PROPOSED wording, 55c section 4), and the render functions only fill slots:
 *
 *   {company}   the customer's company name ("Our team" when empty)
 *   {in_area}   Phase 3, where the customer finds landlords (coverage.ts inAreaPhrase): "across the UK", "in Leeds",
 *               "in Leeds, York and Harrogate", "in Leeds, York, Harrogate and nearby areas" ("in your area" when empty)
 *   {manage}    one sentence naming EVERY chosen area: "Acme manages short lets in Leeds, York and Harrogate." or
 *               "Acme manages short lets across the UK." (coverage.ts manageSentence)
 *   {short_in}  frame one and the on-screen lines: up to 2 areas then "and more" ("in Leeds, York and more")
 *   {spoken_in} the voiceover: up to 2 areas then "and nearby areas"
 *   {places}    the fifth headline (coverageHeadline): up to 2 names then "and more", as long as fits 40 characters
 *   {opt|x}     a sentence left out only when every area name would not fit in 300 characters otherwise
 *   {figure|x}  the labelled example sentence (figures.ts), or x when the area has too little data
 *   {fee|x}     "Our management fee is 12%.", only when the customer set a fee, else x (nothing)
 *
 * Rules every template obeys (ld-angles.test.ts and the gate in ld-gate.ts):
 *   1. offer first: every primary text names the audience, the coverage ("across the UK" or the first area), "free"
 *      and "report" in its first 125 characters (the full area list is in {manage}, after it),
 *      and the first spoken line and frame one say the offer; the last line is "Get your free income report"
 *   2. no question mark in the first sentence; a trigger question only as the second line
 *   3. claims only from the facts list (facts.ts): what the report contains, free, about a minute, the customer's
 *      company, areas (or the UK) and own fee, you stay the owner. Never "you will earn", a guarantee, a range or Stayful
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
import { placeCandidates, inAreaPhrase, manageSentence, shortInPhrase, spokenInPhrase, type Coverage } from './coverage.ts';

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
  /** Four fixed headlines; the fifth is `coverageHeadline` (Phase 3). */
  headlines: readonly [string, string, string, string];
  /**
   * Phase 3: the fifth headline, which says where. `uk` for a nationwide pack; `areas` with {places}: up to 2 names then
   * "and more", fewer when it would pass Meta's 40 characters, and "your area" as the last resort.
   */
  coverageHeadline: { uk: string; areas: string };
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
      'Landlords {in_area}: get a free report on what your property could earn as a short let. {opt|Tenant handed in their notice? See it before you sign another year.} {manage} You stay the owner. {fee} Get your free income report.',
      'Landlords {in_area}: a free income report puts your property as a short let next to a long let. {manage} You stay the owner{opt|, and the guests are looked after for you}. {fee} Get your free income report.',
      'Landlords {in_area}: free short-let income report, ready in about a minute. {figure|It shows occupancy, a 12-month forecast and nearby listings like yours.} {manage} You stay the owner. {fee} Get your free income report.',
      'Landlords {in_area} with a tenant on notice: see a free report before you relet, short let against long let. {manage} You stay the owner. {fee} Get your free income report.',
      'Landlords {in_area}: your free report, short let against long let. {opt|Is your tenant leaving? Check the figures before another year-long tenancy.} {manage} You stay the owner. {fee} Get your free income report.',
    ],
    headlines: [
      'Tenant leaving? Check a short let first',
      'Free short-let report before you relet',
      'Short let or another tenant',
      'Before you sign another year',
    ],
    coverageHeadline: { uk: 'Free report for UK landlords', areas: 'Free report for {places}' },
    descriptions: ['Free report, about a minute', 'Short let vs long let, free', 'Free income report for landlords', 'Compare before you relet', 'See it before the next tenancy'],
    hooks: {
      a: 'Landlords {short_in}: free short-let income report',
      b: 'Free short-let income report for landlords {short_in}',
    },
    screen: [
      { id: 'form', text: 'Tenant handed in their notice? Answer a few questions' },
      { id: 'summary', text: 'Your report: what it could earn as a short let' },
      { id: 'compare', text: 'Short let vs long let, side by side' },
    ],
    script: [
      'Landlords {spoken_in}, here is a free report on what your property could earn as a short let.',
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
      'Homeowners {in_area} moving abroad: get a free income report on letting your home as a short let{opt|, around your own visits}. {manage} You stay the owner. {fee} Get your free income report.',
      'Homeowners {in_area} heading abroad: a free report shows what your home could earn while you are away. {opt|You block out the weeks you want it, and guests book the rest.} {manage} You stay the owner. {fee} Get your free income report.',
      'Homeowners {in_area} moving abroad: free income report for your home, in about a minute. {figure|It shows a 12-month forecast and similar homes nearby.} {manage} You stay the owner. {fee} Get your free income report.',
      'Homeowners {in_area} going abroad for a while: a free report shows how your home could earn and stay yours. {manage} You stay the owner. {fee} Get your free income report.',
      'Homeowners {in_area} working abroad: see a free income report before you let your home to a tenant{opt|, with the year ahead around your trips back}. {manage} You stay the owner. {fee} Get your free income report.',
    ],
    headlines: [
      'Moving abroad? Keep your home yours',
      'Earn around your own visits home',
      'Your home, while you are away',
      'Keep it for your trips back',
    ],
    coverageHeadline: { uk: 'A free report for UK homeowners', areas: 'Your home in {places}' },
    descriptions: ['Free report for your home', 'Around your own visits', 'Your home stays yours', 'A 12-month forecast, free', 'Free, about a minute'],
    hooks: {
      a: "Homeowners {short_in} moving abroad: see what your home could earn while you're away. Free income report",
      b: 'A free report for homeowners {short_in} moving abroad: what your home could earn',
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
      "Landlords {in_area}: a free income report on the short lets near you and how often they're booked. {opt|The renting rules have changed, so start from the local market.} {manage} You stay the owner. {fee} Get your free income report.",
      'Landlords {in_area}: a free report on local demand for short lets, with the occupancy of listings near you. {manage} You stay the owner. {fee} Get your free income report.',
      'Landlords {in_area}: free report on nearby short lets and their occupancy, in about a minute. {figure|It shows local demand through the year.} {manage} You stay the owner. {fee} Get your free income report.',
      'Landlords {in_area} rethinking long lets: get a free income report built on the short lets around you. {manage} You stay the owner. {fee} Get your free income report.',
      'Landlords {in_area}: a free report on nearby listings like yours, their bookings and demand by month. {opt|Is there demand where you are?} {manage} You stay the owner. {fee} Get your free income report.',
    ],
    headlines: [
      'See the short lets near you',
      'How often are they booked near you',
      'Renting rules changed? See the market',
      'Local demand, from a free report',
    ],
    coverageHeadline: { uk: 'Local demand across the UK', areas: 'Local demand in {places}' },
    descriptions: ['Local demand, free report', 'Nearby listings and occupancy', 'Your local market, free', 'Short lets near you, free', 'Demand by month near you'],
    hooks: {
      a: "Landlords {short_in}: a free report on the short lets near you and how often they're booked",
      b: "For landlords {short_in}: free report on nearby short lets and how often they're booked",
    },
    screen: [
      { id: 'comparables', text: 'Nearby short lets like yours' },
      { id: 'occupancy', text: 'How often they are booked' },
      { id: 'demand', text: 'Local demand, month by month' },
    ],
    script: [
      "Landlords {spoken_in}, see the short lets near you and how often they're booked, in a free income report.",
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

/**
 * The brand and the coverage the copy is filled from. `coverage` (Phase 3) says where the customer finds landlords;
 * absent, the pack covers the one `area` (the wording before Phase 3, and what a pack with coverage null reads as).
 */
export type LdBrand = { company: string; area: string; feePct: number | null; coverage?: Coverage };

type Slots = {
  company: string;
  inArea: string;
  shortIn: string;
  spokenIn: string;
  manage: string;
  places: string;
  fee: string;
  figure: string | null;
  /** The {opt|...} sentences are left out (and the figure's fallback), to make room for every area name. */
  dropOpt?: boolean;
};

const SLOT_RE = /\{(company|in_area|short_in|spoken_in|manage|places|opt|figure|fee)(?:\|([^{}]*))?\}/g;

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

const capFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function fill(template: string, s: Slots): string {
  return tidy(
    template.replace(SLOT_RE, (_m: string, name: string, fallback: string | undefined, offset: number, whole: string) => {
      const start = atSentenceStart(whole.slice(0, offset));
      switch (name) {
        case 'company': {
          const c = s.company.replace(/\s+/g, ' ').trim();
          if (c) return c;
          return start ? 'Our team' : 'our team';
        }
        case 'in_area':
          return s.inArea;
        case 'short_in':
          return s.shortIn;
        case 'spoken_in':
          return s.spokenIn;
        case 'manage':
          return s.manage;
        case 'places':
          return start ? capFirst(s.places) : s.places;
        case 'opt':
          return s.dropOpt ? '' : (fallback ?? '');
        case 'fee':
          return s.fee || fallback || '';
        case 'figure':
          return s.figure ?? (s.dropOpt ? '' : (fallback ?? ''));
        default:
          return '';
      }
    }),
  );
}

function spokenFee(feePct: number | null): string {
  return feeSentence(feePct) ? `Our management fee is ${percentInWords(feePct as number)}.` : '';
}

/** The coverage the copy says: the brand's own, else the one `area` (Phase 2 wording). */
export function coverageOfBrand(brand: Pick<LdBrand, 'area' | 'coverage'>): Coverage {
  if (brand.coverage) return brand.coverage;
  const area = String(brand.area ?? '').replace(/\s+/g, ' ').trim();
  return { mode: 'areas', areas: area ? [area] : [] };
}

function slotsOf(brand: LdBrand, figure: Figure | null, spoken = false): Slots {
  const c = coverageOfBrand(brand);
  const company = String(brand.company ?? '');
  return {
    company,
    inArea: inAreaPhrase(c),
    shortIn: shortInPhrase(c),
    spokenIn: spokenInPhrase(c),
    manage: manageSentence(company, c),
    places: placeCandidates(c)[0],
    fee: spoken ? spokenFee(brand.feePct) : feeSentence(brand.feePct),
    figure: figure ? (spoken ? figure.spoken : figure.sentence) : null,
  };
}

/**
 * A primary text. When the filled text would be over Meta's 300 characters: the fee goes first, then the figure, then
 * the {opt|...} sentences (a second reason; many area names only), then (many or long area names only) the manage sentence names the first areas and "nearby areas" instead of all of them,
 * and last it becomes "<company> runs it for you." (the opening sentence still names where).
 */
function fillPrimary(t: string, brand: LdBrand, figure: Figure | null): string {
  const full = slotsOf(brand, figure);
  const company = String(brand.company ?? '').replace(/\s+/g, ' ').trim();
  const shortManage = manageSentence(company, coverageOfBrand(brand), { short: true });
  const bare = `${company || 'Our team'} runs it for you.`;
  let last = '';
  const lean = { ...full, fee: '', figure: null, dropOpt: true };
  for (const s of [full, { ...full, fee: '' }, { ...full, fee: '', figure: null }, lean, { ...lean, manage: shortManage }, { ...lean, manage: bare }]) {
    last = fill(t, s);
    if (last.length <= AD_LIMITS.primary.hard) return last;
  }
  return last;
}

/** The fifth headline: where, as long as fits Meta's 40 characters ("Free report for Leeds, York and more", ... "your area"). */
function coverageHeadlineOf(def: LdAngleDef, brand: LdBrand, slots: Slots): string {
  const c = coverageOfBrand(brand);
  if (c.mode === 'uk') return fill(def.coverageHeadline.uk, slots);
  let last = '';
  for (const places of placeCandidates(c)) {
    last = fill(def.coverageHeadline.areas, { ...slots, places });
    if (last.length <= AD_LIMITS.headline.hard) return last;
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
    headlines: [...def.headlines.map((t) => fill(t, slots)), coverageHeadlineOf(def, input.brand, slots)],
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
