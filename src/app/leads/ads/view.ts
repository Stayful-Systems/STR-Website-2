/**
 * Batch 38 (Phase 8, redesigned in 38c): what the Facebook ads screens say, as
 * pure view models. The page and the client components only lay these out;
 * every sentence an operator reads and every grouping of files is decided (and
 * tested) here, so no internal word, code, snake_case name or database field
 * can reach the screen. The words are written for a busy landlord on a phone:
 * short sentences, everyday words.
 *
 * Client-safe on purpose (the client components import it): it uses only the
 * small pure modules (eligibility, links, voices) and type-only imports, never
 * generate-core.ts (which needs node:crypto) or checks.ts.
 *
 * Pure: no network, no database, no server-only.
 */
import type { PackEligibilityReason } from '../../../lib/ad-packs/eligibility.ts';
import type { Angle } from '../../../lib/ad-packs/codes.ts';
import type { CheckId } from '../../../lib/ad-packs/checks.ts';
import type { AdFiles, AdTexts, PackStatus } from '../../../lib/ad-packs/store-types.ts';
import type { PackView, VideoView } from '../../../lib/ad-packs/generate-core.ts';
import { VOICES, voiceByKey, type VoiceKey } from '../../../lib/ad-packs/voices.ts';
// Batch 55 step 5: the lead database ads' concept lines (pure, client-safe) and the gate's ids (type only).
import { LD_ANGLE_DEFS } from '../../../lib/ad-packs/ld-angles.ts';
import type { LdCheckId } from '../../../lib/ad-packs/ld-gate.ts';

export const ADS_PATH = '/leads/ads';
export const GUIDE_PATH = '/leads/ads/guide';

/** The name of the screen, and the one line under it. */
export const PAGE_TITLE = 'Your Facebook ads';
export const START_INTRO = 'We’ll make 3 ready-to-use ads in your company’s colours: two pictures and a short video.';

// ── Plain sentences for every refusal the server can give ──

const TRY_AGAIN = 'Something went wrong. Please try again.';
const GET_IN_TOUCH = 'Please get in touch and we will sort it out.';

/**
 * One plain sentence for every code the generator, the approve step and the video actions can refuse with. The
 * generator's own messages use words the operator never sees (and some say "pack"), so the screen only ever
 * says these.
 */
export const PLAIN_CODES: Record<string, string> = {
  invalid_input: TRY_AGAIN,
  no_pack: 'We could not find your ads. Please reload the page and try again.',
  not_preview: 'Your ads have moved on since you opened this page. Please reload the page and try again.',
  after_approval: 'You can only change the voice before you move on to the Facebook steps.',
  same_voice: 'Your video already has that voice. Please pick a different one.',
  voice_limit_used: 'You have already used your voice change.',
  video_running: 'Your video is being made right now. Please wait until it is ready, then change the voice.',
  not_retryable: 'There is nothing to try again right now.',
  store_failed: TRY_AGAIN,
  in_progress: 'Your ads are being made. Please give it a few minutes.',
  no_brand_change: 'Nothing has changed since your last ads. Change your logo, colours, company name, fee, area or photos first, then try again.',
  regen_used: 'You have already used your free chance to make new ads.',
  not_enough_data: 'We do not have enough information for that area yet. Please try a bigger area nearby.',
  render_failed: TRY_AGAIN,
  upload_failed: TRY_AGAIN,
  generate_failed: TRY_AGAIN,
  cost_cap: `We could not make this just now. ${GET_IN_TOUCH}`,
  monthly_cap: 'We cannot make any more ads right now. Please try again later, or get in touch.',
  round_limit: 'You have already made your ads for this round. You can make new ones when the next round starts, or get in touch and we will see what we can do.',
  backstop: 'We cannot make any more ads right now. Please try again later, or get in touch.',
  spend_unknown: 'We could not finish that just now. Please try again in a few minutes.',
  video_pending: 'Your video is still being made. This button works as soon as it is ready.',
  video_failed: 'Your video is not ready yet. Please look at the video above first.',
};

/** Words that must never reach an operator's screen (pinned by plain-language.test.ts). */
const INTERNAL_WORDS = /\b(?:packs?|versions?|regenerat\w*|checks?|render\w*|codes?|allowance|hash|type-only|ad_\w+)\b|[a-z]+_[a-z]+|\bat \S+:\d+|Error:|undefined|\[object/i;

/**
 * One sentence for a refusal. The sentence for the code wins; a message from the server is used only for a code we do
 * not know, and only when it reads as a plain sentence. Anything else falls back to "try again".
 */
export function plainRefusal(code: unknown, message: unknown): string {
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(PLAIN_CODES, code)) return PLAIN_CODES[code];
  const m = typeof message === 'string' ? message.trim() : '';
  const sentence = m.length >= 8 && m.length <= 300 && /\s/.test(m) && !INTERNAL_WORDS.test(m);
  return sentence ? m : TRY_AGAIN;
}

// ── Cannot use yet ──

export type NextStep = { text: string; href?: string; label?: string };

const WEBSITE_SETUP = '/leads/setup/website';

const ELIGIBILITY_PLAIN: Record<PackEligibilityReason, string> = {
  not_owner: 'Only the person who owns the account can make the ads. Please ask them to open this page.',
  no_academy: 'These ads come with the Academy. Once your Academy purchase is linked to this account, they will show up here.',
  academy_refunded: 'These ads come with the Academy, and your Academy purchase was refunded.',
  no_site: 'You need a website first, because your ads send people to it.',
  site_not_live: 'Your website is not live yet. Put it live, then come back for your ads.',
  no_domain: 'Your website needs its own .co.uk address first, because your ads send people there.',
  domain_not_live: 'Your website address is not live yet. This can take a little while. We will email you when it is ready.',
  switch_off: 'Your Facebook ads are not open yet. We will tell you as soon as they are.',
  has_website: 'You already have your own website, so these ads are not set up for this account.',
  no_leaddb_account: 'Your lead database account is not linked to this account yet, so there are no ads to make.',
  account_stopped: 'Your lead database account is not active at the moment, so your ads are on hold.',
  no_card: 'Your lead database account needs a payment card before you can make ads.',
  not_allowed: 'Your Facebook ads are not open for your account yet. We will tell you as soon as they are.',
};

const NEXT_STEP: Record<PackEligibilityReason, NextStep> = {
  not_owner: { text: 'Ask the account owner to open this page.' },
  no_academy: { text: 'If you have joined the Academy, check it is linked to this account. If it still does not show, get in touch and we will sort it out.' },
  academy_refunded: { text: 'If that is not right, get in touch and we will look into it.' },
  no_site: { text: 'Set up your website first.', href: WEBSITE_SETUP, label: 'Set up my website' },
  site_not_live: { text: 'Finish your website and put it live.', href: WEBSITE_SETUP, label: 'Go to my website' },
  no_domain: { text: 'Choose your .co.uk address on your website page.', href: WEBSITE_SETUP, label: 'Choose my address' },
  domain_not_live: { text: 'There is nothing to do. Come back when you get our email.' },
  switch_off: { text: 'There is nothing to do yet.' },
  has_website: { text: 'If that does not sound right, get in touch and we will look into it.' },
  no_leaddb_account: { text: 'If you have a lead database account, get in touch and we will link it to this one.' },
  account_stopped: { text: 'There is nothing to do here. Your ads come back when your lead database account is active again.' },
  no_card: { text: 'Add a payment card to your lead database account, then come back to this page.' },
  not_allowed: { text: 'There is nothing to do yet.' },
};

/** The plain sentence for one reason (no code, no jargon). */
export const eligibilitySentence = (r: PackEligibilityReason): string => ELIGIBILITY_PLAIN[r] ?? 'Your Facebook ads are not available for this account yet.';

export type EligibilityView = { title: string; message: string; next: NextStep | null };

/**
 * Why the ads are not available yet, in ONE plain message (the most basic reason), and the one thing to do next.
 * No codes: only sentences.
 */
export function eligibilityView(reasons: readonly PackEligibilityReason[]): EligibilityView {
  const first = reasons[0];
  if (!first) return { title: 'Your Facebook ads are not ready yet', message: 'Your Facebook ads are not available for this account yet.', next: null };
  return {
    title: first === 'not_owner' ? 'Only the account owner can do this' : 'Your Facebook ads are not ready yet',
    message: eligibilitySentence(first),
    next: NEXT_STEP[first] ?? null,
  };
}

// ── The brand the ads use (read from the operator's website, never from the browser) ──

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
 * The brand the ads are made from, taken from the website's settings. A logo that is not a secure (https) address
 * counts as no logo. `problems` are the things the operator cannot fix on this screen (the company name and the colour).
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
  company: `Your website has no company name yet, so we cannot put it on your ads. ${GET_IN_TOUCH}`,
  colour: `Your website has no brand colour yet, so we cannot colour your ads. ${GET_IN_TOUCH}`,
};

export function brandProblemText(p: BrandProblem): string {
  return PROBLEM_TEXT[p];
}

export const NO_LOGO_TEXT = 'Your website has no logo, so we’ll show your company name instead.';
export const LOGO_REFUSAL = 'Please tick the box to show your company name instead of a logo, or add a logo to your website first.';

// ── The start form ──

export const AREA_LABEL = 'Where do you want to find landlords?';
export const AREA_HINT = 'Pick the town or area you want your enquiries to come from.';
export const AREA_PLACEHOLDER = 'Choose a place';
export const VOICE_STEP_TITLE = 'Pick a voice for your video';
export const VOICE_STEP_HELP = 'Tap the play button to hear each voice.';
export const PHOTOS_TITLE = 'Add your own photos (optional)';
export const PHOTOS_HELP = 'We put them behind the words on your ads. Use JPG or PNG, up to 4. Without photos, your ads use your colour and logo.';
export const START_BUTTON = 'Make my ads';
export const START_BUTTON_AGAIN = 'Try again';
export const MAKING_ADS_TEXT = 'Making your ads… this takes about a minute. Please keep this page open.';

export type AreaPreviewInput =
  | { error: 'not_enough_data'; message?: string }
  | { areaKey: string; areaLabel: string; fellBack: boolean; bedrooms: number; samples: number };

export type AreaPreviewView = { ok: boolean; bedrooms: number | null; text: string };

/** What the operator is told under the area list: the home size we will show (we pick it, they do not need to). */
export function areaPreviewView(r: AreaPreviewInput): AreaPreviewView {
  if ('error' in r) return { ok: false, bedrooms: null, text: PLAIN_CODES.not_enough_data };
  const base = `Your ads will show a typical ${r.bedrooms}-bedroom home, the most common size in ${r.areaLabel}. We pick this for you.`;
  return { ok: true, bedrooms: r.bedrooms, text: r.fellBack ? `We did not have enough information for the exact place you picked, so your ads use the wider area, ${r.areaLabel}. ${base}` : base };
}

// ── What can be copied (the guide) ──

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
};

export type AdCopy = { name: CopyItem; link: CopyItem; primary: CopyItem[]; headlines: CopyItem[]; descriptions: CopyItem[] };

/** Everything an operator copies from one ad, each with the name we use for it on screen. */
export function adCopyItems(ad: { adName: string; link: string; texts: Pick<AdTexts, 'primary' | 'headlines' | 'descriptions'> }): AdCopy {
  const list = (kind: 'primary' | 'headline' | 'description', texts: readonly string[], label: string): CopyItem[] =>
    texts.map((text, index) => ({ key: `${kind}-${index}`, kind, index, label, text }));
  return {
    name: { key: 'name', kind: 'name', index: 0, label: 'Ad name', text: ad.adName },
    link: { key: 'link', kind: 'link', index: 0, label: 'Website link', text: ad.link },
    primary: list('primary', ad.texts.primary ?? [], 'Main text'),
    headlines: list('headline', ad.texts.headlines ?? [], 'Headline'),
    descriptions: list('description', ad.texts.descriptions ?? [], 'Extra line'),
  };
}

/** True when `index` names a text this ad really has for that kind (the copy log refuses anything else). */
export function copyTargetExists(ad: { texts: Pick<AdTexts, 'primary' | 'headlines' | 'descriptions'> }, kind: CopyKind, index: number): boolean {
  if (!Number.isInteger(index) || index < 0) return false;
  if (kind === 'name' || kind === 'link') return index === 0;
  const list = kind === 'primary' ? ad.texts.primary : kind === 'headline' ? ad.texts.headlines : ad.texts.descriptions;
  return index < (list ?? []).length;
}

// ── Picture files ──

export type SizeKey = '4x5' | '9x16' | '1x1';
export type FileLabel = { name: string; size: string; ratio: SizeKey; width: number; height: number };
export type CardFiles = { card: number; files: FileLabel[]; previewName: string };

/** The three sizes in the order they are offered, in the words Facebook uses for where they show. */
export const SIZE_INFO: Record<SizeKey, { label: string; hint: string; order: number }> = {
  '4x5': { label: 'Feed', hint: 'Best for most people. Shows in the Facebook and Instagram feed.', order: 0 },
  '9x16': { label: 'Full screen', hint: 'For Stories and Reels on a phone.', order: 1 },
  '1x1': { label: 'Square', hint: 'Only if Facebook asks for a square one.', order: 2 },
};

const FILE_NAME = /^[a-z0-9]+-card(\d+)-(1x1|4x5|9x16)\.png$/i;

/** An ad's picture files grouped by picture, each with a plain size word; the preview is the feed (4:5) file when there is one. */
export function groupCardFiles(files: readonly { name: string; width: number; height: number }[]): CardFiles[] {
  const byCard = new Map<number, FileLabel[]>();
  for (const f of files) {
    const m = FILE_NAME.exec(f.name);
    if (!m) continue;
    const card = Number(m[1]);
    const ratio = m[2].toLowerCase() as SizeKey;
    const list = byCard.get(card) ?? [];
    list.push({ name: f.name, size: SIZE_INFO[ratio].label, ratio, width: f.width, height: f.height });
    byCard.set(card, list);
  }
  return [...byCard.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([card, list]) => ({ card, files: list, previewName: (list.find((f) => f.ratio === '4x5') ?? list[0]).name }));
}

// ── The three ads, by their plain names ──

export const AD_TITLES: Record<Angle, { number: number; title: string; blurb: string }> = {
  '5b': { number: 1, title: 'Your tenant has given notice', blurb: 'A short video for landlords whose tenant has given notice.' },
  '3a': { number: 2, title: 'Moving abroad', blurb: 'Pictures for landlords who are moving away from their home.' },
  '17': { number: 3, title: 'The renting rules have changed', blurb: 'Pictures that tell landlords the renting rules have changed.' },
};

export const adHeading = (angle: Angle): string => {
  const t = AD_TITLES[angle];
  return t ? `Ad ${t.number}: ${t.title}` : 'Your ad';
};

// ── What went wrong while making the ads ──

const CHECK_PLAIN: Record<CheckId, string> = {
  brand: 'Your company name, logo or colour could not be placed on every ad.',
  source_brand: 'Something in the ads did not belong to your business.',
  figures: 'The example figure could not be shown with its label.',
  length: 'One of the texts was too long for Facebook.',
  claims: 'One line sounded like a promise about what you will earn.',
  links: 'A link could not be matched to its ad.',
  files: 'A picture was not the right size.',
  video: 'The video did not come out right.',
};
export const CHECK_PLAIN_IDS = Object.keys(CHECK_PLAIN) as CheckId[];

/** Batch 55 step 5: the lead database ads' own reasons, in the same plain words. */
export const LD_CHECK_PLAIN: Record<LdCheckId, string> = {
  ld_format: 'Two of the ads came out as the same kind of ad.',
  ld_message: 'Two of the ads said the same thing.',
  ld_picture: 'Two of the ads looked too much alike.',
  ld_facts: 'One line said something we cannot be sure is true for you.',
  ld_offer: 'One ad did not say the free income report first.',
};

export type ProblemView = { title: string; lines: string[]; contact: string };

/** "We couldn't finish your ads": what went wrong in plain English (one line each), never a code. */
export function problemView(checks: { failures: readonly { check: string }[] } | null | undefined): ProblemView {
  const seen: string[] = [];
  for (const f of checks?.failures ?? []) if (!seen.includes(f.check)) seen.push(f.check);
  const plain: Record<string, string> = { ...CHECK_PLAIN, ...LD_CHECK_PLAIN };
  const lines = seen.map((id) => plain[id]).filter((l): l is string => typeof l === 'string');
  return {
    title: 'We could not finish your ads',
    lines: lines.length > 0 ? lines : ['Something in your ads did not come out right.'],
    contact: `${GET_IN_TOUCH} There is nothing you need to fix, and nothing has gone live.`,
  };
}

// ── The card on /leads ──

export type EntryCardView = { title: string; body: string; cta: string };

/** The "Your Facebook ads" card: what it says for the ads in each state (null: none made yet). */
export function entryCardView(status: PackStatus | null): EntryCardView {
  switch (status) {
    case null:
    case 'draft':
      return { title: 'Your Facebook ads', body: 'We make 3 ready-to-use ads in your company’s colours: two pictures and a short video.', cta: 'Make my ads' };
    case 'generating':
      return { title: 'Your ads are being made', body: 'This takes a few minutes. Open it to see how it is going.', cta: 'See my ads' };
    case 'preview':
      return { title: 'Your ads are ready to look at', body: 'Have a look, then follow the steps to put them on Facebook.', cta: 'Look at my ads' };
    case 'approved':
      return { title: 'Your ads are ready to use', body: 'Download your ads, then follow the steps to put them on Facebook.', cta: 'Open my ads' };
    case 'checks_failed':
    case 'failed':
      return { title: 'Your ads need a look', body: 'We could not finish them. Open it to see what to do next.', cta: 'Open my ads' };
  }
}

// ── The example figure ──

/** The labelled example figure the ads rest on (the first one), or null. Only the two sentences are ever read from it. */
export function figureCallout(figures: readonly unknown[] | null | undefined): { label: string; sentence: string } | null {
  const f = Array.isArray(figures) ? figures[0] : null;
  if (!f || typeof f !== 'object') return null;
  const o = f as Record<string, unknown>;
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  const sentence = typeof o.sentence === 'string' ? o.sentence.trim() : '';
  return label !== '' ? { label, sentence } : null;
}

// ── The voice step ──

export const VOICE_CHANGE_TITLE = 'Change the voice';
export const VOICE_CHANGE_BUTTON = 'Use this voice and make my video again';
export const VOICE_REMAKE_NOTE = 'Your video is made again with the new voice. This takes about 5 to 10 minutes, and we’ll email you when it’s ready.';

export type VoiceCardVm = { key: VoiceKey; label: string; description: string; previewUrl: string };

/** A few words for each voice, short enough to sit on one line of a phone. */
const VOICE_SHORT: Record<VoiceKey, string> = {
  jane: 'A warm woman, British',
  olivia: 'A friendly woman, British',
  oliver: 'A calm man, British',
};

/** The three voices, each with the free sample clip the operator plays before choosing. */
export function voiceCards(): VoiceCardVm[] {
  return VOICES.map((v) => ({ key: v.key, label: v.label, description: VOICE_SHORT[v.key], previewUrl: v.previewUrl }));
}

// ── The video's state, as the screen says it ──

export const VIDEO_MAKING_TEXT = 'Your video is being made. This takes about 5 to 10 minutes. You can close this page: we’ll email you when it’s ready.';
export const VIDEO_SLOW_TEXT = 'This is taking longer than usual. You can close this page: your video keeps being made, and we’ll email you when it’s ready.';
export const VIDEO_FINISHING_TEXT = 'Your video is ready. Loading it now…';
export const VOICE_UNAVAILABLE_TEXT = 'That voice is not available right now. Please pick another voice and we will make your video again.';
export const VIDEO_RETRY_TEXT = 'This sometimes happens. Please try again.';
export const VIDEO_CONTACT_TEXT = `${GET_IN_TOUCH} Nothing has gone live.`;
export const VIDEO_MISSING_TEXT = `There is no video here yet. ${GET_IN_TOUCH}`;

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
      return { state: v.status, heading: 'Your video is being made', message: VIDEO_MAKING_TEXT, poll: true, action: 'none' };
    case 'ready':
      return { state: 'ready', heading: 'Your video', message: null, poll: false, action: 'none' };
    case 'failed':
      if (v.code === 'voice_unavailable') return { state: 'failed', heading: 'Please pick another voice', message: VOICE_UNAVAILABLE_TEXT, poll: false, action: 'change_voice' };
      if (v.canRetry) return { state: 'failed', heading: 'We could not make your video', message: VIDEO_RETRY_TEXT, poll: false, action: 'retry' };
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

export type VideoFileVm = { name: string; label: string; ratio: '9:16' | '4:5' | '1:1'; size: SizeKey; width: number; height: number };

/** The three video sizes, in the order they are offered. The full screen one plays first. */
export const VIDEO_FILE_LABELS: Record<string, { label: string; ratio: VideoFileVm['ratio']; size: SizeKey; order: number }> = {
  'notice-9x16.mp4': { label: 'Full screen', ratio: '9:16', size: '9x16', order: 0 },
  'notice-4x5.mp4': { label: 'Feed', ratio: '4:5', size: '4x5', order: 1 },
  'notice-1x1.mp4': { label: 'Square', ratio: '1:1', size: '1x1', order: 2 },
};
export const VIDEO_POSTER_NAME = 'notice-poster.png';
export const isVideoFileName = (name: unknown): name is string => typeof name === 'string' && Object.prototype.hasOwnProperty.call(VIDEO_FILE_LABELS, name);

/** The video files a ready video has, in order, with their plain labels; empty unless the video is ready. */
export function videoFilesOf(video: AdFiles['video']): { files: VideoFileVm[]; poster: string | null; seconds: number | null } {
  if (!video || video.status !== 'ready') return { files: [], poster: null, seconds: null };
  const files = video.videos
    .filter((f) => isVideoFileName(f.name))
    .sort((a, b) => VIDEO_FILE_LABELS[a.name].order - VIDEO_FILE_LABELS[b.name].order)
    .map((f): VideoFileVm => ({ name: f.name, label: VIDEO_FILE_LABELS[f.name].label, ratio: VIDEO_FILE_LABELS[f.name].ratio, size: VIDEO_FILE_LABELS[f.name].size, width: f.width, height: f.height }));
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

/** The notice ad's video: its live state, and (when ready) its files with view links. */
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

// ── One ad, ready to lay out ──

export type AdCardVm = { card: number; previewUrl: string | null; files: FileLabel[] };

/** One size of one ad's files, to download in one tap. A picture ad has one file per picture; the video has one file. */
export type DownloadGroup = { key: SizeKey; label: string; hint: string; files: string[] };

export type AdVm = {
  id: string;
  angle: Angle;
  /** 1, 2 or 3. */
  number: number;
  /** "Ad 1: Your tenant has given notice". */
  heading: string;
  blurb: string;
  adName: string;
  copy: AdCopy;
  cards: AdCardVm[];
  /** The notice ad's video, null for a picture ad. */
  video: VideoVm | null;
  /** Batch 55 step 5 (A7): who the ad is for, in one plain line (lead database ads only). */
  concept?: string;
  /** What can be downloaded now, by size (empty while the video is still being made). */
  downloads: DownloadGroup[];
};

/** The downloads of one ad by size: a picture ad's whole set of pictures per size, or the video's file per size. */
export function downloadGroups(ad: { cards: readonly AdCardVm[]; video: VideoVm | null }): DownloadGroup[] {
  const bySize = new Map<SizeKey, string[]>();
  if (ad.video) {
    for (const f of ad.video.files) bySize.set(f.size, [...(bySize.get(f.size) ?? []), f.name]);
  } else {
    for (const c of ad.cards) for (const f of c.files) bySize.set(f.ratio, [...(bySize.get(f.ratio) ?? []), f.name]);
  }
  return [...bySize.entries()]
    .sort((a, b) => SIZE_INFO[a[0]].order - SIZE_INFO[b[0]].order)
    .map(([key, files]) => ({ key, label: SIZE_INFO[key].label, hint: SIZE_INFO[key].hint, files }));
}

/**
 * Everything the screen shows for one ad. `urlOf` turns a stored path into a view link (or null). `live` is the
 * notice video's live state from the pack read (it follows the render row); without it the ad's own video slot decides.
 */
export function adViewModel(
  ad: { id: string; angle: Angle; adName: string; link: string; texts: Pick<AdTexts, 'primary' | 'headlines' | 'descriptions'>; files: AdFiles },
  urlOf: (path: string) => string | null,
  live?: Pick<VideoView, 'status' | 'code' | 'poll' | 'canRetry' | 'message'> | null,
  /** Batch 55 step 5: the lead database route (the concept line, and 17's video). Absent: exactly as before. */
  opts?: { route?: 'academy' | 'leaddb' },
): AdVm {
  const pathOf = (name: string) => ad.files.images.find((f) => f.name === name)?.path ?? null;
  const cards = groupCardFiles(ad.files.images).map((c) => {
    const path = pathOf(c.previewName);
    return { card: c.card, previewUrl: path ? urlOf(path) : null, files: c.files };
  });
  const ld = opts?.route === 'leaddb';
  const hasVideo = ad.angle === '5b' || (ld && ad.files.video !== null);
  const video = hasVideo ? videoVm(ad.files.video, (ad.angle === '5b' ? live : null) ?? videoViewOfSlot(ad.files.video), urlOf) : null;
  const meta = AD_TITLES[ad.angle];
  return {
    ...(ld ? { concept: conceptLine(ad.angle) } : {}),
    id: ad.id,
    angle: ad.angle,
    number: meta?.number ?? 0,
    heading: adHeading(ad.angle),
    blurb: meta?.blurb ?? '',
    adName: ad.adName,
    copy: adCopyItems(ad),
    cards,
    video,
    downloads: downloadGroups({ cards, video }),
  };
}

// ── Batch 55 step 5 (A7): what each lead database ad is for, and what to add to the calculator ──

/** "For landlords whose tenant is leaving": one plain line per ad (ld-angles.ts). */
export function conceptLine(angle: Angle): string {
  return LD_ANGLE_DEFS[angle]?.concept.forWho ?? '';
}

export const CALCULATOR_SETTINGS_HREF = '/leads/setup/website';

/**
 * One line when the ads were made with little to go on (no logo, or no area): what to add and where. Never blocks
 * making the ads. Null when there is nothing to add.
 */
export function profileHint(p: { logoUrl: string | null; areas: readonly string[] }): NextStep | null {
  const noLogo = !p.logoUrl;
  const noArea = p.areas.filter((a) => String(a ?? '').trim() !== '').length === 0;
  if (!noLogo && !noArea) return null;
  const what = noLogo && noArea ? 'your logo and the areas you cover' : noLogo ? 'your logo' : 'the areas you cover';
  return { text: `Your ads look best with ${what}. Add them on your calculator page and your next ads will use them.`, href: CALCULATOR_SETTINGS_HREF, label: 'Open your calculator page' };
}

// ── Looks good: why it may not be pressed yet ──

export type ApprovalVm = { ok: true } | { ok: false; message: string };

export const APPROVE_BUTTON = 'Looks good, show me how to put them on Facebook';
export const APPROVE_EXPLAIN = 'This keeps these ads as your final ones and opens the steps for putting them on Facebook.';
const VIDEO_PENDING_TEXT = 'This button works as soon as your video is ready.';

/** "Looks good" is off, with the plain reason, until the video is ready and the ads are fine. */
export function approvalVm(view: Pick<PackView, 'approval' | 'video'>): ApprovalVm {
  if (view.approval.ok) return { ok: true };
  const s = view.video.status;
  if (s === 'queued' || s === 'making') return { ok: false, message: VIDEO_PENDING_TEXT };
  if (s === 'failed' || s === 'coming') return { ok: false, message: PLAIN_CODES.video_failed };
  return { ok: false, message: plainRefusal(view.approval.code, view.approval.message) };
}

// ── Change voice ──

export type VoiceVm = {
  current: VoiceKey | null;
  currentLabel: string | null;
  canChange: boolean;
  changesLeft: number;
  /** The change would not use up the one change (the first voice could not be used). */
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
      ? `You can change the voice ${v.changesLeft === 1 ? 'once' : `${v.changesLeft} times`} before you move on.`
      : 'You have already used your voice change.';
  return {
    current: v.key,
    currentLabel: voiceByKey(v.key)?.label ?? null,
    canChange: v.canChange,
    changesLeft: v.changesLeft,
    free: v.free,
    note,
    blocked: v.blocked ? plainRefusal(v.blocked.code, v.blocked.message) : null,
  };
}

// ── Polling while the video is made ──

export const POLL_INTERVAL_MS = 8000;
export const POLL_GIVE_UP_MS = 15 * 60 * 1000;

export type PollStep = 'wait' | 'settled' | 'give_up';

/**
 * What the screen does after an answer from the server: keep waiting, reload the page because the video has
 * settled (ready, failed, or the ads moved on), or stop and say it is taking longer than usual.
 */
export function pollStep(i: { startedMs: number; nowMs: number; poll: boolean; versionChanged?: boolean }): PollStep {
  if (!i.poll || i.versionChanged) return 'settled';
  return i.nowMs - i.startedMs >= POLL_GIVE_UP_MS ? 'give_up' : 'wait';
}

/** The lightweight answer to a poll: what the video, the "looks good" button and the voice step need, nothing else. */
export type PollView = { version: number; video: VideoCardView; approval: ApprovalVm; voice: VoiceVm };

export function pollViewOf(view: PackView): PollView {
  return { version: view.pack.version, video: videoCardView(view.video), approval: approvalVm(view), voice: voiceVm(view.voice) };
}

// ── Which screen (client-safe, from what the page already decided) ──

/**
 * The stage the page is on, from the ads' state and the video's state:
 *   start     no ads yet (or a first try that failed)
 *   working   the pictures are being made right now
 *   problem   the ads did not come out right
 *   making    the pictures are ready; the video is being made (or needs a hand)
 *   review    everything is ready to look at
 *   approved  the operator said "looks good"
 */
export type Stage = 'start' | 'working' | 'problem' | 'making' | 'review' | 'approved';

export function stageOf(screen: 'start' | 'working' | 'preview' | 'approved' | 'checks_failed', video: VideoVm['card']['state'] | null): Stage {
  switch (screen) {
    case 'start':
      return 'start';
    case 'working':
      return 'working';
    case 'checks_failed':
      return 'problem';
    case 'approved':
      return 'approved';
    case 'preview':
      return video === 'ready' ? 'review' : 'making';
  }
}

// ── "More options": new ads after a change ──

export const MORE_OPTIONS_TITLE = 'More options';
export const REGEN_TITLE = 'Make new ads';
export const REGEN_BUTTON = 'Make new ads';
export const REGEN_NOTE = 'Your video keeps its voice. If you want a different voice, change it first, above.';

/** What the "make new ads" part says: the free chance, or why there is none left. */
export function regenIntro(left: number, reason: string | null): string {
  if (left > 0) {
    return `You can make new ads ${left === 1 ? 'once' : `${left} times`} for free. First change your logo, colours, company name or fee on your website, or change the place or photos below.`;
  }
  return reason ?? PLAIN_CODES.regen_used;
}

/**
 * The files a screen needs a view link for: one picture per card (the feed size, which is what is shown), and for a
 * ready video its three files and the first frame (the player gets its first link at once).
 */
export function previewPathsOf(files: AdFiles): string[] {
  const paths = groupCardFiles(files.images)
    .map((c) => files.images.find((f) => f.name === c.previewName)?.path ?? null)
    .filter((p): p is string => p !== null);
  if (files.video && files.video.status === 'ready') paths.push(...files.video.videos.map((f) => f.path), files.video.poster.path);
  return paths;
}
