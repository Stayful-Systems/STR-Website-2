/**
 * Batch 55 step 5 (Phase 1, 55c A1): copying the customer's logo from the short-lived link the lead database pushes.
 *
 * The link is fetched ONCE, server side, with a time limit and a size cap, and the bytes must really be a PNG or a
 * JPEG (the same magic-byte sniff as a logo upload, funnels/image.ts). Anything else is a code, and the calculator
 * keeps the company name only. The link itself is never stored, returned or logged.
 *
 * No server-only and no database: `fetch` is injected (the global one by default), so it runs under `node --test`.
 */
import { createHash } from 'node:crypto';
import { LOGO_MAX_BYTES } from '../funnels/brand.ts';
import { sniffImage, type LogoMime } from '../funnels/image.ts';
import { safeLogoUrl } from './ad-profile.ts';

export const LOGO_FETCH_TIMEOUT_MS = 8_000;

export type LogoFetch =
  | { ok: true; bytes: Uint8Array; mime: LogoMime; sha256: string }
  | { ok: false; code: 'bad_url' | 'fetch_failed' | 'too_big' | 'not_image' };

export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'follow'; headers: Record<string, string> }) => Promise<Response>;

export async function fetchLogo(rawUrl: string, opts: { fetch?: FetchLike; timeoutMs?: number; maxBytes?: number } = {}): Promise<LogoFetch> {
  const url = safeLogoUrl(rawUrl);
  if (!url) return { ok: false, code: 'bad_url' };
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  const maxBytes = opts.maxBytes ?? LOGO_MAX_BYTES;

  let res: Response;
  try {
    res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? LOGO_FETCH_TIMEOUT_MS), redirect: 'follow', headers: { accept: 'image/png,image/jpeg' } });
  } catch {
    return { ok: false, code: 'fetch_failed' };
  }
  // A redirect may only land on another https address.
  if (!res.ok || (res.url && !res.url.startsWith('https://'))) return { ok: false, code: 'fetch_failed' };
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, code: 'too_big' };

  let bytes: Uint8Array;
  try {
    bytes = await readCapped(res, maxBytes);
  } catch (e) {
    return { ok: false, code: e instanceof TooBig ? 'too_big' : 'fetch_failed' };
  }
  if (bytes.byteLength === 0) return { ok: false, code: 'not_image' };
  const mime = sniffImage(bytes);
  if (!mime) return { ok: false, code: 'not_image' };
  return { ok: true, bytes, mime, sha256: createHash('sha256').update(bytes).digest('hex') };
}

class TooBig extends Error {}

/** The body, refusing more than `max` bytes as it arrives (a missing or lying content-length cannot make it read more). */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max) throw new TooBig();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
