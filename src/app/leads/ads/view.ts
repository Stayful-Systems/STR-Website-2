/**
 * Batch 36 (Phase 8): what the ad pack screen says, as pure view models. The
 * page and the client component only lay these out; every sentence an operator
 * reads, every length indicator and every grouping of files is decided (and
 * tested) here, so no internal code, snake_case word or database field can
 * reach the screen.
 *
 * Client-safe on purpose (the client component imports it): it uses only the
 * small pure modules (limits, links, eligibility) and type-only imports, never
 * generate-core.ts (which needs node:crypto) or checks.ts.
 *
 * Pure: no network, no database, no server-only.
 */
import { AD_LIMITS, checkLength, type LengthKind, type LengthLevel } from '../../../lib/ad-packs/limits.ts';
import { plainReason, type EligibilityReason } from '../../../lib/ad-packs/eligibility.ts';
import { ANGLE_LABELS } from '../../../lib/ad-packs/links.ts';
import type { Angle } from '../../../lib/ad-packs/codes.ts';
import type { CheckId } from '../../../lib/ad-packs/checks.ts';
import type { AdFiles, AdTexts, PackStatus } from '../../../lib/ad-packs/store-types.ts';

export const ADS_PATH = '/leads/ads';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ── Not eligible ──

export type NextStep = { text: string; href?: string; label?: string };

const WEBSITE_SETUP = '/leads/setup/website';

const NEXT_STEP: Record<EligibilityReason, NextStep> = {
  not_owner: { text: 'Ask the account owner to open this page.' },
  no_academy: { text: 'If you have joined the Academy, check it is linked to this account. If it still does not show, get in touch and we will sort it out.' },
  academy_refunded: { text: 'If that is not right, get in touch and we will look into it.' },
  no_site: { text: 'Set up your website first.', href: WEBSITE_SETUP, label: 'Set up your website' },
  site_not_live: { text: 'Finish your website and put it live.', href: WEBSITE_SETUP, label: 'Continue with your website' },
  no_domain: { text: 'Choose your .co.uk address on your website page.', href: WEBSITE_SETUP, label: 'Choose your address' },
  domain_not_live: { text: 'There is nothing to do. We email you when your address is live. Come back here then.' },
  switch_off: { text: 'There is nothing to do yet. We will tell you as soon as it is open.' },
};

export type EligibilityView = { title: string; sentences: string[]; next: NextStep[] };

/** Why the pack is not available, in plain sentences, and what to do next. No codes: only the sentences. */
export function eligibilityView(reasons: readonly EligibilityReason[]): EligibilityView {
  const list = [...new Set(reasons)];
  const title = list.length === 1 && list[0] === 'not_owner' ? 'Only the account owner can set up the ad pack' : 'Your ad pack is not ready yet';
  const next: NextStep[] = [];
  for (const r of list) {
    const step = NEXT_STEP[r];
    if (step && !next.some((n) => n.text === step.text)) next.push(step);
  }
  return { title, sentences: list.map(plainReason), next };
}

// ── The brand an ad pack uses (read from the operator's website, never from the browser) ──

export type BrandProblem = 'company' | 'colour';

export type SiteBrandInput = {
  companyName: string;
  logoUrl: string | null;
  brandColour: string | null;
  managementFeePct: number | null;
  areas: readonly string[];
  photoUrl: string | null;
};

export type PackBrand = { company: string; logoUrl: string | null; brandColour: string | null; feePct: number | null; areas: string[]; photoUrl: string | null };

/**
 * The brand a pack is made from, taken from the website's settings. A logo that
 * is not a secure (https) address counts as no logo. `problems` are the things
 * the operator cannot fix on this screen (the company name and the colour).
 */
export function brandOfSettings(s: SiteBrandInput): { brand: PackBrand; problems: BrandProblem[] } {
  const company = String(s.companyName ?? '').trim();
  const logo = String(s.logoUrl ?? '').trim();
  const colour = String(s.brandColour ?? '').trim();
  const fee = typeof s.managementFeePct === 'number' && Number.isFinite(s.managementFeePct) ? s.managementFeePct : null;
  const brand: PackBrand = {
    company,
    logoUrl: /^https:\/\//i.test(logo) ? logo : null,
    brandColour: /^#[0-9a-f]{6}$/i.test(colour) ? colour.toLowerCase() : null,
    feePct: fee,
    areas: (s.areas ?? []).map((a) => String(a ?? '').trim()).filter((a) => a !== ''),
    photoUrl: String(s.photoUrl ?? '').trim() || null,
  };
  const problems: BrandProblem[] = [];
  if (brand.company === '') problems.push('company');
  if (brand.brandColour === null) problems.push('colour');
  return { brand, problems };
}

const PROBLEM_TEXT: Record<BrandProblem, string> = {
  company: 'Your website has no company name yet, so we cannot put it on your ads. Get in touch and we will add it.',
  colour: 'Your website has no brand colour yet, so we cannot colour your ads. Get in touch and we will add it.',
};

export function brandProblemText(p: BrandProblem): string {
  return PROBLEM_TEXT[p];
}

export const NO_LOGO_TEXT = 'You have no logo on your website. Your ads can show your company name in type instead.';
export const LOGO_REFUSAL = 'Please tick the box to use your company name in type, or add a logo to your website first.';

// ── The area step ──

export type AreaPreviewInput =
  | { error: 'not_enough_data'; message?: string }
  | { areaKey: string; areaLabel: string; fellBack: boolean; bedrooms: number; samples: number };

export type AreaPreviewView = { ok: boolean; bedrooms: number | null; text: string };

/** What the operator is told under the area pick list: the bedroom size we will use, and that they cannot change it. */
export function areaPreviewView(r: AreaPreviewInput): AreaPreviewView {
  if ('error' in r) return { ok: false, bedrooms: null, text: 'There is not enough data in that area yet. Try the wider area around it, or another area.' };
  const base = `We will use a typical ${r.bedrooms}-bed. It is the most common size in ${r.areaLabel}, from ${plural(r.samples, 'report', 'reports')}. You do not need to choose this: we pick it for you.`;
  return { ok: true, bedrooms: r.bedrooms, text: r.fellBack ? `There were too few reports for the exact area you picked, so your ads use the wider area, ${r.areaLabel}. ${base}` : base };
}

// ── Text lengths ──

export type LengthView = {
  length: number;
  level: LengthLevel;
  /** "Good length", "A bit long", "Too long": words as well as a colour. */
  word: string;
  /** Tailwind classes for the small badge. */
  badge: string;
  /** "27 characters". */
  counter: string;
  /** Meta's recommendation and this pack's limit, always shown. */
  limits: string;
  /** Anything else worth saying about this text. */
  notes: string[];
};

const LEVEL_WORD: Record<LengthLevel, string> = { green: 'Good length', amber: 'A bit long', red: 'Too long' };
const LEVEL_BADGE: Record<LengthLevel, string> = {
  green: 'bg-success/15 text-success',
  amber: 'bg-warning/15 text-warning',
  red: 'bg-destructive/15 text-destructive',
};

function limitsText(kind: LengthKind): string {
  if (kind === 'headline') return `Meta recommends ${AD_LIMITS.headline.recommended} characters or fewer. This pack allows up to ${AD_LIMITS.headline.hard}.`;
  if (kind === 'primary') return `Meta shows about the first ${AD_LIMITS.primary.visible} characters, then "See more". This pack allows up to ${AD_LIMITS.primary.hard}.`;
  return `This pack allows up to ${AD_LIMITS.description.hard}. Meta may cut it off on some placements past ${AD_LIMITS.description.metaVisible} characters.`;
}

/** The live length indicator for one text: green, amber or red, with both limits. */
export function lengthView(kind: LengthKind, text: string): LengthView {
  const c = checkLength(kind, text);
  return {
    length: c.length,
    level: c.level,
    word: LEVEL_WORD[c.level],
    badge: LEVEL_BADGE[c.level],
    counter: `${c.length} ${c.length === 1 ? 'character' : 'characters'}`,
    limits: limitsText(kind),
    // The description's "cut off past 30" note is part of `limits` already.
    notes: c.notes.filter((n) => !/cut off on some placements/i.test(n)),
  };
}

// ── What can be copied ──

export const COPY_KINDS = ['name', 'link', 'primary', 'headline', 'description'] as const;
export type CopyKind = (typeof COPY_KINDS)[number];
export const isCopyKind = (v: unknown): v is CopyKind => typeof v === 'string' && (COPY_KINDS as readonly string[]).includes(v);

export type CopyItem = {
  /** Stable key for the list. */
  key: string;
  kind: CopyKind;
  /** Position within its list (0 for the name and the link). */
  index: number;
  label: string;
  /** Copied exactly as stored: no trimming, no changes. */
  text: string;
  length: LengthView | null;
};

export type AdCopy = { name: CopyItem; link: CopyItem; primary: CopyItem[]; headlines: CopyItem[]; descriptions: CopyItem[] };

/** Everything an operator copies from one ad, each with its own label and (for the three texts) its length indicator. */
export function adCopyItems(ad: { adName: string; link: string; texts: Pick<AdTexts, 'primary' | 'headlines' | 'descriptions'> }): AdCopy {
  const list = (kind: 'primary' | 'headline' | 'description', texts: readonly string[], noun: string): CopyItem[] =>
    texts.map((text, index) => ({ key: `${kind}-${index}`, kind, index, label: texts.length > 1 ? `${noun} ${index + 1}` : noun, text, length: lengthView(kind, text) }));
  return {
    name: { key: 'name', kind: 'name', index: 0, label: 'Ad name', text: ad.adName, length: null },
    link: { key: 'link', kind: 'link', index: 0, label: 'Link', text: ad.link, length: null },
    primary: list('primary', ad.texts.primary ?? [], 'Primary text'),
    headlines: list('headline', ad.texts.headlines ?? [], 'Headline'),
    descriptions: list('description', ad.texts.descriptions ?? [], 'Description'),
  };
}

/** True when `index` names a text this ad really has for that kind (the copy log refuses anything else). */
export function copyTargetExists(ad: { texts: Pick<AdTexts, 'primary' | 'headlines' | 'descriptions'> }, kind: CopyKind, index: number): boolean {
  if (!Number.isInteger(index) || index < 0) return false;
  if (kind === 'name' || kind === 'link') return index === 0;
  const list = kind === 'primary' ? ad.texts.primary : kind === 'headline' ? ad.texts.headlines : ad.texts.descriptions;
  return index < (list ?? []).length;
}

// ── Image files ──

export type FileLabel = { name: string; size: string; width: number; height: number };
export type CardFiles = { card: number; files: FileLabel[]; previewName: string };

const SIZE_WORDS: Record<string, string> = { '1x1': 'Square 1:1', '4x5': 'Portrait 4:5', '9x16': 'Stories 9:16' };
const FILE_NAME = /^[a-z0-9]+-card(\d+)-(1x1|4x5|9x16)\.png$/i;

/** An ad's image files grouped by card, each with a plain size label; the preview is the portrait 4:5 file when there is one. */
export function groupCardFiles(files: readonly { name: string; width: number; height: number }[]): CardFiles[] {
  const byCard = new Map<number, FileLabel[]>();
  for (const f of files) {
    const m = FILE_NAME.exec(f.name);
    if (!m) continue;
    const card = Number(m[1]);
    const list = byCard.get(card) ?? [];
    list.push({ name: f.name, size: SIZE_WORDS[m[2].toLowerCase()] ?? m[2], width: f.width, height: f.height });
    byCard.set(card, list);
  }
  return [...byCard.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([card, list]) => ({ card, files: list, previewName: (list.find((f) => /-4x5\.png$/i.test(f.name)) ?? list[0]).name }));
}

/** The 5b ad's video slot: "Video coming soon" in 36a, nothing for an image ad. */
export function videoSlotText(video: AdFiles['video']): string | null {
  if (!video) return null;
  return video.status === 'coming' ? 'Video coming soon' : null;
}

export const angleTitle = (angle: Angle): string => ANGLE_LABELS[angle] ?? 'Ad';

// ── A pack that did not pass its checks ──

const CHECK_PLAIN: Record<CheckId, string> = {
  brand: 'Your company name, logo or colour could not be placed on every ad.',
  source_brand: 'Something in the ads did not belong to your business.',
  figures: 'The example figure could not be shown with its label.',
  length: 'One of the texts was too long for Meta.',
  claims: 'A line sounded like a promise about what you will earn.',
  links: 'A link could not be tagged to its ad.',
  files: 'An image was not the right size.',
};
export const CHECK_PLAIN_IDS = Object.keys(CHECK_PLAIN) as CheckId[];

export type ChecksFailedView = { title: string; lines: string[]; contact: string };

/** "We couldn't build your pack yet": the failed checks in plain English (one line each), never a code. */
export function checksFailedView(checks: { failures: readonly { check: string }[] } | null | undefined): ChecksFailedView {
  const seen: string[] = [];
  for (const f of checks?.failures ?? []) if (!seen.includes(f.check)) seen.push(f.check);
  const lines = seen.map((id) => (CHECK_PLAIN as Record<string, string>)[id]).filter((l): l is string => typeof l === 'string');
  return {
    title: "We couldn't build your pack yet",
    lines: lines.length > 0 ? lines : ['Something in the pack did not pass our checks.'],
    contact: 'Please contact support and we will sort it out. There is nothing you need to fix, and nothing has gone live.',
  };
}

// ── The entry card on /leads ──

export type EntryCardView = { title: string; body: string; cta: string };

/** The "Your ad pack" card: what it says for a pack in each state (null: no pack yet). */
export function entryCardView(status: PackStatus | null): EntryCardView {
  switch (status) {
    case null:
    case 'draft':
      return { title: 'Your ad pack', body: 'Three Facebook ads for landlords, in your own brand, ready to upload to your own Meta account.', cta: 'Make my ads' };
    case 'generating':
      return { title: 'Your ads are being made', body: 'This takes a few minutes. Open it to check.', cta: 'Open my ads' };
    case 'preview':
      return { title: 'Your ads are ready to look at', body: 'Have a look, then approve them to get the images and texts.', cta: 'Look at my ads' };
    case 'approved':
      return { title: 'Your ads are ready to use', body: 'Download the images and copy the texts for Facebook.', cta: 'Open my ads' };
    case 'checks_failed':
    case 'failed':
      return { title: 'Your ad pack needs a look', body: 'We could not finish it. Open it to see what to do next.', cta: 'Open my ads' };
  }
}

// ── The example figure ──

/** The labelled example figure a pack rests on (ad_packs.figures[0]), or null. Only the two sentences are ever read from it. */
export function figureCallout(figures: readonly unknown[] | null | undefined): { label: string; sentence: string } | null {
  const f = Array.isArray(figures) ? figures[0] : null;
  if (!f || typeof f !== 'object') return null;
  const o = f as Record<string, unknown>;
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  const sentence = typeof o.sentence === 'string' ? o.sentence.trim() : '';
  return label !== '' ? { label, sentence } : null;
}

// ── One ad, ready to lay out ──

export type AdCardVm = { card: number; previewUrl: string | null; files: FileLabel[] };

export type AdVm = {
  id: string;
  angle: Angle;
  title: string;
  code: string;
  adName: string;
  copy: AdCopy;
  cards: AdCardVm[];
  /** "Video coming soon" for the 5b ad, null for an image ad. */
  videoText: string | null;
};

/** Everything the screen shows for one pack ad. `urlOf` turns a stored path into a view link (or null). */
export function adViewModel(
  ad: { id: string; angle: Angle; code: string; adName: string; link: string; texts: Pick<AdTexts, 'primary' | 'headlines' | 'descriptions'>; files: AdFiles },
  urlOf: (path: string) => string | null,
): AdVm {
  const pathOf = (name: string) => ad.files.images.find((f) => f.name === name)?.path ?? null;
  return {
    id: ad.id,
    angle: ad.angle,
    title: angleTitle(ad.angle),
    code: ad.code,
    adName: ad.adName,
    copy: adCopyItems(ad),
    cards: groupCardFiles(ad.files.images).map((c) => {
      const path = pathOf(c.previewName);
      return { card: c.card, previewUrl: path ? urlOf(path) : null, files: c.files };
    }),
    videoText: videoSlotText(ad.files.video),
  };
}
