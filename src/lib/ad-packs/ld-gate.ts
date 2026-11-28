/**
 * Batch 55 step 5 (Phase 2, 55c A5): the gate a LEAD DATABASE pack passes before the customer sees it.
 *
 * runChecks (checks.ts) calls ldGateChecks only when its input carries `ld` (the lead database route). The Academy
 * route never passes it, so its checks are byte-identical to before.
 *
 *   ld_format    the three ads have three different formats
 *   ld_message   no copy line and no on-screen line appears in two ads of the pack (the CTA line excepted)
 *   ld_picture   between the pack's three ads, colour overlap under PICTURE_MAX_OVERLAP and first-frame correlation
 *                under PICTURE_MAX_CORRELATION (a port of the approximate measure in Zac's buyer builds: a 4-bin
 *                per channel colour histogram and a small grey thumbnail). Run where the pictures exist: the render
 *                step (mergeLdPictureChecks), not at generation (the videos are made afterwards)
 *   ld_facts     every copy, on-screen and spoken line passes the customer's facts list (facts.ts)
 *   ld_offer     every primary text names the audience, the coverage, "free" and "report" in its first 125
 *                characters, with no question mark in its first sentence, and says "you stay the owner". The coverage
 *                (Phase 3) is the word "UK" for a nationwide pack, else the first chosen area (coverage.ts
 *                namesCoverage); without a coverage, the pack's one area as before
 *
 * SAME AREA (55c A5): chooseLook picks the base (cream or white) and the frame-one wording (a or b) so the pack never
 * starts like the latest pack of ANOTHER customer with the same main area. It is free: no new voice, no new report,
 * and it never uses up the customer's round. Phase 3: "the same main area" is keyed by coverage.ts lookKey: every
 * nationwide pack shares one pool (UK_LOOK_KEY), and an areas pack is keyed by its first chosen area's figure key.
 *
 * Pure: no network, no database, no server-only.
 */
import type { Angle } from './codes.ts';
import { isAdFormat, type AdFormat } from './concepts.ts';
import { checkLineAgainstFacts, type AdFacts } from './facts.ts';
import { CTA_LINE, LOOK_BASES, type Look, type HookVariant } from './ld-angles.ts';
import { firstSentence, AD_LIMITS } from './limits.ts';
import { namesCoverage, type Coverage } from './coverage.ts';

export const LD_CHECK_IDS = ['ld_format', 'ld_message', 'ld_picture', 'ld_facts', 'ld_offer'] as const;
export type LdCheckId = (typeof LD_CHECK_IDS)[number];
export const LD_CHECK_LABELS: Record<LdCheckId, string> = {
  ld_format: 'Three different kinds of ad',
  ld_message: 'Each ad says its own thing',
  ld_picture: 'The three ads look different',
  ld_facts: 'Every line is true for you',
  ld_offer: 'The free report comes first',
};

export const PICTURE_MAX_OVERLAP = 80;
export const PICTURE_MAX_CORRELATION = 70;
/** 4 bins per channel: 64 colour bins. */
export const HIST_BINS = 64;
/** The first-frame thumbnail is THUMB x THUMB grey values. */
export const THUMB = 32;

export type PictureStats = { hist: number[]; thumb: number[] };

export type LdGateAd = {
  angle: Angle;
  format: AdFormat | null | undefined;
  texts: { primary: string[]; headlines: string[]; descriptions: string[] };
  /** Frame one, the scene lines and the CTA. */
  screenLines: string[];
  /** The voiceover lines, for a video. */
  script?: string[] | null;
  picture?: PictureStats | null;
};

export type LdGateInput = {
  ads: LdGateAd[];
  facts: AdFacts;
  /** The pack's main area (the offer check looks for it when there is no coverage). */
  areaLabel: string;
  /** Phase 3: the pack's coverage. When set, the offer check looks for "UK" or the first chosen area instead. */
  coverage?: Coverage;
  /** Run the picture check (only when every ad has its picture stats). */
  pictures?: boolean;
};

export type LdFailure = { check: LdCheckId; rule: string; where: string; detail: string };

// ── The picture measure ──

/** A 64-bin colour histogram from RGB(A) pixels (4 bins per channel), normalised to sum 1. */
export function colourHistogram(pixels: Uint8Array | number[], channels: 3 | 4): number[] {
  const h = new Array<number>(HIST_BINS).fill(0);
  let n = 0;
  for (let i = 0; i + 2 < pixels.length; i += channels) {
    const r = Math.min(3, Math.floor(Number(pixels[i]) / 64));
    const g = Math.min(3, Math.floor(Number(pixels[i + 1]) / 64));
    const b = Math.min(3, Math.floor(Number(pixels[i + 2]) / 64));
    h[r * 16 + g * 4 + b]++;
    n++;
  }
  return n === 0 ? h : h.map((v) => v / n);
}

/** Histogram overlap (intersection) as a percent 0 to 100. */
export function histogramOverlap(a: readonly number[], b: readonly number[]): number {
  if (a.length !== HIST_BINS || b.length !== HIST_BINS) return 0;
  let s = 0;
  for (let i = 0; i < HIST_BINS; i++) s += Math.min(a[i], b[i]);
  return Math.round(Math.max(0, Math.min(1, s)) * 1000) / 10;
}

/** Pearson correlation of two grey thumbnails as a percent (negative read as 0). Flat images correlate 100 with each other. */
export function frameCorrelation(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  if (da === 0 && db === 0) return Math.abs(ma - mb) < 1 ? 100 : 0;
  if (da === 0 || db === 0) return 0;
  return Math.round(Math.max(0, num / Math.sqrt(da * db)) * 1000) / 10;
}

export function picturesTooSimilar(a: PictureStats, b: PictureStats): { overlap: number; correlation: number; tooSimilar: boolean } {
  const overlap = histogramOverlap(a.hist, b.hist);
  const correlation = frameCorrelation(a.thumb, b.thumb);
  return { overlap, correlation, tooSimilar: overlap >= PICTURE_MAX_OVERLAP || correlation >= PICTURE_MAX_CORRELATION };
}

// ── Same area ──

/**
 * The look for a new pack, given the looks of the latest packs of OTHER customers with the same main area. The first
 * look nobody else in the area is using, in the order cream/a, white/b, white/a, cream/b; when all four are taken, the
 * one used least. Deterministic, so a regenerate with the same neighbours keeps its look.
 */
export function chooseLook(others: readonly Look[]): { look: Look; switched: boolean } {
  const order: Look[] = [
    { base: LOOK_BASES[0], hook: 'a' },
    { base: LOOK_BASES[1], hook: 'b' },
    { base: LOOK_BASES[1], hook: 'a' },
    { base: LOOK_BASES[0], hook: 'b' },
  ];
  const key = (l: Look) => `${l.base}/${l.hook}`;
  const counts = new Map<string, number>();
  for (const o of others) counts.set(key(o), (counts.get(key(o)) ?? 0) + 1);
  const free = order.find((l) => !counts.has(key(l)));
  const look = free ?? [...order].sort((x, y) => (counts.get(key(x)) ?? 0) - (counts.get(key(y)) ?? 0))[0];
  return { look, switched: key(look) !== key(order[0]) };
}

export function isLook(v: unknown): v is Look {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (o.base === 'cream' || o.base === 'white') && (o.hook === ('a' as HookVariant) || o.hook === ('b' as HookVariant));
}

// ── The gate ──

const norm = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.\s]+$/, '');
const CTA_NORM = norm(CTA_LINE);

function linesOf(ad: LdGateAd): { kind: string; text: string }[] {
  return [
    ...ad.texts.primary.map((text) => ({ kind: 'primary text', text })),
    ...ad.texts.headlines.map((text) => ({ kind: 'headline', text })),
    ...ad.texts.descriptions.map((text) => ({ kind: 'description', text })),
    ...ad.screenLines.map((text) => ({ kind: 'on-screen line', text })),
    ...(ad.script ?? []).map((text) => ({ kind: 'voiceover line', text })),
  ];
}

export function ldGateChecks(input: LdGateInput): LdFailure[] {
  const out: LdFailure[] = [];
  const fail = (check: LdCheckId, rule: string, where: string, detail: string) => out.push({ check, rule, where, detail });
  const ads = Array.isArray(input.ads) ? input.ads : [];

  // Format: three different formats.
  const formats = ads.map((a) => a.format);
  for (const a of ads) if (!isAdFormat(a.format)) fail('ld_format', 'format_missing', `ad ${a.angle}`, 'This ad has no format.');
  if (new Set(formats.filter(isAdFormat)).size !== ads.length || ads.length !== 3) fail('ld_format', 'format_repeated', 'pack', 'Two ads use the same kind of ad. Each of the three must be different.');

  // Message: no line in two ads.
  const owner = new Map<string, Angle>();
  for (const a of ads) {
    const mine = new Set<string>();
    for (const l of linesOf(a)) {
      const k = norm(l.text);
      if (k === '' || k === CTA_NORM || mine.has(k)) continue;
      mine.add(k);
      const first = owner.get(k);
      if (first !== undefined && first !== a.angle) fail('ld_message', 'line_shared', `ad ${a.angle} ${l.kind}`, `The same line is in ad ${first} too. Each ad must say its own thing.`);
      else owner.set(k, a.angle);
    }
  }

  // Facts.
  for (const a of ads) {
    for (const l of linesOf(a)) {
      for (const p of checkLineAgainstFacts(l.text, input.facts)) fail('ld_facts', p.rule, `ad ${a.angle} ${l.kind}`, p.detail);
    }
  }

  // Offer first.
  const area = String(input.areaLabel ?? '').trim().toLowerCase();
  const coverage = input.coverage;
  const namesWhere = (text: string): boolean => (coverage ? namesCoverage(text, coverage) : !area || text.includes(area));
  for (const a of ads) {
    a.texts.primary.forEach((t, i) => {
      const where = `ad ${a.angle} primary text ${i + 1}`;
      const head = String(t ?? '').slice(0, AD_LIMITS.primary.visible).toLowerCase();
      const missing: string[] = [];
      if (!/\b(?:landlords?|homeowners?)\b/.test(head)) missing.push('who it is for');
      if (!namesWhere(head)) missing.push(coverage?.mode === 'uk' ? 'the UK' : 'the area');
      if (!/\bfree\b/.test(head)) missing.push('"free"');
      if (!/\breport\b/.test(head)) missing.push('"report"');
      if (missing.length > 0) fail('ld_offer', 'offer_late', where, `The first lines do not say ${missing.join(', ')}.`);
      if (firstSentence(String(t ?? '')).includes('?')) fail('ld_offer', 'question_first', where, 'It opens with a question. Say the offer first.');
      if (!/\byou stay the owner\b/i.test(String(t ?? ''))) fail('ld_offer', 'owner_missing', where, 'It does not say you stay the owner.');
    });
    const frameOne = String(a.screenLines[0] ?? '').toLowerCase();
    if (!/\bfree\b/.test(frameOne) || !/\breport\b/.test(frameOne) || !namesWhere(frameOne)) fail('ld_offer', 'frame_one', `ad ${a.angle} frame one`, 'Frame one must name the area and the free report.');
    const last = a.screenLines[a.screenLines.length - 1];
    if (norm(last ?? '') !== CTA_NORM) fail('ld_offer', 'cta_last', `ad ${a.angle} last frame`, `The last frame must say "${CTA_LINE}".`);
    if (a.script && a.script.length > 0) {
      const s0 = a.script[0].toLowerCase();
      if (!/\bfree\b/.test(s0) || !/\breport\b/.test(s0)) fail('ld_offer', 'voice_first', `ad ${a.angle} voiceover`, 'The first spoken line must say the free report.');
      if (norm(a.script[a.script.length - 1]) !== CTA_NORM) fail('ld_offer', 'voice_last', `ad ${a.angle} voiceover`, `The last spoken line must be "${CTA_LINE}".`);
    }
  }

  // Picture.
  if (input.pictures === true) out.push(...ldPictureFailures(ads));
  return out;
}

/** The picture check on its own (the render step runs it once every ad has its first frame). */
export function ldPictureFailures(ads: readonly Pick<LdGateAd, 'angle' | 'picture'>[]): LdFailure[] {
  const out: LdFailure[] = [];
  for (const a of ads) if (!a.picture) out.push({ check: 'ld_picture', rule: 'picture_missing', where: `ad ${a.angle}`, detail: 'The first frame of this ad could not be measured.' });
  for (let i = 0; i < ads.length; i++) {
    for (let j = i + 1; j < ads.length; j++) {
      const a = ads[i];
      const b = ads[j];
      if (!a.picture || !b.picture) continue;
      const m = picturesTooSimilar(a.picture, b.picture);
      if (m.tooSimilar)
        out.push({
          check: 'ld_picture',
          rule: 'picture_similar',
          where: `ads ${a.angle} and ${b.angle}`,
          detail: `These two ads start too much alike (colour ${Math.round(m.overlap)}, layout ${Math.round(m.correlation)}; each must be under ${PICTURE_MAX_OVERLAP} and ${PICTURE_MAX_CORRELATION}).`,
        });
    }
  }
  return out;
}
