/**
 * Batch 38 phase 5: the image cards of an operator's ad pack (angles 3a and 17).
 *
 * Each card from renderCards (angles.ts) is drawn in the operator's own brand
 * with next/og's ImageResponse (Satori + Resvg), at the three Meta sizes:
 * 1:1 (1080x1080), 4:5 (1080x1350) and 9:16 (1080x1920).
 *
 * Look: a bold, solid brand colour. Every other colour is derived from the ONE
 * brand colour the operator set (deriveTints), text is white or near-black by
 * pickTextColour (checks.ts), headlines are Anton, everything else Archivo.
 * A figure card shows the big number and, in the same panel, the whole label
 * sentence at a legible size. A footer strip carries the logo and company name.
 *
 * Photo: the operator's own pack photos first, else the site photo
 * (SiteSettings.photoUrl), else type only. A photo is fetched as bytes BEFORE
 * rendering (fetchImage is a parameter, so tests need no network), sits under
 * a brand-coloured overlay, and any failure falls back to type only. The
 * figure card is always type only: a number on a photo is harder to read.
 *
 * Safe areas (Meta covers these with its own interface): nothing is drawn in
 * the top 14% and bottom 20% of 9:16, nor the bottom 10% of 4:5.
 *
 * Server only in practice (reads fonts from disk, runs Resvg), but it imports
 * nothing database-shaped, so a test can bundle and run it (images-test-support.ts).
 * Fonts are OFL (fonts/OFL.txt) and are listed in next.config.ts
 * outputFileTracingIncludes so they ship to the serverless function.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import type { Card } from './angles.ts';
import { contrastRatio, pickTextColour, TEXT_ON_DARK, TEXT_ON_LIGHT } from './checks.ts';

// ── Sizes and safe areas ──

export type CardSize = '1x1' | '4x5' | '9x16';
export const CARD_SIZES: readonly CardSize[] = ['1x1', '4x5', '9x16'];

export const SIZE_PX: Record<CardSize, { width: number; height: number }> = {
  '1x1': { width: 1080, height: 1080 },
  '4x5': { width: 1080, height: 1350 },
  '9x16': { width: 1080, height: 1920 },
};

export type Layout = {
  width: number;
  height: number;
  /** Left and right margin. */
  padX: number;
  /** Nothing is drawn above this many px from the top. */
  insetTop: number;
  /** Nothing is drawn below this many px from the bottom (height - insetBottom is the last text line). */
  insetBottom: number;
  /** Height of the box all text sits in. */
  boxWidth: number;
  boxHeight: number;
  headlineMax: number;
  headlineMin: number;
  bodyMax: number;
  bodyMin: number;
  bigMax: number;
  ctaSize: number;
  footerHeight: number;
};

/** Smallest type on any card. A label or body line is never drawn under this. */
export const MIN_BODY_PX = 34;
export const MIN_LABEL_PX = 34;

/**
 * Where text may go at each size. 9:16: top 14% (270px) and bottom 20% (384px)
 * are left clear. 4:5: bottom 10% (135px). 1:1 has no overlay, so a plain margin.
 */
export function layoutFor(size: CardSize): Layout {
  const { width, height } = SIZE_PX[size];
  const padX = 80;
  const insetTop = size === '9x16' ? Math.ceil(height * 0.14) : 80;
  const insetBottom = size === '9x16' ? Math.ceil(height * 0.2) : size === '4x5' ? Math.ceil(height * 0.1) : 80;
  const boxHeight = height - insetTop - insetBottom;
  return {
    width,
    height,
    padX,
    insetTop,
    insetBottom,
    boxWidth: width - padX * 2,
    boxHeight,
    headlineMax: size === '1x1' ? 124 : size === '4x5' ? 138 : 150,
    headlineMin: 56,
    bodyMax: size === '1x1' ? 42 : 46,
    bodyMin: MIN_BODY_PX,
    bigMax: size === '1x1' ? 190 : 230,
    ctaSize: 42,
    footerHeight: 112,
  };
}

// ── Colour ──

export const DEFAULT_BRAND_COLOUR = '#1F3A5F';

export type Tints = {
  /** The operator's colour, normalised to #rrggbb. */
  base: string;
  /** 30% towards black. */
  dark: string;
  /** 60% towards black. */
  deep: string;
  /** 25% towards white. */
  mid: string;
  /** 90% towards white: a near-white with the brand's hue. */
  light: string;
};

function parseHex(hex: string): [number, number, number] | null {
  const s = String(hex ?? '').trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function mix(rgb: [number, number, number], target: number, amount: number): [number, number, number] {
  return [rgb[0] + (target - rgb[0]) * amount, rgb[1] + (target - rgb[1]) * amount, rgb[2] + (target - rgb[2]) * amount];
}

/** #rrggbb as rgba(...), for the overlay and the soft panels. */
export function rgba(hex: string, alpha: number): string {
  const rgb = parseHex(hex) ?? parseHex(DEFAULT_BRAND_COLOUR)!;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/** Every tint of a card comes from the one brand colour. Pure; a colour that is not hex reads as the default. */
export function deriveTints(hex: string | null | undefined): Tints {
  const rgb = parseHex(hex ?? '') ?? parseHex(DEFAULT_BRAND_COLOUR)!;
  return {
    base: toHex(rgb),
    dark: toHex(mix(rgb, 0, 0.3)),
    deep: toHex(mix(rgb, 0, 0.6)),
    mid: toHex(mix(rgb, 255, 0.25)),
    light: toHex(mix(rgb, 255, 0.9)),
  };
}

export type Palette = {
  tints: Tints;
  /** The colour behind the type (the brand colour, or its dark tint under a photo with white type). */
  surface: string;
  /** Type colour on the surface: white or near-black. */
  text: string;
  /** The footer strip. */
  strip: string;
  /** The CTA pill and accent bar. */
  accent: string;
  /** Type on the figure panel. */
  panelText: string;
  panelNumber: string;
};

export function paletteFor(brandColour: string | null | undefined): Palette {
  const tints = deriveTints(brandColour);
  const text = pickTextColour(tints.base);
  const light = text === TEXT_ON_DARK;
  const accent = text;
  const panelNumber = (contrastRatio(tints.deep, tints.light) ?? 0) >= 7 ? tints.deep : TEXT_ON_LIGHT;
  return {
    tints,
    surface: tints.base,
    text,
    strip: rgba(light ? tints.deep : TEXT_ON_LIGHT, light ? 0.55 : 0.12),
    accent,
    panelText: TEXT_ON_LIGHT,
    panelNumber,
  };
}

// ── Text fitting (pure estimates; Satori does the real wrapping) ──

/** Average advance as a share of the font size. Conservative, so a line is never wider than the estimate. */
export const ADVANCE = { anton: 0.46, archivo: 0.52 } as const;

/** The estimated lines of text at a size, wrapping on spaces. */
export function wrapEstimate(text: string, fontSize: number, boxWidth: number, advance: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean);
  const maxChars = Math.max(1, Math.floor(boxWidth / (fontSize * advance)));
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line === '' ? w : `${line} ${w}`;
    if (next.length <= maxChars || line === '') {
      line = next;
      // A single word longer than a line breaks mid-word in Satori: count the extra lines.
      while (line.length > maxChars) {
        lines.push(line.slice(0, maxChars));
        line = line.slice(maxChars);
      }
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

export type Fit = { fontSize: number; lines: number; height: number; fits: boolean };

/** The largest size in [min, max] (steps of 2px) whose wrapped height fits maxHeight; min with fits=false when none does. */
export function fitText(opts: {
  text: string;
  boxWidth: number;
  maxHeight: number;
  max: number;
  min: number;
  lineHeight: number;
  advance: number;
}): Fit {
  const { text, boxWidth, maxHeight, max, min, lineHeight, advance } = opts;
  if (String(text).trim() === '') return { fontSize: min, lines: 0, height: 0, fits: true };
  for (let size = max; size >= min; size -= 2) {
    const lines = wrapEstimate(text, size, boxWidth, advance).length;
    const height = Math.ceil(lines * size * lineHeight);
    if (height <= maxHeight) return { fontSize: size, lines, height, fits: true };
  }
  const lines = wrapEstimate(text, min, boxWidth, advance).length;
  return { fontSize: min, lines, height: Math.ceil(lines * min * lineHeight), fits: false };
}

const HEADLINE_LH = 1.04;
const BODY_LH = 1.3;
const GAP = 28;
const PANEL_PAD = 40;

export type CardPlan = {
  headline: Fit;
  body: Fit[];
  /** Figure card: the number size and the label's size and lines. */
  big: { fontSize: number; unitSize: number } | null;
  label: Fit | null;
  company: { fontSize: number; lines: number };
  /** True when every text fits the box at no less than the minimum sizes. */
  fits: boolean;
};

/** Text that goes on the card: stripped of emoji and control characters (Satori would fetch emoji over the network). */
export function cleanText(s: string): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\p{Extended_Pictographic}‍️\u{1f1e6}-\u{1f1ff}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const COMPANY_MAX = 80;
export function cleanCompany(s: string): string {
  const t = cleanText(s);
  return t.length > COMPANY_MAX ? t.slice(0, COMPANY_MAX - 1).trimEnd() + '…' : t;
}

/** Footer: the company name's size, in at most two lines beside the logo. */
export function companyFit(company: string, boxWidth: number, hasLogo: boolean, logoWidth = 0): { fontSize: number; lines: number } {
  const room = boxWidth - 48 - (hasLogo ? logoWidth + 24 : 0);
  const f = fitText({ text: company, boxWidth: room, maxHeight: 84, max: 44, min: 30, lineHeight: 1.1, advance: ADVANCE.archivo });
  return { fontSize: f.fontSize, lines: f.lines };
}

/**
 * The size of every text on a card, and whether it all fits inside the safe
 * box. Pure: the renderer uses these sizes and tests use `fits`.
 */
export function planCard(card: Card, company: string, size: CardSize, hasLogo = true, logoWidth = 80): CardPlan {
  const L = layoutFor(size);
  const isFigure = card.figure && card.big !== null && card.label !== null;
  const co = companyFit(company, L.boxWidth, hasLogo, logoWidth);
  const footer = L.footerHeight;
  const cta = Math.ceil(L.ctaSize * 1.1) + 56; // text plus the pill's padding
  // Room for headline, body (or figure panel) between the top of the box and the CTA.
  const avail = L.boxHeight - footer - cta - GAP * 2 - 20 /* accent bar */ - GAP;

  const bodyLines = isFigure ? card.body.filter((l) => l !== card.label) : card.body;
  if (isFigure) {
    const bigText = bigParts(card.big ?? '');
    const headline = fitText({ text: card.headline.toUpperCase(), boxWidth: L.boxWidth, maxHeight: 140, max: 64, min: MIN_BODY_PX, lineHeight: HEADLINE_LH, advance: ADVANCE.anton });
    // Shrink the number, the label and the body together until the whole card fits; the label never goes under MIN_LABEL_PX.
    let last: CardPlan | null = null;
    for (const scale of [1, 0.92, 0.85, 0.78, 0.72, 0.66, 0.6]) {
      const bigFit = fitText({ text: bigText.amount, boxWidth: L.boxWidth - PANEL_PAD * 2, maxHeight: L.bigMax * 1.1, max: Math.round(L.bigMax * scale), min: 96, lineHeight: 1.1, advance: ADVANCE.anton });
      const label = fitText({ text: card.label ?? '', boxWidth: L.boxWidth - PANEL_PAD * 2, maxHeight: 400, max: Math.max(MIN_LABEL_PX, Math.round(44 * scale)), min: MIN_LABEL_PX, lineHeight: BODY_LH, advance: ADVANCE.archivo });
      const body = bodyLines.map((l) => fitText({ text: l, boxWidth: L.boxWidth, maxHeight: 200, max: Math.max(L.bodyMin, Math.round(L.bodyMax * scale)), min: L.bodyMin, lineHeight: BODY_LH, advance: ADVANCE.archivo }));
      const panel = bigFit.height + 24 + label.height + PANEL_PAD * 2;
      const used = headline.height + GAP + 12 + panel + body.reduce((n, b) => n + GAP + b.height, 0);
      last = {
        headline,
        body,
        big: { fontSize: bigFit.fontSize, unitSize: Math.max(40, Math.round(bigFit.fontSize * 0.28)) },
        label,
        company: co,
        fits: headline.fits && label.fits && bigFit.fits && body.every((b) => b.fits) && used <= avail,
      };
      if (last.fits) break;
    }
    return last as CardPlan;
  }

  // Share of the room: the headline gets what it can use, the body the rest.
  const bodyEach = bodyLines.map((l) => fitText({ text: l, boxWidth: L.boxWidth, maxHeight: 400, max: L.bodyMax, min: L.bodyMin, lineHeight: BODY_LH, advance: ADVANCE.archivo }));
  const bodyH = bodyEach.reduce((n, b) => n + b.height + 14, 0);
  const headline = fitText({
    text: card.headline.toUpperCase(),
    boxWidth: L.boxWidth,
    maxHeight: Math.max(180, avail - bodyH - GAP),
    max: L.headlineMax,
    min: L.headlineMin,
    lineHeight: HEADLINE_LH,
    advance: ADVANCE.anton,
  });
  const used = headline.height + GAP + bodyH;
  return { headline, body: bodyEach, big: null, label: null, company: co, fits: headline.fits && bodyEach.every((b) => b.fits) && used <= avail };
}

/** "£2,350 a month" into the number and the unit, so the number can be huge and the unit small. */
export function bigParts(big: string): { amount: string; unit: string } {
  const t = cleanText(big);
  const m = /^(\S+)\s+(.+)$/.exec(t);
  return m ? { amount: m[1], unit: m[2] } : { amount: t, unit: '' };
}

// ── Fonts ──

/** Read at render time from disk (fonts/OFL.txt is their licence). Listed in next.config.ts outputFileTracingIncludes. */
export const FONT_DIR = path.join(process.cwd(), 'src', 'lib', 'ad-packs', 'fonts');

type FontSpec = { name: string; file: string; weight: 400 | 500 | 600; style: 'normal' };
const FONT_SPECS: readonly FontSpec[] = [
  { name: 'Anton', file: 'Anton-Regular.ttf', weight: 400, style: 'normal' },
  { name: 'Archivo', file: 'Archivo-Medium.ttf', weight: 500, style: 'normal' },
  { name: 'Archivo', file: 'Archivo-SemiBold.ttf', weight: 600, style: 'normal' },
];

type LoadedFont = { name: string; data: ArrayBuffer; weight: 400 | 500 | 600; style: 'normal' };
let fontCache: Promise<LoadedFont[]> | null = null;

export function loadFonts(): Promise<LoadedFont[]> {
  if (!fontCache) {
    fontCache = Promise.all(
      FONT_SPECS.map(async (f) => {
        const buf = await readFile(path.join(FONT_DIR, f.file));
        const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        return { name: f.name, data, weight: f.weight, style: f.style };
      }),
    ).catch((e) => {
      fontCache = null; // a missing file must not poison later calls
      throw e;
    });
  }
  return fontCache;
}

// ── Images ──

export type FetchedImage = { bytes: Uint8Array; contentType?: string | null };
/** Fetches an image as bytes. Throws on any failure. Injected, so tests need no network. */
export type FetchImage = (url: string) => Promise<FetchedImage>;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

/** Only public https URLs are fetched: an operator's photo or logo is never a way to reach an internal address. */
export function isFetchableImageUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  if (host.includes(':')) return false;
  return true;
}

export const defaultFetchImage: FetchImage = async (url) => {
  if (!isFetchableImageUrl(url)) throw new Error('image url not allowed');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_IMAGE_BYTES) throw new Error('image too large');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('image too large');
  return { bytes, contentType: res.headers.get('content-type') };
};

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'svg';

/** The kind of image from its first bytes (the content type of a CDN is not trusted). WebP and anything else is not drawn. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

/** Pixel size of a PNG, JPEG or GIF, or of an SVG's width/height or viewBox; null when unknown. */
export function imageSize(bytes: Uint8Array, kind: ImageKind): { width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (kind === 'png') return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
    if (kind === 'gif') return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : null;
    if (kind === 'jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = b[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
          i += marker === 0xff ? 1 : 2;
          continue;
        }
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
    const text = b.subarray(0, 2048).toString('utf8');
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(text);
    if (vb) return { width: Number(vb[1]), height: Number(vb[2]) };
    const w = /<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i.exec(text);
    const h = /<svg[^>]*\sheight\s*=\s*["']([\d.]+)/i.exec(text);
    if (w && h) return { width: Number(w[1]), height: Number(h[1]) };
  } catch {
    return null;
  }
  return null;
}

export type ResolvedImage = { dataUri: string; width: number; height: number };

/** Fetch one image and turn it into a data URI Satori can draw; null on any failure (the card then falls back). */
export async function resolveImage(url: string | null | undefined, fetchImage: FetchImage): Promise<ResolvedImage | null> {
  const u = typeof url === 'string' ? url.trim() : '';
  if (u === '') return null;
  try {
    const got = await fetchImage(u);
    const bytes = got?.bytes;
    if (!bytes || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    const kind = sniffImage(bytes);
    if (!kind) return null;
    const size = imageSize(bytes, kind);
    if (kind !== 'svg' && (!size || size.width < 1 || size.height < 1)) return null;
    const mime = kind === 'svg' ? 'image/svg+xml' : kind === 'jpeg' ? 'image/jpeg' : kind === 'gif' ? 'image/gif' : 'image/png';
    return {
      dataUri: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
      width: size?.width ?? 1,
      height: size?.height ?? 1,
    };
  } catch {
    return null;
  }
}

// ── The card ──

export type AdBrand = { company: string; brandColour: string | null; logoUrl: string | null };

type DrawInput = {
  card: Card;
  company: string;
  palette: Palette;
  size: CardSize;
  photo: ResolvedImage | null;
  logo: ResolvedImage | null;
};

const LOGO_H = 72;

function logoBox(logo: ResolvedImage | null): { width: number; height: number } | null {
  if (!logo) return null;
  const aspect = logo.width / logo.height;
  const width = Math.round(Math.max(LOGO_H * 0.6, Math.min(LOGO_H * 3.2, LOGO_H * (Number.isFinite(aspect) && aspect > 0 ? aspect : 1))));
  return { width, height: LOGO_H };
}

function CardView({ card, company, palette, size, photo, logo }: DrawInput) {
  const L = layoutFor(size);
  const box = logoBox(logo);
  const plan = planCard(card, company, size, box !== null, box ? box.width + 24 : 0);
  const isFigure = plan.big !== null && plan.label !== null;
  const { text, accent } = palette;
  const onAccent = accent === TEXT_ON_DARK ? palette.tints.deep : palette.tints.base;
  const parts = bigParts(card.big ?? '');
  const bodyLines = isFigure ? card.body.filter((l) => l !== card.label) : card.body;

  // Under a photo the surface is the brand colour, darkened when the type is white.
  const overlay = text === TEXT_ON_DARK ? palette.tints.dark : palette.tints.base;

  return (
    <div style={{ width: L.width, height: L.height, display: 'flex', position: 'relative', backgroundColor: palette.surface, fontFamily: 'Archivo', color: text }}>
      {photo ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="" src={photo.dataUri} width={L.width} height={L.height} style={{ position: 'absolute', top: 0, left: 0, width: L.width, height: L.height, objectFit: 'cover' }} />
          <div style={{ position: 'absolute', top: 0, left: 0, width: L.width, height: L.height, backgroundColor: rgba(overlay, 0.84) }} />
        </>
      ) : null}

      <div
        style={{
          position: 'absolute',
          top: L.insetTop,
          left: L.padX,
          width: L.boxWidth,
          height: L.boxHeight,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        {/* Main block: grows, and centres its content between the top of the box and the CTA. */}
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center', paddingBottom: GAP }}>
          <div style={{ display: 'flex', width: 120, height: 12, borderRadius: 6, backgroundColor: accent, opacity: 0.9, marginBottom: GAP }} />
          <div
            style={{
              display: 'flex',
              fontFamily: 'Anton',
              fontWeight: 400,
              fontSize: plan.headline.fontSize,
              lineHeight: HEADLINE_LH,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: text,
            }}
          >
            {card.headline}
          </div>

          {isFigure ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                marginTop: GAP + 12,
                padding: PANEL_PAD,
                borderRadius: 32,
                backgroundColor: palette.tints.light,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', fontFamily: 'Anton', fontSize: plan.big?.fontSize, lineHeight: 1.1, color: palette.panelNumber }}>{parts.amount}</div>
                {parts.unit ? (
                  <div style={{ display: 'flex', fontWeight: 600, fontSize: plan.big?.unitSize, marginLeft: 20, color: palette.panelText }}>{parts.unit}</div>
                ) : null}
              </div>
              <div style={{ display: 'flex', marginTop: 24, fontWeight: 500, fontSize: plan.label?.fontSize, lineHeight: BODY_LH, color: palette.panelText }}>{card.label}</div>
            </div>
          ) : null}

          {bodyLines.map((line, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                marginTop: i === 0 ? GAP : 14,
                fontWeight: 500,
                fontSize: plan.body[i]?.fontSize ?? L.bodyMin,
                lineHeight: BODY_LH,
                color: text,
              }}
            >
              {line}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex' }}>
            <div
              style={{
                display: 'flex',
                padding: '14px 36px',
                borderRadius: 999,
                backgroundColor: accent,
                color: onAccent,
                fontWeight: 600,
                fontSize: L.ctaSize,
                lineHeight: 1.1,
              }}
            >
              {card.cta}
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              marginTop: GAP,
              height: L.footerHeight,
              padding: '0 24px',
              borderRadius: 24,
              backgroundColor: palette.strip,
            }}
          >
            {logo && box ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8, marginRight: 24, borderRadius: 14, backgroundColor: '#ffffff' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="" src={logo.dataUri} width={box.width} height={box.height} style={{ width: box.width, height: box.height, objectFit: 'contain' }} />
              </div>
            ) : null}
            <div style={{ display: 'flex', flexGrow: 1, fontWeight: 600, fontSize: plan.company.fontSize, lineHeight: 1.1, color: text }}>{company}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Rendering ──

async function toPng(element: React.ReactElement, size: CardSize): Promise<Buffer> {
  const { width, height } = SIZE_PX[size];
  const fonts = await loadFonts();
  // emoji:'twemoji' is the default and would fetch over the network; text is cleaned of emoji, and this pins it.
  const res = new ImageResponse(element, { width, height, fonts, emoji: 'twemoji' });
  return Buffer.from(await res.arrayBuffer());
}

function cleanCard(card: Card): Card {
  return {
    ...card,
    headline: cleanText(card.headline),
    body: card.body.map(cleanText).filter((l) => l !== ''),
    cta: cleanText(card.cta),
    big: card.big === null ? null : cleanText(card.big),
    label: card.label === null ? null : cleanText(card.label),
  };
}

/** A card with its photo and logo already resolved. A render error with images retries type only, so a bad file never loses the card. */
export async function renderCardResolved(args: {
  card: Card;
  company: string;
  brandColour: string | null;
  size: CardSize;
  photo: ResolvedImage | null;
  logo: ResolvedImage | null;
}): Promise<Buffer> {
  const card = cleanCard(args.card);
  const company = cleanCompany(args.company);
  const palette = paletteFor(args.brandColour);
  const draw = (photo: ResolvedImage | null, logo: ResolvedImage | null) =>
    toPng(<CardView card={card} company={company} palette={palette} size={args.size} photo={photo} logo={logo} />, args.size);
  // The figure card never sits on a photo.
  const photo = card.figure ? null : args.photo;
  try {
    return await draw(photo, args.logo);
  } catch (e) {
    if (!photo && !args.logo) throw e;
    return draw(null, null);
  }
}

/**
 * One card at one size, as PNG bytes. `photoUrl` and `brand.logoUrl` are
 * fetched with `fetchImage` first; a failed fetch means type only (and, for
 * the logo, the name alone).
 */
export async function renderCardPng(args: {
  card: Card;
  brand: AdBrand;
  photoUrl: string | null;
  size: CardSize;
  fetchImage?: FetchImage;
}): Promise<Buffer> {
  const fetchImage = args.fetchImage ?? defaultFetchImage;
  const [photo, logo] = await Promise.all([
    args.card.figure ? Promise.resolve(null) : resolveImage(args.photoUrl, fetchImage),
    resolveImage(args.brand.logoUrl, fetchImage),
  ]);
  return renderCardResolved({ card: args.card, company: args.brand.company, brandColour: args.brand.brandColour, size: args.size, photo, logo });
}

export type AdImage = { name: string; width: number; height: number; png: Buffer };

export type AdPhotos = {
  /** The operator's own photos from the pack, in order. */
  pack: readonly string[];
  /** The website's photo (SiteSettings.photoUrl), used when the pack has none. */
  site: string | null;
};

/** The photo URLs a card at this position may use, best first: the pack photo that is its turn, the others, then the site photo. */
export function photoCandidates(photos: AdPhotos, index: number): string[] {
  const pack = photos.pack.map((p) => String(p ?? '').trim()).filter((p) => p !== '');
  const out: string[] = [];
  for (let k = 0; k < pack.length; k++) out.push(pack[(index + k) % pack.length]);
  const site = (photos.site ?? '').trim();
  if (site !== '' && !out.includes(site)) out.push(site);
  return out;
}

/** The file name of one card at one size: 3a-card1-4x5.png. */
export function imageName(angle: string, cardNumber: number, size: CardSize): string {
  return `${angle}-card${cardNumber}-${size}.png`;
}

/**
 * Every card at all three sizes. Each distinct photo and the logo are fetched
 * once. A card takes the first of its candidate photos that fetched and
 * decoded, else it is type only. Cards render one after another (Resvg is the
 * heavy part; a pack is 5 cards x 3 sizes per angle).
 */
export async function renderAdImages(args: {
  angle: string;
  cards: readonly Card[];
  brand: AdBrand;
  photos: AdPhotos;
  fetchImage?: FetchImage;
  sizes?: readonly CardSize[];
}): Promise<AdImage[]> {
  const fetchImage = args.fetchImage ?? defaultFetchImage;
  const sizes = args.sizes ?? CARD_SIZES;
  const cache = new Map<string, Promise<ResolvedImage | null>>();
  const once = (url: string): Promise<ResolvedImage | null> => {
    let p = cache.get(url);
    if (!p) {
      p = resolveImage(url, fetchImage);
      cache.set(url, p);
    }
    return p;
  };
  const logo = args.brand.logoUrl ? await once(args.brand.logoUrl) : null;
  const out: AdImage[] = [];
  for (let i = 0; i < args.cards.length; i++) {
    const card = args.cards[i];
    let photo: ResolvedImage | null = null;
    if (!card.figure) {
      for (const url of photoCandidates(args.photos, i)) {
        photo = await once(url);
        if (photo) break;
      }
    }
    for (const size of sizes) {
      const png = await renderCardResolved({ card, company: args.brand.company, brandColour: args.brand.brandColour, size, photo, logo });
      out.push({ name: imageName(args.angle, i + 1, size), width: SIZE_PX[size].width, height: SIZE_PX[size].height, png });
    }
  }
  return out;
}
