/**
 * Batch 31: a brand colour from a logo. The setup flow decodes the uploaded
 * logo to RGBA pixels (canvas or an image library; not this file's job) and
 * hands them here. We bucket the pixels that carry colour and return the
 * dominant one, ignoring what a logo's background and outline are made of:
 * transparent, near-white, near-black and grey pixels.
 *
 * Contrast is funnels/brand.ts `readableOn` (reused, not copied): black or
 * white text, whichever is readable on the colour.
 *
 * Pure: no network, no database, no server-only, no image decoding.
 */
import { parseHexColour, readableOn } from '../funnels/brand.ts';

/** Anything RGBA-shaped: Uint8ClampedArray, Uint8Array, number[]. */
export type RgbaPixels = ArrayLike<number>;

export interface QuantiseOptions {
  /** Pixels below this alpha (0-255) count as transparent. Default 128. */
  minAlpha?: number;
  /** Every channel at or above this is near-white. Default 235. */
  whiteFloor?: number;
  /** Every channel at or below this is near-black. Default 30. */
  blackCeiling?: number;
  /** max(r,g,b) - min(r,g,b) below this is grey. Default 28. */
  minChroma?: number;
  /** At most this many pixels are looked at (evenly spaced). Default 50 000. */
  maxSamples?: number;
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/**
 * The dominant brand colour as #rrggbb, or null when the image has no usable
 * colour (empty, all transparent, all white/black/grey) or the arguments do not
 * describe the pixel array.
 */
export function dominantColour(pixels: RgbaPixels, width: number, height: number, opts: QuantiseOptions = {}): string | null {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (!pixels || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const total = w * h;
  if (pixels.length < total * 4) return null;

  const minAlpha = opts.minAlpha ?? 128;
  const whiteFloor = opts.whiteFloor ?? 235;
  const blackCeiling = opts.blackCeiling ?? 30;
  const minChroma = opts.minChroma ?? 28;
  const maxSamples = Math.max(1, opts.maxSamples ?? 50_000);
  const stride = Math.max(1, Math.floor(total / maxSamples));

  // 16 levels per channel: a gradient of one colour stays in one or two buckets.
  const count = new Map<number, number>();
  const sum = new Map<number, [number, number, number]>();
  let best = -1;
  let bestCount = 0;

  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    const a = pixels[i + 3];
    if (a < minAlpha) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (min >= whiteFloor) continue;
    if (max <= blackCeiling) continue;
    if (max - min < minChroma) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const n = (count.get(key) ?? 0) + 1;
    count.set(key, n);
    const s = sum.get(key) ?? [0, 0, 0];
    s[0] += r;
    s[1] += g;
    s[2] += b;
    sum.set(key, s);
    if (n > bestCount || (n === bestCount && key < best)) {
      best = key;
      bestCount = n;
    }
  }
  if (best < 0) return null;
  const s = sum.get(best)!;
  const colour = `#${hex2(s[0] / bestCount)}${hex2(s[1] / bestCount)}${hex2(s[2] / bestCount)}`;
  return parseHexColour(colour);
}

export interface BrandColour {
  /** #rrggbb. */
  primary: string;
  /** Text colour readable on `primary`: #111111 or #ffffff (brand.ts readableOn). */
  onPrimary: string;
}

/** A colour with the text colour to put on it. Null when `hex` is not a #rrggbb colour. */
export function brandColour(hex: unknown): BrandColour | null {
  const primary = parseHexColour(hex);
  return primary ? { primary, onPrimary: readableOn(primary) } : null;
}

/** The dominant colour of a logo's pixels, with its readable text colour; null when there is none. */
export function brandColourFromPixels(pixels: RgbaPixels, width: number, height: number, opts?: QuantiseOptions): BrandColour | null {
  return brandColour(dominantColour(pixels, width, height, opts));
}
