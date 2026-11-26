/**
 * Batch 38: the automatic checks every pack passes before an operator sees it.
 *
 * `runChecks(input)` reads the pack the way a reader of the ads would (every
 * text, the script, every card, every link and every image size) and returns
 * the failures and warnings, each with where it is and what is wrong in plain
 * words. Nothing is fixed here: a failed pack is not shown, it is regenerated
 * or reported.
 *
 *   brand        the company name is in each ad, the logo is there (or the
 *                operator chose type-only), the brand colour is a real hex and
 *                is readable under the text colour the renderer will use
 *   source_brand   no source-brand word, site, example figure or fee line; a
 *                percentage is only ever the operator's own fee
 *   figures      every £ figure is labelled, one example per ad, and its area
 *                is the pack's area
 *   length       headline / primary text / description limits (limits.ts):
 *                red fails, amber passes with a warning
 *   claims       no banned claim (websites/checks.ts), no income range, no
 *                "you will earn", no guarantee
 *   links        ?ad=<its code>, utm_content={{ad.id}} literally, the
 *                operator's domain (or, on the lead database route, this
 *                app's own host and /s/<slug>), a code that belongs to the operator
 *   files        image sizes are exactly 1080x1080, 1080x1350 or 1080x1920
 *   video        (38b, only when `videos` is given: the 5b ad's three MP4s as the sandbox
 *                measured them) exact sizes by name, a length over 0 and up to 60 s, an
 *                audio track, and burned-in captions
 *
 * Pure: no network, no database, no server-only.
 */

import { bannedClaimHits } from '../websites/checks.ts';
import { parseCode, type Angle } from './codes.ts';
import { figureIsLabelled, POUND_RE } from './figures.ts';
import { adLink, adName, AD_ID_PLACEHOLDER } from './links.ts';
import { checkLength } from './limits.ts';

// ── Colour ──

const HEX6 = /^#[0-9a-f]{6}$/i;

export const TEXT_ON_DARK = '#ffffff';
export const TEXT_ON_LIGHT = '#111111';
/** WCAG's minimum for large text and graphics; the brand colour must reach it under the chosen text colour. */
export const MIN_CONTRAST = 3;
/** WCAG's AA for normal text: under it the check passes with a warning. */
export const GOOD_CONTRAST = 4.5;

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 to 1) of #rrggbb, or null when it is not a 6-digit hex. */
export function relativeLuminance(hex: string): number | null {
  if (typeof hex !== 'string' || !HEX6.test(hex.trim())) return null;
  const h = hex.trim().slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The WCAG contrast ratio (1 to 21) between two #rrggbb colours, or null when either is not one. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The text colour the renderer puts on a brand-colour background: white or
 * near-black (#111111), whichever has the higher contrast. An invalid colour
 * reads as white (the check reports the colour itself).
 */
export function pickTextColour(hex: string): typeof TEXT_ON_DARK | typeof TEXT_ON_LIGHT {
  const white = contrastRatio(hex, TEXT_ON_DARK);
  const dark = contrastRatio(hex, TEXT_ON_LIGHT);
  if (white === null || dark === null) return TEXT_ON_DARK;
  return dark > white ? TEXT_ON_LIGHT : TEXT_ON_DARK;
}

// ── Image sizes ──

/** Feed (1:1), portrait feed (4:5) and Stories/Reels (9:16). */
export const AD_IMAGE_SIZES: readonly { width: number; height: number; label: string }[] = [
  { width: 1080, height: 1080, label: '1:1' },
  { width: 1080, height: 1350, label: '4:5' },
  { width: 1080, height: 1920, label: '9:16' },
];

// ── Input and output ──

export type CheckBrand = {
  company: string;
  logoUrl: string | null;
  brandColour: string | null;
  feePct: number | null;
  areaLabel: string;
  areaKey: string;
  /** The operator has no logo and chose to run the ads with their name in type only. */
  typeOnly?: boolean;
};

export type CheckAd = {
  angle: Angle;
  code: string;
  adName: string;
  link: string;
  texts: { primary: string[]; headlines: string[]; descriptions: string[] };
  /** The 5b voiceover as one string. */
  script?: string;
  /** The complete text of each image card: one entry per card (its lines joined), so a figure and its label travel together. */
  cardsText?: string[];
  files?: { name: string; width: number; height: number }[];
};

/** One rendered MP4 of the 5b ad as the sandbox measured it (ffprobe, and the renderer's render-info.json). */
export type CheckVideo = { name: string; width: number; height: number; durationSeconds: number; hasAudio: boolean; captionCount: number };

/** The notice video's files by name, with the exact size each must have. */
export const VIDEO_SIZES: Record<string, { width: number; height: number }> = {
  'notice-9x16.mp4': { width: 1080, height: 1920 },
  'notice-4x5.mp4': { width: 1080, height: 1350 },
  'notice-1x1.mp4': { width: 1080, height: 1080 },
};
/** Meta Reels and Stories ads run to 60 seconds; the notice voiceover is far shorter. */
export const MAX_VIDEO_SECONDS = 60;

export type CheckFigure = { areaKey: string; label?: string; sentence?: string };

export type CheckInput = {
  brand: CheckBrand;
  ads: CheckAd[];
  figures: CheckFigure[];
  /** The 6-character operator code the pack codes must carry. */
  operatorCode: string;
  /** The operator's bare domain, e.g. acme.co.uk. On the lead database route this is this app's own host. */
  domain: string;
  /**
   * The lead database route (Batch 55): the slug of the calculator site the links go to, so every link must be the
   * `https://<domain>/s/<slug>?ad=...` shape. Absent (the Academy route): every link must be the bare-host shape.
   */
  sitePath?: string;
  /**
   * The 5b ad's rendered MP4s (38b). Omitted at generation time (the video does not exist yet): the video check
   * then has nothing to say. Given (also as an empty list) it is checked: all three sizes must be there.
   */
  videos?: CheckVideo[];
};

export const CHECK_IDS = ['brand', 'source_brand', 'figures', 'length', 'claims', 'links', 'files', 'video'] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export const CHECK_LABELS: Record<CheckId, string> = {
  brand: 'Your brand is on every ad',
  source_brand: 'Nothing from anyone else',
  figures: 'The example figure is labelled and from your area',
  length: 'Texts fit Meta’s limits',
  claims: 'No income promises or ranges',
  links: 'Every link tracks its ad',
  files: 'Image sizes are right',
  video: 'The video is made properly',
};

export type CheckFailure = { check: CheckId; rule: string; where: string; detail: string };
export type CheckWarning = { check: CheckId; where: string; detail: string };
/** `ran` is on the `video` entry only, and only when the video check was really run on rendered files (38b): its absence means "not checked yet". */
export type CheckResult = { check: CheckId; label: string; ok: boolean; failures: number; warnings: number; ran?: true };

export type ChecksOutput = {
  ok: boolean;
  failures: CheckFailure[];
  warnings: CheckWarning[];
  results: CheckResult[];
};

// ── Helpers ──

type Piece = { where: string; kind: 'primary' | 'headline' | 'description' | 'script' | 'card'; text: string };

const KIND_WORD: Record<Piece['kind'], string> = { primary: 'primary text', headline: 'headline', description: 'description', script: 'script', card: 'card' };

function piecesOf(ad: CheckAd): Piece[] {
  const out: Piece[] = [];
  const add = (kind: Piece['kind'], list: string[] | undefined) =>
    (list ?? []).forEach((text, i) =>
      out.push({ where: `${ad.angle} ${KIND_WORD[kind]}${list && list.length > 1 ? ` ${i + 1}` : ''}`, kind, text: String(text ?? '').replace(/\s+/g, ' ').trim() }),
    );
  add('primary', ad.texts?.primary);
  add('headline', ad.texts?.headlines);
  add('description', ad.texts?.descriptions);
  if (typeof ad.script === 'string' && ad.script.trim() !== '') add('script', [ad.script]);
  add('card', ad.cardsText);
  return out;
}

function excerpt(text: string, index: number, len: number): string {
  const from = Math.max(0, index - 15);
  const to = Math.min(text.length, index + len + 15);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

// The source brand is built from parts so a repo-wide search for the name finds no copy of it in the package.
const SOURCE_NAME = 'stay' + 'ful';
const SOURCE_WORD_RE = new RegExp(SOURCE_NAME, 'i');
const SOURCE_FIGURES_RE = /(?<![\d,.])(?:2,?399|1,?349|3,?097|7,?681|939)(?![\d]|,\d)/;
const VAT_RE = /\bV\.?A\.?T\.?(?![a-z])|\bplus\s+VAT\b/i;
const PERCENT_RE = /(\d+(?:\.\d+)?)\s?%/g;
const SPOKEN_FIFTEEN_RE = /\bfifteen\s+(?:percent|per\s?cent)\b/i;

const GUARANTEE_RE = /\bguarantee[sd]?\b/i;
const MONEY = String.raw`£\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m)?`;
const RANGE_RES: { re: RegExp; what: string }[] = [
  { re: new RegExp(String.raw`${MONEY}\s*(?:-|–|—|to)\s*£?\s?\d`, 'i'), what: 'a range of amounts' },
  { re: new RegExp(String.raw`\bbetween\s+${MONEY}\s+and\s+£?\s?\d`, 'i'), what: 'a range of amounts' },
  { re: /\bfrom\s+£\s?\d[\d,]*\s+to\s+£?\s?\d/i, what: 'a range of amounts' },
  { re: /\bup\s+to\s+£\s?\d|\bas\s+much\s+as\s+£\s?\d/i, what: 'a “up to” amount' },
];

function poundAmounts(text: string): string[] {
  const out: string[] = [];
  const re = /£\s?(\d[\d,]*(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1].replace(/,/g, ''));
  return out;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

// ── The video checks ──

/**
 * The video check on its own (runChecks calls it; the render worker calls it after a render and merges the
 * result into the pack's stored checks with mergeVideoChecks). Plain words in `detail`, no codes.
 */
export function videoChecks(videos: readonly CheckVideo[]): { failures: CheckFailure[]; warnings: CheckWarning[] } {
  const failures: CheckFailure[] = [];
  const fail = (rule: string, where: string, detail: string) => failures.push({ check: 'video', rule, where, detail });
  const list = Array.isArray(videos) ? videos : [];
  const seen = new Set<string>();
  for (const v of list) {
    const where = `ad 5b ${v.name}`;
    const size = VIDEO_SIZES[v.name];
    if (!size) {
      fail('video_name', where, 'This is not one of the three video files the pack should have.');
    } else {
      seen.add(v.name);
      if (v.width !== size.width || v.height !== size.height) fail('video_size', where, `The video is ${v.width}x${v.height}; it must be exactly ${size.width}x${size.height}.`);
    }
    if (!Number.isFinite(v.durationSeconds) || v.durationSeconds <= 0) fail('video_length', where, 'The video has no length.');
    else if (v.durationSeconds > MAX_VIDEO_SECONDS) fail('video_length', where, `The video is ${Math.round(v.durationSeconds)} seconds long; it must be ${MAX_VIDEO_SECONDS} seconds or less.`);
    if (v.hasAudio !== true) fail('video_audio', where, 'The video has no sound.');
    if (!Number.isFinite(v.captionCount) || v.captionCount < 1) fail('video_captions', where, 'The video has no captions on screen.');
  }
  for (const name of Object.keys(VIDEO_SIZES)) if (!seen.has(name)) fail('video_missing', `ad 5b ${name}`, 'This video file is missing.');
  return { failures, warnings: [] };
}

function resultsOf(failures: readonly CheckFailure[], warnings: readonly CheckWarning[], videoRan = false): CheckResult[] {
  return CHECK_IDS.map((check) => {
    const fs = failures.filter((f) => f.check === check).length;
    return { check, label: CHECK_LABELS[check], ok: fs === 0, failures: fs, warnings: warnings.filter((w) => w.check === check).length, ...(check === 'video' && videoRan ? { ran: true as const } : {}) };
  });
}

/**
 * The pack's stored checks with the video check (re)done: earlier `video` failures are dropped, the new ones are
 * added, and `ok` and `results` are recomputed. Everything else in `prev` is kept as it was. A null `prev` starts empty.
 */
export function mergeVideoChecks(prev: ChecksOutput | null | undefined, videos: readonly CheckVideo[]): ChecksOutput {
  const v = videoChecks(videos);
  const failures = [...(prev?.failures ?? []).filter((f) => f.check !== 'video'), ...v.failures];
  const warnings = [...(prev?.warnings ?? []).filter((w) => w.check !== 'video'), ...v.warnings];
  return { ok: failures.length === 0, failures, warnings, results: resultsOf(failures, warnings, true) };
}

// ── The checks ──

export function runChecks(input: CheckInput): ChecksOutput {
  const failures: CheckFailure[] = [];
  const warnings: CheckWarning[] = [];
  const fail = (check: CheckId, rule: string, where: string, detail: string) => failures.push({ check, rule, where, detail });
  const warn = (check: CheckId, where: string, detail: string) => warnings.push({ check, where, detail });

  const { brand } = input;
  const ads = Array.isArray(input.ads) ? input.ads : [];
  const feePct = typeof brand.feePct === 'number' && Number.isFinite(brand.feePct) ? brand.feePct : null;
  const company = String(brand.company ?? '').trim();

  // (a) Brand applied.
  if (company === '') fail('brand', 'brand_company', 'pack', 'There is no company name to put on the ads.');
  if (String(brand.areaKey ?? '').trim() === '' || String(brand.areaLabel ?? '').trim() === '') fail('brand', 'brand_area', 'pack', 'The pack has no area.');
  const logo = typeof brand.logoUrl === 'string' ? brand.logoUrl.trim() : '';
  if (logo === '' && brand.typeOnly !== true) fail('brand', 'brand_logo', 'pack', 'There is no logo. Add one, or choose to run the ads with your name in type only.');
  else if (logo !== '' && !/^https:\/\//i.test(logo)) fail('brand', 'brand_logo', 'pack', 'The logo address is not a secure (https) link.');
  const colour = typeof brand.brandColour === 'string' ? brand.brandColour.trim() : '';
  if (!HEX6.test(colour)) {
    fail('brand', 'brand_colour', 'pack', 'The brand colour is missing or is not a six-digit colour such as #1a5fb4.');
  } else {
    const text = pickTextColour(colour);
    const ratio = contrastRatio(colour, text) ?? 0;
    if (ratio < MIN_CONTRAST) fail('brand', 'brand_contrast', 'pack', `Text on the brand colour would be hard to read (contrast ${ratio.toFixed(1)}, needs ${MIN_CONTRAST}).`);
    else if (ratio < GOOD_CONTRAST) warn('brand', 'pack', `Text on the brand colour is readable but not strong (contrast ${ratio.toFixed(1)}).`);
  }
  if (company !== '') {
    const needle = company.toLowerCase();
    for (const ad of ads) {
      const found = piecesOf(ad).some((p) => p.text.toLowerCase().includes(needle));
      if (!found) fail('brand', 'brand_company', ad.angle, `The company name “${company}” is not in any text of this ad.`);
    }
  }

  // (b) Nothing from the source brand.
  const brandStrings: { where: string; text: string }[] = [
    { where: 'company name', text: company },
    { where: 'area', text: String(brand.areaLabel ?? '') },
  ];
  // The lead database route links to this app's own address, so its host (and only its host) is not "the source brand" there.
  const ownPrefix = input.sitePath === undefined ? null : `https://${String(input.domain ?? '').trim().toLowerCase()}/`;
  for (const ad of ads) {
    const link = String(ad.link ?? '');
    const linkText = ownPrefix !== null && link.toLowerCase().startsWith(ownPrefix) ? link.slice(ownPrefix.length) : link;
    brandStrings.push({ where: `${ad.angle} link`, text: linkText }, { where: `${ad.angle} ad name`, text: String(ad.adName ?? '') });
  }
  for (const s of brandStrings) {
    const m = SOURCE_WORD_RE.exec(s.text);
    if (m) fail('source_brand', 'source_word', s.where, `It mentions ${m[0]}, which must never appear in your ads.`);
  }
  for (const ad of ads) {
    const pieces = piecesOf(ad);
    for (const p of pieces) {
      const word = SOURCE_WORD_RE.exec(p.text);
      if (word) fail('source_brand', 'source_word', `ad ${p.where}`, `It mentions ${word[0]}, which must never appear in your ads.`);
      const fig = SOURCE_FIGURES_RE.exec(p.text);
      if (fig) fail('source_brand', 'source_figure', `ad ${p.where}`, `It carries a figure (${fig[0]}) that belongs to someone else’s example.`);
      const vat = VAT_RE.exec(p.text);
      if (vat) fail('source_brand', 'source_fee_line', `ad ${p.where}`, 'It mentions VAT. Only your own fee goes in an ad, and never a “+ VAT” line.');
      PERCENT_RE.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = PERCENT_RE.exec(p.text))) {
        const n = Number(pm[1]);
        if (feePct === null || n !== feePct) {
          const isSource = n === 15 && feePct !== 15;
          fail(
            'source_brand',
            isSource ? 'source_fee_line' : 'fee_not_yours',
            `ad ${p.where}`,
            isSource ? 'It carries a 15% fee that is not your own fee.' : `It carries ${pm[0]}, which is not your management fee.`,
          );
          break;
        }
      }
      if (p.kind === 'script' && SPOKEN_FIFTEEN_RE.test(p.text) && feePct !== 15) fail('source_brand', 'source_fee_line', `ad ${p.where}`, 'The script says fifteen percent, which is not your own fee.');
    }
  }

  // (c) Figures: labelled, one per ad, from the pack's own area.
  for (const f of Array.isArray(input.figures) ? input.figures : []) {
    if (f.areaKey !== brand.areaKey) fail('figures', 'figure_area', 'pack', `A figure comes from a different area (${f.areaKey || 'none'}) than the pack’s (${brand.areaKey || 'none'}).`);
  }
  for (const ad of ads) {
    const amounts = new Set<string>();
    let anyPound = false;
    for (const p of piecesOf(ad)) {
      if (!POUND_RE.test(p.text)) continue;
      anyPound = true;
      for (const a of poundAmounts(p.text)) amounts.add(a);
      if (!figureIsLabelled(p.text)) fail('figures', 'figure_unlabelled', `ad ${p.where}`, 'It has a £ figure without the “Example: a typical…” label next to it.');
    }
    if (amounts.size > 1) fail('figures', 'figure_multiple', `ad ${ad.angle}`, `The ad quotes ${amounts.size} different £ figures; an ad carries one labelled example.`);
    if (anyPound && (!Array.isArray(input.figures) || input.figures.length === 0)) fail('figures', 'figure_missing', `ad ${ad.angle}`, 'The ad has a £ figure but the pack has no figure behind it.');
  }

  // (d) Lengths.
  for (const ad of ads) {
    const groups: { kind: 'primary' | 'headline' | 'description'; word: string; list: string[] }[] = [
      { kind: 'primary', word: 'primary text', list: ad.texts?.primary ?? [] },
      { kind: 'headline', word: 'headline', list: ad.texts?.headlines ?? [] },
      { kind: 'description', word: 'description', list: ad.texts?.descriptions ?? [] },
    ];
    for (const g of groups) {
      if (g.list.length === 0) fail('length', 'text_missing', `ad ${ad.angle}`, `The ad has no ${g.word}.`);
      g.list.forEach((t, i) => {
        const where = `ad ${ad.angle} ${g.word}${g.list.length > 1 ? ` ${i + 1}` : ''}`;
        const r = checkLength(g.kind, String(t ?? ''));
        if (r.level === 'red') fail('length', 'length', where, r.notes.join(' ') || 'It does not fit the limit.');
        else if (r.level === 'amber') warn('length', where, r.notes.join(' '));
      });
    }
  }

  // (e) Claims, ranges, "you will earn", guarantees.
  for (const ad of ads) {
    for (const p of piecesOf(ad)) {
      for (const hit of bannedClaimHits(p.text)) {
        const rule = hit.id === 'income_range' ? 'income_range' : hit.id === 'you_will_earn' ? 'you_will_earn' : hit.id === 'guaranteed_income' ? 'guarantee' : 'banned_claim';
        fail('claims', rule, `ad ${p.where}`, `It makes ${hit.what} (“${hit.excerpt}”).`);
      }
      const g = GUARANTEE_RE.exec(p.text);
      if (g) fail('claims', 'guarantee', `ad ${p.where}`, `It uses the word “${g[0]}”. An ad never guarantees anything.`);
      for (const r of RANGE_RES) {
        const m = r.re.exec(p.text);
        if (m) {
          fail('claims', 'income_range', `ad ${p.where}`, `It shows ${r.what} (“${excerpt(p.text, m.index, m[0].length)}”). One labelled example only.`);
          break;
        }
      }
    }
  }

  // (f) Links and codes.
  const operator = String(input.operatorCode ?? '').toUpperCase();
  const domain = String(input.domain ?? '').trim().toLowerCase();
  if (!HOST_RE.test(domain)) fail('links', 'link_domain', 'pack', 'The pack has no valid domain to link to.');
  const seenCodes = new Set<string>();
  for (const ad of ads) {
    const where = `ad ${ad.angle}`;
    const parsed = parseCode(ad.code);
    if (!parsed) {
      fail('links', 'link_code', where, 'The ad’s code is not a valid pack code.');
    } else {
      if (parsed.operatorCode !== operator) fail('links', 'link_operator', where, 'The ad’s code does not belong to this operator.');
      if (parsed.angle !== ad.angle) fail('links', 'link_code', where, 'The ad’s code is for a different ad angle.');
      if (seenCodes.has(ad.code)) fail('links', 'link_code', where, 'Two ads share the same code.');
      seenCodes.add(ad.code);
    }
    if (!String(ad.adName ?? '').startsWith(String(ad.code ?? '')) || !String(ad.code ?? '')) fail('links', 'ad_name', where, 'The ad name does not start with the ad’s code.');
    else if (parsed) {
      try {
        if (ad.adName !== adName(ad.code, ad.angle)) fail('links', 'ad_name', where, 'The ad name is not the standard “code · name” form.');
      } catch {
        fail('links', 'ad_name', where, 'The ad name is not the standard “code · name” form.');
      }
    }

    const link = String(ad.link ?? '');
    let url: URL | null = null;
    try {
      url = new URL(link);
    } catch {
      url = null;
    }
    if (!url) {
      fail('links', 'link_invalid', where, 'The link is not a valid address.');
      continue;
    }
    if (url.protocol !== 'https:') fail('links', 'link_invalid', where, 'The link is not a secure (https) address.');
    if (url.hostname.toLowerCase() !== domain) fail('links', 'link_domain', where, `The link goes to ${url.hostname}, not your domain ${domain}.`);
    const adParam = url.searchParams.get('ad');
    if (!adParam) fail('links', 'link_ad_code', where, 'The link has no ?ad= code, so leads could not be matched to this ad.');
    else if (adParam !== ad.code) fail('links', 'link_ad_code', where, 'The link’s ?ad= code is not this ad’s code.');
    if (!link.includes(`utm_content=${AD_ID_PLACEHOLDER}`)) fail('links', 'link_placeholder', where, `The link must contain utm_content=${AD_ID_PLACEHOLDER} exactly, so Meta can fill in the ad id.`);
    if (parsed && HOST_RE.test(domain) && /^[0-9A-F]{6}$/.test(operator) && parsed.operatorCode === operator) {
      try {
        if (link !== adLink(input.sitePath === undefined ? { domain, code: ad.code, operatorCode: operator } : { domain, sitePath: input.sitePath, code: ad.code, operatorCode: operator })) fail('links', 'link_shape', where, 'The link is not in the standard tracked form.');
      } catch {
        fail('links', 'link_shape', where, 'The link is not in the standard tracked form.');
      }
    }
  }

  // (g) Image sizes.
  for (const ad of ads) {
    for (const f of ad.files ?? []) {
      const ok = AD_IMAGE_SIZES.some((s) => s.width === f.width && s.height === f.height);
      if (!ok) fail('files', 'file_size', `ad ${ad.angle} ${f.name}`, `The image is ${f.width}x${f.height}; it must be exactly 1080x1080, 1080x1350 or 1080x1920.`);
    }
  }

  // (h) The notice video, when it has been rendered.
  if (Array.isArray(input.videos)) {
    const v = videoChecks(input.videos);
    failures.push(...v.failures);
    warnings.push(...v.warnings);
  }

  return { ok: failures.length === 0, failures, warnings, results: resultsOf(failures, warnings, Array.isArray(input.videos)) };
}
