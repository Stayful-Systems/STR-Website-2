/**
 * Batch 38: the three angles of an operator's ad pack, as FIXED templates.
 *
 * No AI writes any of this at runtime. Every text below is reviewed once, in
 * the pull request, and the render functions only fill slots:
 *
 *   {company}    the operator's company name
 *   {area}       the area as the website shows it
 *   {bedrooms}-bed   "3-bed", or "home" when no bedroom count is known
 *   {figure|x}   the labelled example sentence (figures.ts), or x when the
 *                area has too little data. Always a whole sentence, so there
 *                is never a hole in the text
 *   {fee|x}      "Our management fee is 12%.", only when the operator set a
 *                fee, else x (nothing, when x is left out)
 *
 * Rules every template obeys (checked by angles.test.ts):
 *   - one labelled example per ad, never a range, never "you will earn",
 *     never a guarantee
 *   - every primary text says "you stay the owner"
 *   - angle 17 says only "the rules for renting to tenants have changed":
 *     no named law, no legal claim, no region
 *   - headlines never contain {company} or {area}, so they fit 27 characters
 *   - UK English, no em dashes, no fee or figure that is not the operator's own
 *
 * Pure: no network, no database, no server-only.
 */

import type { Angle } from './codes.ts';
import { AD_LIMITS, checkLength } from './limits.ts';
import { percentInWords, type Figure } from './figures.ts';

export type AngleBrand = {
  company: string;
  area: string;
  bedrooms: number | null;
  /** The operator's management fee percent, or null (then no fee is ever mentioned). */
  feePct: number | null;
};

export type RenderInput = { angle: Angle; brand: AngleBrand; figure: Figure | null };

export type RenderedTexts = { primary: string[]; headlines: string[]; descriptions: string[] };

export type CardTemplate = {
  id: string;
  headline: string;
  /** 2 to 4 lines; a line that is only an optional clause ({fee}) is dropped when empty. */
  body: string[];
  cta: string;
  /** The example-figure card: dropped when there is no figure. */
  figure?: boolean;
};

export type Card = {
  id: string;
  headline: string;
  body: string[];
  cta: string;
  /** The big number on a figure card ("£2,350 a month"), else null. */
  big: string | null;
  /** The label that must sit with the big number, else null. */
  label: string | null;
  figure: boolean;
};

export type LeadFormQuestion = {
  id: string;
  label: string;
  kind: 'choice' | 'text';
  options?: string[];
  required: boolean;
};

export type AngleDef = {
  angle: Angle;
  label: string;
  audience: string;
  rationale: string;
  primary: readonly [string, string, string, string, string];
  headlines: readonly [string, string, string, string, string];
  descriptions: readonly [string, string, string, string, string];
  /** Image-card text (3a and 17). The 5b ad is a video: no cards. */
  cards: readonly CardTemplate[];
  /** Questions for a Meta instant form (Batch 35). Stored here, not shown in 36. */
  leadFormQuestions: readonly LeadFormQuestion[];
};

// ── The templates ──

const FIGURE_CARD_BODY_2 = 'Rounded, and an average of past reports.';

export const ANGLE_DEFS: Record<Angle, AngleDef> = {
  '5b': {
    angle: '5b',
    label: 'Tenant handed in notice',
    audience: 'Long-let landlords whose tenant has given notice or just moved out, deciding what to do before the agent relets.',
    rationale: 'A tenant leaving is a dated moment: the landlord is choosing what comes next, so the ad lands before the next tenancy is signed.',
    primary: [
      'Tenant handed in their notice? Before your agent relets, {company} can run it as a short-term let, like an Airbnb. {figure|Guests stay a few nights, not a year, so there is no tenancy to get stuck in. Find out what yours could take home.} You stay the owner. {fee}',
      'Tenant just moved out? Before you sign the next one up for a year, see what a short-term let, like an Airbnb, could take home. {company} runs it all. Check yours in a minute. You stay the owner. {fee}',
      'Between tenants in {area}? Guests stay a few nights, not a year, so there is no tenancy to get stuck in. {company} looks after the guests and the keys. Check what yours could take home. You stay the owner. {fee}',
      'While your tenant works out their notice, find out what your property could take home as a short-term let, like an Airbnb. {company} looks after the guests, the cleaning and the keys. You stay the owner. {fee}',
      'Landlords: before another tenant, compare a short-term let, like an Airbnb. {figure|Guests stay a few nights, not a year, so there is no tenancy to get stuck in. It takes about a minute to check yours.} {company} runs it, and you stay the owner. {fee}',
    ],
    headlines: [
      'Before your agent relets',
      'Tenant leaving? Check first',
      'Tenant gave notice?',
      'Another way to let it',
      'No tenancy to get stuck in',
    ],
    descriptions: [
      'A short-term let, like an Airbnb, with guests who stay days, not years. No tenancy.',
      'Answer a few quick questions while they work out their notice. It takes a minute.',
      '{company} runs it all, and you stay the owner.',
      'Check what your property could take home in about a minute. {fee}',
      'See what a typical {bedrooms}-bed in {area} could take home.',
    ],
    cards: [],
    leadFormQuestions: [
      { id: 'notice', label: 'Where are you with the tenancy?', kind: 'choice', options: ['The tenant has already left', 'Notice has been given', 'Notice is expected soon', 'Not sure yet'], required: true },
      { id: 'ownership', label: 'Do you own the property?', kind: 'choice', options: ['Yes, I own it outright', 'Yes, with a mortgage', 'It is owned jointly', 'No'], required: true },
      { id: 'bedrooms', label: 'How many bedrooms does it have?', kind: 'choice', options: ['1', '2', '3', '4', '5 or more'], required: true },
      { id: 'postcode', label: 'What is the property postcode?', kind: 'text', required: true },
    ],
  },

  '3a': {
    angle: '3a',
    label: 'Moving abroad',
    audience: 'Homeowners moving or working abroad who want to keep the home and have it for their own visits.',
    rationale: 'A leaving date is a clear trigger, and a tenant makes the home theirs all year, so there is nowhere to stay when the owner flies back.',
    primary: [
      "Moving abroad, but want to keep your home for when you come back? {company} can run it as a short-term let, like an Airbnb. {figure|You block out the weeks you're home, and guests book the rest. Find out what yours could take home.} You stay the owner. {fee}",
      "If you rent it to a tenant, it's their home all year, so there's nowhere to stay when you fly back. {company} runs it as a short-term let instead, like an Airbnb. Check yours in a minute. You stay the owner. {fee}",
      "Going abroad for a while? While you're away, {company} looks after the guests, the cleaning, the maintenance and the keys. You block out your own weeks, and you stay the owner. Check what yours could take home. {fee}",
      "Home empty while you're abroad? {company} can let it as a short-term let, like an Airbnb, around your trips back. {figure|You block out the weeks you're home, and guests book the rest. Find out what yours could take home.} You stay the owner. {fee}",
      "Keeping the house in {area} while you're away? Block out the weeks you're home, and let guests book the rest. {company} runs it all, and you stay the owner. It takes about a minute to check yours. {fee}",
    ],
    headlines: [
      'Moving abroad? Keep it',
      'Block out your own weeks',
      'Keep it for your trips back',
      'Your home, looked after',
      "Don't leave it empty",
    ],
    descriptions: [
      "Block out the weeks you're home and guests book the rest. You stay the owner.",
      "While you're away, we look after the guests, the cleaning and the keys.",
      '{company} runs it all. You block out your own weeks.',
      'Find out what yours could take home around your trips back. {fee}',
      'See what a typical {bedrooms}-bed in {area} could take home.',
    ],
    cards: [
      {
        id: 'hook',
        headline: 'Moving abroad, but want to keep your home for when you come back?',
        body: ["If you rent it to a tenant, it's their home all year.", 'A short-term let, like an Airbnb, keeps it yours.'],
        cta: 'Swipe to see how',
      },
      {
        id: 'weeks',
        headline: "You block out the weeks you're home",
        body: ['{company} runs it as a short-term let, like an Airbnb.', 'Guests book the rest.'],
        cta: 'Swipe',
      },
      { id: 'figure', headline: '', body: ['{label}', FIGURE_CARD_BODY_2], cta: 'Swipe', figure: true },
      {
        id: 'away',
        headline: "While you're away, we look after it all",
        body: ['The guests, the cleaning, the maintenance and the keys.', 'You stay the owner.'],
        cta: 'Swipe',
      },
      {
        id: 'cta',
        headline: 'What could your home bring in around your trips back?',
        body: ['It takes about a minute to check.', '{company} runs it all, and you stay the owner.', '{fee}'],
        cta: 'Find out what yours could take home',
      },
    ],
    leadFormQuestions: [
      { id: 'leaving', label: 'When are you moving abroad?', kind: 'choice', options: ['Already abroad', 'Within 3 months', '3 to 12 months', 'Not decided yet'], required: true },
      { id: 'visits', label: 'How many weeks a year would you want the home for yourself?', kind: 'choice', options: ['Fewer than 4', '4 to 8', 'More than 8', 'Not sure'], required: false },
      { id: 'ownership', label: 'Do you own the property?', kind: 'choice', options: ['Yes, I own it outright', 'Yes, with a mortgage', 'It is owned jointly', 'No'], required: true },
      { id: 'postcode', label: 'What is the property postcode?', kind: 'text', required: true },
    ],
  },

  '17': {
    angle: '17',
    label: 'Renting rules changed',
    audience: 'Long-let landlords unsettled by changes to renting, best reached when a tenancy is ending anyway (pairs with the notice ad).',
    rationale: 'It says only that the rules for renting to tenants have changed and offers a way to let with no tenancy and full control, with no legal claim.',
    primary: [
      'The rules for renting to tenants have changed. {company} runs it as a short-term let, like an Airbnb. {figure|Guests stay days, not years, so there is no tenancy. If yours is ending anyway, find out what it could take home.} You stay the owner and in control. {fee}',
      'The rules for renting to tenants have changed. Guests stay days, not years, so there is no tenancy at all. {company} runs it all. Check what yours could take home. You stay the owner and stay in control. {fee}',
      "Want to stay in control of your property? As a short-term let, like an Airbnb, guests stay days, not years, so there's no tenancy. {company} runs it all. Check yours in a minute. You stay the owner. {fee}",
      'Between tenants, or thinking about it? The rules for renting to tenants have changed, so compare before you sign again. {company} runs it all, and you stay the owner and in control. {fee}',
      'No tenancy: guests stay days, not years. {company} runs it as a short-term let, like an Airbnb. {figure|You block your own dates, and keep the property yours. It takes about a minute to check yours.} You stay the owner and in control. {fee}',
    ],
    headlines: [
      'Renting rules have changed',
      'Guests stay days, not years',
      'You stay in control',
      'Compare before you relet',
      'No tenancy to worry about',
    ],
    descriptions: [
      'The rules for renting to tenants have changed. See another way to let it.',
      'No tenancy: guests stay days, not years, and you stay the owner.',
      '{company} runs it all, and you stay in control.',
      'Compare a short-term let before you sign again. {fee}',
      'Block out your own dates and keep the property yours. Guests stay days, not years.',
    ],
    cards: [
      {
        id: 'hook',
        headline: 'The rules for renting to tenants have changed',
        body: ['If your tenancy is ending anyway, there is another way to let your property.', 'A short-term let, like an Airbnb.'],
        cta: 'Swipe to see how',
      },
      {
        id: 'no-tenancy',
        headline: 'No tenancy: guests stay days, not years',
        body: ['Guests book a few nights at a time.', 'There is no tenancy to get stuck in.'],
        cta: 'Swipe',
      },
      { id: 'figure', headline: '', body: ['{label}', FIGURE_CARD_BODY_2], cta: 'Swipe', figure: true },
      {
        id: 'control',
        headline: 'You stay in control',
        body: ['You stay the owner.', 'Block your own dates, and keep the property yours.'],
        cta: 'Swipe',
      },
      {
        id: 'cta',
        headline: 'Compare before you sign another tenancy',
        body: ['Check what yours could take home in about a minute.', '{company} runs it all, and you stay in control.', '{fee}'],
        cta: 'Check yours in a minute',
      },
    ],
    leadFormQuestions: [
      { id: 'tenant', label: 'Is there a tenant in the property now?', kind: 'choice', options: ['No, it is empty', 'Yes, and the tenancy is ending', 'Yes, and it is continuing', 'Not sure'], required: true },
      { id: 'ownership', label: 'Do you own the property?', kind: 'choice', options: ['Yes, I own it outright', 'Yes, with a mortgage', 'It is owned jointly', 'No'], required: true },
      { id: 'bedrooms', label: 'How many bedrooms does it have?', kind: 'choice', options: ['1', '2', '3', '4', '5 or more'], required: true },
      { id: 'postcode', label: 'What is the property postcode?', kind: 'text', required: true },
    ],
  },
};

/** The voiceover for the 5b video (38b). One string per paragraph; spoken, so numbers are words. */
export const SCRIPT_5B: readonly string[] = [
  "Has your tenant handed in their notice? We're {company}, and before your agent lines up the next one, there's another way to let it.",
  "It's a short-term let, like an Airbnb. Guests book a few nights at a time, and we run it all for you in {area}.",
  '{figure|It only takes a minute to find out what yours could take home.}',
  "And when guests check out, there's no tenancy to get stuck in. You stay the owner. {fee}",
  "So while they're working out their notice, have a look at our website. It takes about a minute, and there's no commitment.",
];

export function angleDef(angle: Angle): AngleDef {
  return ANGLE_DEFS[angle];
}

// ── Rendering ──

const SLOT_RE = /\{(company|area|figure|fee)(?:\|([^{}]*))?\}|\{bedrooms\}-bed/g;

type Slots = { company: string; area: string; bedrooms: number | null; fee: string; figure: string | null; figureFallbackOnly?: boolean };

/** "Our management fee is 12%." or '' when no usable fee is set. */
export function feeSentence(feePct: number | null | undefined): string {
  if (typeof feePct !== 'number' || !Number.isFinite(feePct) || feePct <= 0 || feePct > 100) return '';
  return `Our management fee is ${Number.isInteger(feePct) ? feePct : Number(feePct.toFixed(1))}%.`;
}

function tidy(s: string): string {
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function atSentenceStart(before: string): boolean {
  const t = before.trimEnd();
  return t === '' || /[.!?:]$/.test(t);
}

function fill(template: string, slots: Slots): string {
  const out = template.replace(SLOT_RE, (m: string, name: string | undefined, fallback: string | undefined, offset: number, whole: string) => {
    if (m === '{bedrooms}-bed') {
      return slots.bedrooms && slots.bedrooms >= 1 ? `${slots.bedrooms}-bed` : 'home';
    }
    switch (name) {
      case 'company': {
        const c = slots.company.trim();
        if (c) return c;
        return atSentenceStart(whole.slice(0, offset)) ? 'Our team' : 'our team';
      }
      case 'area':
        return slots.area.trim() || 'your area';
      case 'fee':
        return slots.fee || fallback || '';
      case 'figure':
        return slots.figure ?? fallback ?? '';
      default:
        return '';
    }
  });
  return tidy(out);
}

function slotsOf(brand: AngleBrand, figure: Figure | null, spoken = false): Slots {
  return {
    company: String(brand.company ?? ''),
    area: String(brand.area ?? ''),
    bedrooms: brand.bedrooms ?? null,
    fee: spoken ? spokenFee(brand.feePct) : feeSentence(brand.feePct),
    figure: figure ? (spoken ? figure.spoken : figure.sentence) : null,
  };
}

function spokenFee(feePct: number | null | undefined): string {
  if (!feeSentence(feePct)) return '';
  return `Our management fee is ${percentInWords(feePct as number)}.`;
}

/**
 * A primary text. The fee and the example figure are optional: if the filled
 * text would be over the 300-character limit, the fee goes first, then the
 * example (its fallback sentence takes its place), so a long company or area
 * name never produces a text Meta would refuse.
 */
function fillPrimary(template: string, brand: AngleBrand, figure: Figure | null): string {
  const full = slotsOf(brand, figure);
  const attempts: Slots[] = [full, { ...full, fee: '' }, { ...full, fee: '', figure: null }];
  let last = '';
  for (const s of attempts) {
    last = fill(template, s);
    if (last.length <= AD_LIMITS.primary.hard) return last;
  }
  return last;
}

export function renderTexts(input: RenderInput): RenderedTexts {
  const def = ANGLE_DEFS[input.angle];
  if (!def) throw new Error('renderTexts: unknown angle');
  const { brand, figure } = input;
  const slots = slotsOf(brand, figure);
  return {
    primary: def.primary.map((t) => fillPrimary(t, brand, figure)),
    headlines: def.headlines.map((t) => fill(t, slots)),
    descriptions: def.descriptions.map((t) => {
      const filled = fill(t, slots);
      // A description with the fee that runs over the limit loses the fee, never its sense.
      return filled.length > AD_LIMITS.description.hard ? fill(t, { ...slots, fee: '' }) : filled;
    }),
  };
}

function basisTitle(figure: Figure): string {
  return figure.basis === 'take-home' ? 'Take-home, after costs and fees' : figure.basis === 'net' ? 'After costs' : 'Bookings, before costs';
}

/** The image-card text for 3a and 17 (5b is a video and has none). Figure cards are dropped when there is no figure. */
export function renderCards(input: RenderInput): Card[] {
  const def = ANGLE_DEFS[input.angle];
  if (!def) throw new Error('renderCards: unknown angle');
  const { brand, figure } = input;
  const slots = slotsOf(brand, figure);
  const cards: Card[] = [];
  for (const c of def.cards) {
    if (c.figure && !figure) continue;
    const label = c.figure && figure ? figure.label : null;
    const body = c.body
      .map((line) => (line === '{label}' ? (figure ? figure.label : '') : fill(line, slots)))
      .filter((line) => line !== '');
    cards.push({
      id: c.id,
      headline: c.figure && figure ? basisTitle(figure) : fill(c.headline, slots),
      body,
      cta: fill(c.cta, slots),
      big: c.figure && figure ? figure.amountText : null,
      label,
      figure: Boolean(c.figure),
    });
  }
  return cards;
}

export type RenderedScript = { lines: string[]; text: string; words: number };

/** The 5b voiceover with its slots filled. Spoken: no £, numbers in words. */
export function renderScript(input: { brand: AngleBrand; figure: Figure | null }): RenderedScript {
  const slots = slotsOf(input.brand, input.figure, true);
  const lines = SCRIPT_5B.map((t) => fill(t, slots)).filter((l) => l !== '');
  const text = lines.join('\n\n');
  return { lines, text, words: text.split(/\s+/).filter(Boolean).length };
}

/** Length level of every rendered text, for the screen and the tests. */
export function checkRendered(r: RenderedTexts): { kind: 'primary' | 'headline' | 'description'; text: string; level: 'green' | 'amber' | 'red' }[] {
  return [
    ...r.primary.map((text) => ({ kind: 'primary' as const, text, level: checkLength('primary', text).level })),
    ...r.headlines.map((text) => ({ kind: 'headline' as const, text, level: checkLength('headline', text).level })),
    ...r.descriptions.map((text) => ({ kind: 'description' as const, text, level: checkLength('description', text).level })),
  ];
}
