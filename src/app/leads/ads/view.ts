/**
 * Batch 38 (Phase 8): what the ad pack screen says, as pure view models. The
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
import type { PackView, VideoView } from '../../../lib/ad-packs/generate-core.ts';
import { VOICES, voiceByKey, type VoiceKey } from '../../../lib/ad-packs/voices.ts';

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
  video: 'The video was not made properly.',
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
  /** The notice ad's video (38b), null for an image ad. */
  video: VideoVm | null;
};

/**
 * Everything the screen shows for one pack ad. `urlOf` turns a stored path into a view link (or null). `live` is the
 * 5b video's live state from the pack read (it follows the render row); without it the ad's own video slot decides.
 */
export function adViewModel(
  ad: { id: string; angle: Angle; code: string; adName: string; link: string; texts: Pick<AdTexts, 'primary' | 'headlines' | 'descriptions'>; files: AdFiles },
  urlOf: (path: string) => string | null,
  live?: Pick<VideoView, 'status' | 'code' | 'poll' | 'canRetry' | 'message'> | null,
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
    video: ad.angle === '5b' ? videoVm(ad.files.video, live ?? videoViewOfSlot(ad.files.video), urlOf) : null,
  };
}

// ── The voice step (38b) ──

export const VOICE_STEP_TITLE = 'Pick the voice for your video';
export const VOICE_STEP_HELP = 'Pick the voice for your video. Press play to hear it first.';
export const VOICE_CHANGE_TITLE = 'Change the voice';
export const VOICE_REMAKE_NOTE = 'Your video is made again with the new voice. That takes 3 to 6 minutes.';

export type VoiceCardVm = { key: VoiceKey; label: string; description: string; previewUrl: string };

/** The three voices, each with the free sample clip the operator plays before choosing. */
export function voiceCards(): VoiceCardVm[] {
  return VOICES.map((v) => ({ key: v.key, label: v.label, description: v.description, previewUrl: v.previewUrl }));
}

// ── Plain words for the video actions (38b) ──

const TRY_AGAIN = 'Something went wrong. Please try again.';

/** Every refusal changeVoice and retryVideo can give, as one plain sentence (the generator's own wording where it has some). */
export const VIDEO_ACTION_TEXT: Record<string, string> = {
  invalid_input: TRY_AGAIN,
  no_pack: 'We could not find your pack. Please reload the page and try again.',
  not_preview: 'Only a pack that is ready to look at can be changed. Please reload the page and look at it again.',
  after_approval: 'You can change the voice before you approve your ads.',
  same_voice: 'That is the voice your video already has. Choose a different one.',
  voice_limit_used: 'You have already used your voice change.',
  video_running: 'Your video is being made right now. Wait until it is finished, then change the voice.',
  not_retryable: 'There is nothing to try again right now.',
  store_failed: TRY_AGAIN,
  cost_cap: 'This pack would cost more than the limit for one pack, so it was not made.',
  monthly_cap: 'The limit for making packs this month has been reached. Try again next month.',
  spend_unknown: 'We could not check this month’s limit just now. Try again shortly.',
};

/**
 * One sentence for a refusal. The generator's message is used when it reads as a sentence; anything that looks like an
 * internal code, a stack line or is not text at all falls back to the sentence for the code, then to "try again".
 */
export function videoActionMessage(code: unknown, message: unknown): string {
  const m = typeof message === 'string' ? message.trim() : '';
  const sentence = m.length >= 8 && m.length <= 300 && /\s/.test(m) && !/[a-z]+_[a-z]+|\bat \S+:\d+|Error:|undefined|\[object/.test(m);
  if (sentence) return m;
  return (typeof code === 'string' ? VIDEO_ACTION_TEXT[code] : undefined) ?? TRY_AGAIN;
}

// ── The video's state, as the screen says it (38b) ──

export const VIDEO_MAKING_TEXT = 'Making your video… this usually takes 3 to 6 minutes. You can leave this page and come back.';
export const VIDEO_SLOW_TEXT = 'This is taking longer than usual. You can leave this page and come back later: your video keeps being made.';
export const VOICE_UNAVAILABLE_TEXT = "That voice isn't available yet. Please choose another.";
export const VIDEO_CONTACT_TEXT = 'We could not make your video. Please contact support and we will sort it out. Nothing has gone live.';
export const VIDEO_MISSING_TEXT = 'There is no video with this pack yet. Please contact support and we will add it.';

/** What the operator can do about the video: nothing, try again, choose another voice, or ask us. */
export type VideoAction = 'none' | 'retry' | 'change_voice' | 'contact';

export type VideoCardView = {
  state: VideoView['status'];
  heading: string;
  /** One plain sentence, or null when the video is ready. Never a code. */
  message: string | null;
  /** Ask again every few seconds while true. */
  poll: boolean;
  action: VideoAction;
};

type VideoLike = Pick<VideoView, 'status' | 'code' | 'poll' | 'canRetry' | 'message'>;

export function videoCardView(v: VideoLike): VideoCardView {
  switch (v.status) {
    case 'queued':
    case 'making':
      return { state: v.status, heading: 'Making your video', message: VIDEO_MAKING_TEXT, poll: true, action: 'none' };
    case 'ready':
      return { state: 'ready', heading: 'Your video', message: null, poll: false, action: 'none' };
    case 'failed':
      if (v.code === 'voice_unavailable') return { state: 'failed', heading: 'Your video needs another voice', message: VOICE_UNAVAILABLE_TEXT, poll: false, action: 'change_voice' };
      if (v.canRetry) return { state: 'failed', heading: 'We could not make your video', message: videoActionMessage(null, v.message), poll: false, action: 'retry' };
      return { state: 'failed', heading: 'We could not make your video', message: VIDEO_CONTACT_TEXT, poll: false, action: 'contact' };
    default:
      return { state: 'coming', heading: 'Your video', message: VIDEO_MISSING_TEXT, poll: false, action: 'contact' };
  }
}

/** The video's state from the ad's own slot, for when the pack read has no render row to follow. */
export function videoViewOfSlot(video: AdFiles['video']): VideoLike {
  if (!video || video.status === 'coming') return { status: 'coming', code: null, poll: false, canRetry: false, message: null };
  if (video.status === 'failed') return { status: 'failed', code: video.code, poll: false, canRetry: false, message: null };
  return { status: video.status, code: null, poll: video.status === 'queued' || video.status === 'making', canRetry: false, message: null };
}

// ── The video files ──

export type VideoFileVm = { name: string; label: string; ratio: '9:16' | '4:5' | '1:1'; width: number; height: number };

/** The three sizes, in the order they are offered, named the way Meta names the placements. */
export const VIDEO_FILE_LABELS: Record<string, { label: string; ratio: VideoFileVm['ratio']; order: number }> = {
  'notice-9x16.mp4': { label: 'Stories and Reels (9:16)', ratio: '9:16', order: 0 },
  'notice-4x5.mp4': { label: 'Feed (4:5)', ratio: '4:5', order: 1 },
  'notice-1x1.mp4': { label: 'Square (1:1)', ratio: '1:1', order: 2 },
};
export const VIDEO_POSTER_NAME = 'notice-poster.png';
export const isVideoFileName = (name: unknown): name is string => typeof name === 'string' && Object.prototype.hasOwnProperty.call(VIDEO_FILE_LABELS, name);

/** The video files a ready video has, in order, with their plain labels; empty unless the video is ready. */
export function videoFilesOf(video: AdFiles['video']): { files: VideoFileVm[]; poster: string | null; seconds: number | null } {
  if (!video || video.status !== 'ready') return { files: [], poster: null, seconds: null };
  const files = video.videos
    .filter((f) => isVideoFileName(f.name))
    .sort((a, b) => VIDEO_FILE_LABELS[a.name].order - VIDEO_FILE_LABELS[b.name].order)
    .map((f): VideoFileVm => ({ name: f.name, label: VIDEO_FILE_LABELS[f.name].label, ratio: VIDEO_FILE_LABELS[f.name].ratio, width: f.width, height: f.height }));
  return { files, poster: video.poster?.name === VIDEO_POSTER_NAME ? video.poster.name : null, seconds: video.durationSeconds > 0 ? Math.round(video.durationSeconds) : null };
}

export type VideoVm = {
  card: VideoCardView;
  files: VideoFileVm[];
  poster: string | null;
  /** View links by file name (the three videos and the poster), made for this owner's own files. */
  urls: Record<string, string>;
  seconds: number | null;
};

/** The 5b ad's video: its live state, and (when ready) its files with view links. */
export function videoVm(video: AdFiles['video'], live: VideoLike, urlOf: (path: string) => string | null): VideoVm {
  const card = videoCardView(live);
  const { files, poster, seconds } = card.state === 'ready' ? videoFilesOf(video) : { files: [], poster: null, seconds: null };
  const urls: Record<string, string> = {};
  if (video && video.status === 'ready' && card.state === 'ready') {
    for (const f of [...video.videos, video.poster]) {
      const url = f ? urlOf(f.path) : null;
      if (url) urls[f.name] = url;
    }
  }
  return { card, files, poster, urls, seconds };
}

// ── Approve: why it may not be pressed yet ──

export type ApprovalVm = { ok: true } | { ok: false; message: string };

const VIDEO_PENDING_TEXT = 'Your video is still being made. It usually takes a few minutes.';

/** Approve is off, with the plain reason, until the video is ready and every check has passed. */
export function approvalVm(view: Pick<PackView, 'approval' | 'video'>): ApprovalVm {
  if (view.approval.ok) return { ok: true };
  const s = view.video.status;
  if (s === 'queued' || s === 'making') return { ok: false, message: VIDEO_PENDING_TEXT };
  if (s === 'failed' || s === 'coming') return { ok: false, message: videoCardView(view.video).message ?? VIDEO_CONTACT_TEXT };
  return { ok: false, message: videoActionMessage(view.approval.code, view.approval.message) };
}

// ── Change voice ──

export type VoiceVm = {
  current: VoiceKey | null;
  currentLabel: string | null;
  canChange: boolean;
  changesLeft: number;
  /** The change would not use the allowance (the first voice could not be used). */
  free: boolean;
  /** How many changes are left, in a sentence. */
  note: string;
  /** Why a change is not possible right now, or null. */
  blocked: string | null;
};

export function voiceVm(v: PackView['voice']): VoiceVm {
  const note = v.free
    ? 'The first voice could not be used, so this change is free.'
    : v.changesLeft > 0
      ? `You can change the voice ${v.changesLeft === 1 ? 'once' : `${v.changesLeft} times`} before you approve.`
      : 'You have used your voice change.';
  return {
    current: v.key,
    currentLabel: voiceByKey(v.key)?.label ?? null,
    canChange: v.canChange,
    changesLeft: v.changesLeft,
    free: v.free,
    note,
    blocked: v.blocked ? videoActionMessage(v.blocked.code, v.blocked.message) : null,
  };
}

// ── Polling while the video is made ──

export const POLL_INTERVAL_MS = 8000;
export const POLL_GIVE_UP_MS = 15 * 60 * 1000;

export type PollStep = 'wait' | 'settled' | 'give_up';

/**
 * What the screen does after an answer from the server: keep waiting, reload the page because the video has
 * settled (ready, failed, or the pack moved on), or stop and say it is taking longer than usual.
 */
export function pollStep(i: { startedMs: number; nowMs: number; poll: boolean; versionChanged?: boolean }): PollStep {
  if (!i.poll || i.versionChanged) return 'settled';
  return i.nowMs - i.startedMs >= POLL_GIVE_UP_MS ? 'give_up' : 'wait';
}

/** The lightweight answer to a poll: what the video, the approve button and the voice step need, nothing else. */
export type PollView = { version: number; video: VideoCardView; approval: ApprovalVm; voice: VoiceVm };

export function pollViewOf(view: PackView): PollView {
  return { version: view.pack.version, video: videoCardView(view.video), approval: approvalVm(view), voice: voiceVm(view.voice) };
}
