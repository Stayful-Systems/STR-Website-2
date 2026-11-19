/**
 * Batch 31: the checks a website must pass before it can go live (and that
 * every piece of generated copy passes before it is kept). They read the page
 * model, so they check exactly what a visitor would read.
 *
 *   placeholder     `{{`, [Company]-style brackets, lorem, TODO, undefined ...
 *   required        a page's own required fields, the site's required details
 *   phone / email   the contact details are real UK/email values
 *   banned_claim    guaranteed income, "no voids", "you will earn", income ranges
 *   form            a page that needs the lead form has one
 *   step1           a dry run of the step-1 validator on the form's own fields
 *
 * Result: { ok, problems: [{ page, field, rule, message }] }. A message never
 * echoes more than a short excerpt (EXCERPT_MAX characters) of the page text.
 *
 * validateStepOne is the step-1 lead validator: the lead API (Phase 6) calls
 * it and the dry run calls it, so the check and the real form agree. It is
 * built from the validators the app already has (brand.ts parseEmail,
 * credit/abuse.ts isDisposableEmail, sms/phone.ts via isUkPhone below).
 *
 * Pure: no network, no database, no server-only.
 */
import { parseEmail, parseHexColour, parseLogoUrl } from '../funnels/brand.ts';
import { isDisposableEmail, normaliseMobile } from '../credit/abuse.ts';
import { isUkMobile } from '../sms/phone.ts';
import { feeLabel, identityFields, pageFields, STEP1_FIELDS, type PageField, type PageKey, type PageModel, type SiteIdentity } from './page-model.ts';

export const EXCERPT_MAX = 40;
export const MAX_PROBLEMS = 100;

export const CHECK_RULES = ['placeholder', 'required', 'phone', 'email', 'banned_claim', 'form', 'step1', 'colour', 'logo'] as const;
export type CheckRule = (typeof CHECK_RULES)[number];

export interface CheckProblem {
  /** The page's path ("home" for the home page, "fees", "areas/leeds") or "site" for the site's own details. */
  page: string;
  field: string;
  rule: CheckRule;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  problems: CheckProblem[];
}

// ── Excerpts ──

/** A short, single-line excerpt around a match: never more than EXCERPT_MAX characters. */
export function excerpt(text: string, index: number, length: number): string {
  const flatBefore = text.slice(0, index).replace(/\s+/g, ' ').length;
  const flatMatch = text.slice(index, index + length).replace(/\s+/g, ' ');
  const flat = text.replace(/\s+/g, ' ');
  const room = Math.max(0, EXCERPT_MAX - flatMatch.length);
  const start = Math.max(0, flatBefore - Math.floor(room / 2));
  return flat.slice(start, start + EXCERPT_MAX).trim();
}

// ── Placeholders ──

const PLACEHOLDER_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\{\{|\}\}/g, what: 'template tag' },
  { re: /\$\{/g, what: 'template tag' },
  { re: /\[[^\]\n]{1,40}\]/g, what: 'bracketed placeholder' },
  { re: /\b(?:lorem|ipsum)\b|\bdolor sit amet\b/gi, what: 'filler text' },
  { re: /\b(?:TODO|TBD|FIXME)\b/gi, what: 'unfinished marker' },
  { re: /\bundefined\b|\bNaN\b|\[object Object\]/g, what: 'unset value' },
];

/** Leftover template markers in one piece of text. One entry per kind, with a short excerpt. */
export function placeholderHits(text: string): { what: string; excerpt: string }[] {
  const hits: { what: string; excerpt: string }[] = [];
  for (const { re, what } of PLACEHOLDER_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) hits.push({ what, excerpt: excerpt(text, m.index, m[0].length) });
  }
  return hits;
}

// ── Banned claims ──

const INCOME_WORDS = String.raw`(?:income|rent(?:al)?|returns?|profits?|earnings?|revenue|occupancy|bookings?|yield)`;
const MONEY = String.raw`£\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m)?`;
const PERIOD = String.raw`(?:a|per|/|each|every)?\s*(?:month|mth|pcm|week|pw|year|yr|annum|night)`;

export const BANNED_CLAIMS: { id: string; re: RegExp; what: string }[] = [
  {
    id: 'guaranteed_income',
    re: new RegExp(String.raw`\bguarantee[sd]?\b.{0,60}\b${INCOME_WORDS}\b|\b${INCOME_WORDS}\b.{0,60}\bguarantee[sd]?\b`, 'gi'),
    what: 'a guaranteed income',
  },
  { id: 'no_voids', re: /\b(?:no|zero|never\s+(?:a|any))\s+voids?\b|\bvoid[- ]free\b|\bwithout\s+(?:any\s+)?voids?\b/gi, what: '"no voids"' },
  {
    id: 'you_will_earn',
    re: /\byou(?:\s+will|'ll|\s+are\s+going\s+to|'re\s+going\s+to|\s+can\s+expect\s+to)\s+(?:definitely\s+|certainly\s+|easily\s+|always\s+)?(?:earn|make|receive|get\s+paid|be\s+paid)\b/gi,
    what: '"you will earn"',
  },
  { id: 'earn_amount', re: /\bearn(?:s|ing)?\s+(?:up\s+to\s+|as\s+much\s+as\s+|over\s+|around\s+)?£/gi, what: 'a stated earning' },
  {
    id: 'income_range',
    re: new RegExp(String.raw`${MONEY}\s*(?:-|–|—|to)\s*(?:${MONEY}|\d[\d,]*(?:\.\d+)?\s?(?:k|m)?)\s*${PERIOD}|${MONEY}\s*${PERIOD}\s*(?:-|–|—|to)\s*${MONEY}`, 'gi'),
    what: 'an income range',
  },
];

/** Banned claims in one piece of text: one entry per kind, with a short excerpt. */
export function bannedClaimHits(text: string): { id: string; what: string; excerpt: string }[] {
  const hits: { id: string; what: string; excerpt: string }[] = [];
  for (const c of BANNED_CLAIMS) {
    c.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = c.re.exec(text))) {
      // "We cannot guarantee any income" is the honest sentence, not the claim.
      if (c.id === 'guaranteed_income' && DISCLAIMER.test(text.slice(Math.max(0, m.index - 25), m.index + m[0].length))) continue;
      hits.push({ id: c.id, what: c.what, excerpt: excerpt(text, m.index, m[0].length) });
      break;
    }
  }
  return hits;
}

const DISCLAIMER = /\b(?:not|never|cannot|no)\b|n't/i;

// ── Phone and email ──

/** A UK phone number a person could ring: mobile (07...) or a landline / 03 / 08 number, in any usual spelling. */
export function isUkPhone(raw: string | null | undefined): boolean {
  const n = normaliseMobile(raw);
  if (!n || !n.startsWith('+44')) return false;
  return isUkMobile(n) || /^\+44[1238]\d{8,9}$/.test(n);
}

/** A usable email address (brand.ts parseEmail's rule). */
export function isEmail(raw: string | null | undefined): boolean {
  return parseEmail(raw) !== null;
}

// ── The step-1 validator ──

export interface StepOneInput {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  consent?: unknown;
}

export interface StepOneError {
  field: 'name' | 'email' | 'phone' | 'consent';
  message: string;
}

export type StepOneResult =
  | { ok: true; clean: { name: string; email: string; phone: string; consent: true } }
  | { ok: false; errors: StepOneError[] };

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const limit = (name: string) => STEP1_FIELDS.find((f) => f.name === name)!.maxLength;

/**
 * Step 1 of a website's form: name, a permanent email, a UK phone number and
 * the consent tick. Same rules as the funnel's analyse route where they
 * overlap (consent required, no disposable email).
 */
export function validateStepOne(input: StepOneInput): StepOneResult {
  const errors: StepOneError[] = [];
  const name = str(input?.name, limit('name'));
  const email = str(input?.email, limit('email'));
  const phone = str(input?.phone, limit('phone'));
  if (name.length < 2) errors.push({ field: 'name', message: 'Please enter your name.' });
  if (!isEmail(email)) errors.push({ field: 'email', message: 'Please enter a valid email address.' });
  else if (isDisposableEmail(email)) errors.push({ field: 'email', message: 'Please use a permanent email address so your estimate can reach you.' });
  if (!isUkPhone(phone)) errors.push({ field: 'phone', message: 'Please enter a UK phone number.' });
  if (input?.consent !== true) errors.push({ field: 'consent', message: 'Please confirm you are happy to be contacted before continuing.' });
  if (errors.length) return { ok: false, errors };
  return { ok: true, clean: { name, email: email.toLowerCase(), phone, consent: true } };
}

/** A sample value per step-1 field: a valid one (Ofcom's drama number range for the phone). */
export const STEP1_SAMPLE: Record<string, string> = {
  name: 'Alex Sample',
  email: 'alex.sample@gmail.com',
  phone: '07700 900123',
};

/**
 * Dry run of step 1: builds a sample post from the form's own fields (and its
 * consent tick) and runs the real validator on it. Fails when the form has a
 * field the validator needs missing, or when the sample would not pass.
 */
export function stepOneDryRun(form: PageModel['form']): { ok: boolean; problems: { field: string; message: string }[] } {
  const problems: { field: string; message: string }[] = [];
  if (!form) return { ok: false, problems: [{ field: 'form', message: 'There is no lead form.' }] };
  if (!/^\/api\/s\/[^/]+\/lead$/.test(form.action)) problems.push({ field: 'form.action', message: 'The form does not post to the lead address.' });
  const sample: Record<string, unknown> = {};
  for (const need of STEP1_FIELDS) {
    const f = form.fields.find((x) => x.name === need.name);
    if (!f) problems.push({ field: `form.${need.name}`, message: `The form has no ${need.name} field.` });
    else if (f.maxLength < 1) problems.push({ field: `form.${need.name}`, message: `The ${need.name} field cannot hold a value.` });
    else sample[need.name] = (STEP1_SAMPLE[need.name] ?? '').slice(0, f.maxLength);
  }
  if (form.consentField !== 'consent' || !form.consentText.trim()) problems.push({ field: 'form.consent', message: 'The form has no consent wording.' });
  else sample.consent = true;
  if (problems.length === 0) {
    const r = validateStepOne(sample);
    if (!r.ok) for (const e of r.errors) problems.push({ field: `form.${e.field}`, message: `The form's own sample would be refused (${e.field}).` });
  }
  return { ok: problems.length === 0, problems };
}

// ── The checks ──

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const pageLabel = (p: PageModel) => p.path || 'home';

/** Pages a visitor must be able to submit the lead form from. */
export const PAGES_NEEDING_FORM: readonly PageKey[] = ['home', 'area', 'fees', 'about', 'faq'];

/** Which text fields each page must have non-empty, besides the heading. */
function requiredFields(p: PageModel): { field: string; ok: boolean }[] {
  const text = (id: string) => p.sections.find((s) => s.id === id)?.paragraphs.some((t) => t.trim()) === true;
  const base = [{ field: 'heading', ok: p.heading.trim() !== '' }];
  switch (p.key) {
    case 'home':
      return [...base, { field: 'intro', ok: p.intro.trim() !== '' }, { field: 'section:benefits', ok: p.sections.some((s) => s.id.startsWith('benefit-') && s.paragraphs.length > 0) }];
    case 'area':
      return [...base, { field: 'section:body', ok: text('body') }];
    case 'fees':
      return [...base, { field: 'section:fee', ok: text('fee') }, { field: 'section:body', ok: text('body') }];
    case 'about':
      return [...base, { field: 'section:body', ok: text('body') }];
    case 'faq':
      return [...base, { field: 'faq', ok: p.faq.length > 0 && p.faq.every((q) => q.question !== '' && q.answer !== '') }];
    case 'privacy':
      return [...base, { field: 'section:controller', ok: text('controller') }, { field: 'section:consent', ok: text('consent') }, { field: 'section:contact', ok: text('contact') }];
  }
}

const REQUIRED_PAGES: { key: PageKey; path: string }[] = [
  { key: 'home', path: '' },
  { key: 'fees', path: 'fees' },
  { key: 'about', path: 'about' },
  { key: 'faq', path: 'faq' },
  { key: 'privacy', path: 'privacy' },
];

/**
 * All the checks over a site's pages. Pass the member's settings values
 * (managementFeePct, brandColour, logoUrl) to check them as typed: the fees
 * page must show the fee, and a colour or logo that was typed must be valid.
 */
export function checkSite(
  pages: readonly PageModel[],
  opts: { managementFeePct?: number | null; brandColour?: string | null; logoUrl?: string | null } = {},
): CheckResult {
  const problems: CheckProblem[] = [];
  const add = (page: string, field: string, rule: CheckRule, message: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ page, field, rule, message });
  };

  if (!pages.length) {
    add('site', 'pages', 'required', 'The site has no pages.');
    return { ok: false, problems };
  }

  // Pages that must exist
  for (const req of REQUIRED_PAGES) {
    if (!pages.some((p) => p.key === req.key)) add('site', `page:${req.path || 'home'}`, 'required', `The ${req.path || 'home'} page is missing.`);
  }
  if (!pages.some((p) => p.key === 'area')) add('site', 'areas', 'required', 'Add at least one area.');

  // The site's own details (checked once, from the first page)
  checkIdentity(pages[0].site, add);
  if (clean(opts.brandColour) && parseHexColour(opts.brandColour) === null) add('site', 'brandColour', 'colour', 'The brand colour is not a valid #rrggbb colour.');
  if (clean(opts.logoUrl) && parseLogoUrl(opts.logoUrl) === null) add('site', 'logoUrl', 'logo', 'The logo needs to be an https PNG or JPEG.');
  scan('site', identityFields(pages[0].site), add);

  // Every page
  for (const p of pages) {
    const label = pageLabel(p);
    for (const r of requiredFields(p)) if (!r.ok) add(label, r.field, 'required', `This page needs ${r.field.replace('section:', '')}.`);
    if (p.key === 'area' && !p.area) add(label, 'area', 'required', 'This area page has no area.');
    if (PAGES_NEEDING_FORM.includes(p.key) && !p.form) add(label, 'form', 'form', 'This page has no lead form.');
    if (p.key === 'fees' && opts.managementFeePct !== undefined) {
      const want = feeLabel(opts.managementFeePct);
      if (!want) add(label, 'section:fee', 'required', 'Set your management fee.');
      else if (!p.sections.some((s) => s.id === 'fee' && s.paragraphs.some((t) => t.includes(want)))) add(label, 'section:fee', 'required', 'The fees page does not show your management fee.');
    }
    scan(label, pageFields(p), add);
  }

  // One dry run of step 1, on the home page's form (every page shares one descriptor)
  const form = pages.find((p) => p.form)?.form ?? null;
  const dry = stepOneDryRun(form);
  for (const d of dry.problems) add('site', d.field, 'step1', d.message);

  return { ok: problems.length === 0, problems };
}

function checkIdentity(id: SiteIdentity, add: (page: string, field: string, rule: CheckRule, message: string) => void) {
  if (!id.companyName) add('site', 'companyName', 'required', 'Add your company name.');
  if (!id.contactEmail) add('site', 'contactEmail', 'required', 'Add a contact email.');
  else if (!isEmail(id.contactEmail)) add('site', 'contactEmail', 'email', 'The contact email is not a valid email address.');
  if (!id.contactPhone) add('site', 'contactPhone', 'required', 'Add a contact phone number.');
  else if (!isUkPhone(id.contactPhone)) add('site', 'contactPhone', 'phone', 'The contact phone is not a valid UK phone number.');
}

function scan(page: string, fields: PageField[], add: (page: string, field: string, rule: CheckRule, message: string) => void) {
  for (const f of fields) {
    if (!f.text) continue;
    for (const h of placeholderHits(f.text)) add(page, f.field, 'placeholder', `Leftover ${h.what}: "${h.excerpt}"`);
    for (const h of bannedClaimHits(f.text)) add(page, f.field, 'banned_claim', `Not allowed (${h.what}): "${h.excerpt}"`);
  }
}

/**
 * Checks for one block of generated copy before it is kept (Phase 8): the
 * placeholder and banned-claim rules over any text.
 */
export function checkText(page: string, field: string, text: string): CheckProblem[] {
  const out: CheckProblem[] = [];
  const add = (p: string, f: string, rule: CheckRule, message: string) => out.push({ page: p, field: f, rule, message });
  scan(page, [{ field, text }], add);
  return out;
}
