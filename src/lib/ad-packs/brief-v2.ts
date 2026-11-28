/**
 * Batch 55 step 5 (Phase 2, 55c A3): brief.json version 2, for the two new lead database videos.
 *
 *   report_walk.py  (kind 'phone', format phone_recording, ad 5b)  L1 offer over the phone showing the calculator,
 *                   L2 the form filled, L3 the report summary, L4 short let vs long let + the labelled figure,
 *                   L5 "Get your free income report" + company + logo
 *   loupe.py        (kind 'loupe', format loupe, ad 17)  L1 offer over the full page, L2 to L4 the magnifier over
 *                   comparables, occupancy and local demand, L5 the CTA
 *
 * Version 1 (render-core.ts buildBrief, notice.py) is untouched and stays the Academy's (and the lead database's
 * fallback when the example report failed).
 *
 * The contract (ad-render/README.md "Brief v2"):
 *   version        2
 *   concept_id     the ad's concept (ld-angles.ts)
 *   format         'phone_recording' | 'loupe'
 *   brand          { company, colour (#RRGGBB), logo (relative path or null) }
 *   base           '#F5F4ED' (cream) or '#FFFFFF' (white): the ad's own solid background; the brand colour is used
 *                  only for the logo strip, the headline bar, the caption highlight and the end button
 *   screen_lines   exactly 5: frame one, three scene lines, the CTA (what the viewer reads, pinned on the ad)
 *   figure_label   the labelled example sentence, or null (shown with L4 of the phone video only)
 *   stamp          'Example report' (on every frame that shows the report)
 *   report_pages   relative paths of the masked example pages (PNG), 1 to 6
 *   phone_frames   relative paths of the drawn phone frames (PNG, 5b only: the calculator, then the form filled)
 *   targets        the loupe's three stops: { page, x, y, w, h } as fractions of the page (17 only)
 *   script         the voiceover alignment (captions.ts BriefScript)
 *   audio, out_dir, out_prefix ('phone' | 'loupe')
 *
 * Pure: no network, no database, no server-only.
 */
import { validateBriefScript, type BriefScript } from './captions.ts';
import { EXAMPLE_STAMP } from './ld-angles.ts';
import { isSafeRelative, normaliseColour, AUDIO_PATH, OUT_DIR } from './render-core.ts';

export type LoupeTarget = { page: number; x: number; y: number; w: number; h: number };

export type BriefV2 = {
  version: 2;
  concept_id: string;
  format: 'phone_recording' | 'loupe';
  brand: { company: string; colour: string; logo: string | null };
  base: '#F5F4ED' | '#FFFFFF';
  screen_lines: string[];
  figure_label: string | null;
  stamp: string;
  report_pages: string[];
  phone_frames: string[];
  targets: LoupeTarget[];
  script: BriefScript;
  audio: string;
  out_dir: string;
  out_prefix: 'phone' | 'loupe';
};

export const MAX_REPORT_PAGES = 6;
export const MAX_PHONE_FRAMES = 4;
export const SCREEN_LINE_COUNT = 5;

/** The outputs of a v2 render and the names they are stored under. */
export function outputsV2(prefix: 'phone' | 'loupe') {
  return [
    { src: `${prefix}_9x16.mp4`, name: `${prefix}-9x16.mp4`, width: 1080, height: 1920, contentType: 'video/mp4' },
    { src: `${prefix}_4x5.mp4`, name: `${prefix}-4x5.mp4`, width: 1080, height: 1350, contentType: 'video/mp4' },
    { src: `${prefix}_1x1.mp4`, name: `${prefix}-1x1.mp4`, width: 1080, height: 1080, contentType: 'video/mp4' },
  ] as const;
}
export const posterV2 = (prefix: 'phone' | 'loupe') => ({ src: 'poster.png', name: `${prefix}-poster.png`, width: 1080, height: 1920, contentType: 'image/png' }) as const;
/** The first frame (9:16) the picture measure reads. */
export const FIRST_FRAME_PATH = 'out/first-frame.png';

export function buildBriefV2(i: {
  conceptId: string;
  format: 'phone_recording' | 'loupe';
  company: string;
  colour: string | null;
  logo: string | null;
  base: 'cream' | 'white';
  screenLines: readonly string[];
  figureLabel: string | null;
  reportPages: readonly string[];
  phoneFrames: readonly string[];
  targets: readonly LoupeTarget[];
  script: BriefScript;
}): BriefV2 {
  return {
    version: 2,
    concept_id: i.conceptId,
    format: i.format,
    brand: { company: i.company.replace(/\s+/g, ' ').trim(), colour: normaliseColour(i.colour), logo: i.logo },
    base: i.base === 'white' ? '#FFFFFF' : '#F5F4ED',
    screen_lines: [...i.screenLines],
    figure_label: i.format === 'phone_recording' ? i.figureLabel : null,
    stamp: EXAMPLE_STAMP,
    report_pages: [...i.reportPages],
    phone_frames: i.format === 'phone_recording' ? [...i.phoneFrames] : [],
    targets: i.format === 'loupe' ? i.targets.map((t) => ({ ...t })) : [],
    script: i.script,
    audio: AUDIO_PATH,
    out_dir: OUT_DIR,
    out_prefix: i.format === 'phone_recording' ? 'phone' : 'loupe',
  };
}

const frac = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** Why a v2 brief cannot be used (codes of the problem, never the text), or [] when it is fine. */
export function briefV2Problems(b: BriefV2): string[] {
  const p: string[] = [];
  if (b.version !== 2) p.push('version');
  if (b.format !== 'phone_recording' && b.format !== 'loupe') p.push('format');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(b.concept_id)) p.push('concept');
  if (!b.brand.company) p.push('company');
  if (!/^#[0-9A-F]{6}$/.test(b.brand.colour)) p.push('colour');
  if (b.brand.logo !== null && !isSafeRelative(b.brand.logo)) p.push('logo path');
  if (b.base !== '#F5F4ED' && b.base !== '#FFFFFF') p.push('base');
  if (b.screen_lines.length !== SCREEN_LINE_COUNT || b.screen_lines.some((l) => typeof l !== 'string' || l.trim() === '' || l.length > 160)) p.push('screen lines');
  if (b.stamp !== EXAMPLE_STAMP) p.push('stamp');
  if (b.report_pages.length < 1 || b.report_pages.length > MAX_REPORT_PAGES || !b.report_pages.every(isSafeRelative)) p.push('report pages');
  if (b.format === 'phone_recording' && (b.phone_frames.length < 1 || b.phone_frames.length > MAX_PHONE_FRAMES || !b.phone_frames.every(isSafeRelative))) p.push('phone frames');
  if (b.format === 'loupe' && (b.targets.length !== 3 || !b.targets.every((t) => Number.isInteger(t.page) && t.page >= 0 && t.page < b.report_pages.length && frac(t.x) && frac(t.y) && frac(t.w) && frac(t.h) && t.w > 0 && t.h > 0))) p.push('targets');
  if (!isSafeRelative(b.audio)) p.push('audio path');
  if (!isSafeRelative(b.out_dir)) p.push('out dir');
  if (!validateBriefScript(b.script).ok) p.push('script');
  else if (b.script.lines.length < 3) p.push('script lines');
  return p;
}
