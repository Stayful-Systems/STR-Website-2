/**
 * Batch 37: the static converter. It turns our own rendered pages (fetched from the
 * token-protected export page, /t/export/<token>/<path>) into plain files an operator
 * can put on any host.
 *
 *   buildStaticSite(input)        -> { "index.html": "...", "fees.html": "...", "assets/site.css": "...", ... }
 *   buildStaticSiteReport(input)  -> the same files plus `problems` (assets that were not supplied,
 *                                    links that did not resolve, a page with no form marker)
 *   listPageAssets(html)          -> the stylesheet and image addresses a rendered page asks for
 *   listCssAssets(css, base)      -> the font and image addresses a stylesheet asks for
 *
 * The caller (the transfer engine) fetches each page's HTML, then every stylesheet, image and
 * font those name, and hands the bytes over. This module never fetches anything.
 *
 * What the converter does to each page:
 *   - removes every <script>, <noscript>, <style> (its rules go into the shared stylesheet), comment,
 *     preload / modulepreload / prefetch link, <meta> that is not charset, viewport or description
 *     (so the "noindex" our preview carries does not follow the site to its new home), event
 *     handler attribute and Next.js trace (ids and data attributes);
 *   - joins every stylesheet into assets/site.css, fonts under assets/fonts/ and images under
 *     images/, with every url() rewritten; adds assets/form.css (hand written, below);
 *   - turns every internal link into a relative .html path (home is index.html);
 *   - swaps the form marker (<div data-transfer-form="...">, drawn by the export page) for a static
 *     form: no JavaScript, method post, to `formAction`;
 *   - keeps a canonical link only when the site has its own domain and the link is on it.
 *
 * An image or font that was not supplied is dropped (the <img> goes, the url() becomes an empty
 * data address) and reported; nothing points back at our servers except the form's action.
 *
 * Pure: no network, no database, no file system, no server-only. Relative .ts imports only.
 */
import type { PageModel } from './page-model.ts';

// ── The form's wire contract (the lead endpoint, /api/t/<ref>/lead, reads these names) ──

/** Field names of the static form, as the post body carries them. */
export const EXPORT_FORM_FIELDS = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  address: 'address',
  postcode: 'postcode',
  bedrooms: 'bedrooms',
  guests: 'guests',
  consent: 'consent',
  /** A field no person sees: a bot that fills it is quietly dropped. */
  honeypot: 'hp_company_site',
} as const;

/** The marker the export page draws where the form goes. */
export const FORM_MARKER_ATTR = 'data-transfer-form';

const FORM_ACTION = /^https?:\/\/[^\s/"'<>]+\/api\/t\/[A-Za-z0-9_-]{8,64}\/lead$/;

// ── Types ──

export interface StaticSiteInput {
  /** Every page of the site (buildSitePages). */
  pages: readonly PageModel[];
  /** The rendered HTML of each page, keyed by the page's path ("", "fees", "areas/york"). */
  htmlByPath: Readonly<Record<string, string>>;
  /** Every stylesheet the pages name: its address as the page wrote it and its text. */
  css: readonly { url: string; text: string }[];
  /** Fonts and images, keyed by the address the page or stylesheet wrote (absolute, or starting with "/"). */
  assets: Readonly<Record<string, Uint8Array>>;
  /** The address the form posts to: https://<host>/api/t/<ref>/lead. */
  formAction: string;
  /** The operator's company name: a title and alt text where the page has none. */
  siteName: string;
  /** The site's own domain ("harbour.co.uk"), or null. A canonical link is kept only on it. */
  domain?: string | null;
}

export type StaticFiles = Record<string, string | Uint8Array>;

export type ProblemCode = 'missing_stylesheet' | 'missing_asset' | 'unsafe_asset' | 'unresolved_link' | 'missing_form' | 'extra_form' | 'no_head' | 'leak';

export interface StaticSiteProblem {
  code: ProblemCode;
  /** The page path it was found on ("" for home), when it was on a page. */
  page?: string;
  /** The address or link concerned. Never a body or a person's detail. */
  ref?: string;
}

export interface StaticSiteReport {
  files: StaticFiles;
  problems: StaticSiteProblem[];
}

// ── Small helpers ──

const decodeAttr = (v: string): string =>
  v
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const encodeAttr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const escapeHtml = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PLACEHOLDER_BASE = 'http://site.invalid/';

function toUrl(ref: string, base: string = PLACEHOLDER_BASE): URL | null {
  try {
    return new URL(ref, base);
  } catch {
    return null;
  }
}

/** The file a page is saved as: "" is index.html, "fees" is fees.html, "areas/york" is areas/york.html. */
export function pageFile(path: string): string {
  return path === '' ? 'index.html' : `${path}.html`;
}

/** The way back to the site's root from a page's file ("" for index.html, "../" for areas/york.html). */
function rootPrefix(path: string): string {
  return path === '' ? '' : '../'.repeat(path.split('/').length - 1);
}

/** A relative path from one file to another. */
function relativeFile(fromFile: string, toFile: string): string {
  const from = fromFile.split('/').slice(0, -1);
  const to = toFile.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return '../'.repeat(from.length - i) + to.slice(i).join('/');
}

// ── A small HTML tokenizer (the pages are machine written and well formed) ──

type Attr = [name: string, value: string | null];

type Token =
  | { k: 'text'; s: string }
  | { k: 'comment' }
  | { k: 'decl'; s: string }
  | { k: 'open'; name: string; attrs: Attr[]; self: boolean }
  | { k: 'close'; name: string };

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

const CLOSE_RE = /<\/([a-zA-Z][^\s>/]*)[^>]*>/y;
const OPEN_RE = /<([a-zA-Z][^\s>/]*)/y;
const ATTR_RE = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
const TAG_END_RE = /\s*(\/?)>/y;

function tokenize(html: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const text = (s: string) => {
    if (s) out.push({ k: 'text', s });
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      out.push({ k: 'comment' });
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      const stop = end < 0 ? html.length : end + 1;
      out.push({ k: 'decl', s: html.slice(lt, stop) });
      i = stop;
      continue;
    }
    CLOSE_RE.lastIndex = lt;
    const close = CLOSE_RE.exec(html);
    if (close) {
      out.push({ k: 'close', name: close[1].toLowerCase() });
      i = CLOSE_RE.lastIndex;
      continue;
    }
    OPEN_RE.lastIndex = lt;
    const open = OPEN_RE.exec(html);
    if (!open) {
      text('<');
      i = lt + 1;
      continue;
    }
    let pos = OPEN_RE.lastIndex;
    const attrs: Attr[] = [];
    for (;;) {
      TAG_END_RE.lastIndex = pos;
      const end = TAG_END_RE.exec(html);
      if (end && end.index === pos) {
        pos = TAG_END_RE.lastIndex;
        const name = open[1].toLowerCase();
        out.push({ k: 'open', name, attrs, self: end[1] === '/' });
        i = pos;
        if (RAW.has(name) && end[1] !== '/') {
          const closer = new RegExp(`</${name}\\s*>`, 'ig');
          closer.lastIndex = i;
          const found = closer.exec(html);
          const bodyEnd = found ? found.index : html.length;
          text(html.slice(i, bodyEnd));
          i = bodyEnd;
        }
        break;
      }
      ATTR_RE.lastIndex = pos;
      const a = ATTR_RE.exec(html);
      if (!a || a.index !== pos || ATTR_RE.lastIndex === pos) {
        // Not a tag after all: the "<" is text.
        text('<');
        i = lt + 1;
        break;
      }
      attrs.push([a[1], a[2] ?? a[3] ?? a[4] ?? null]);
      pos = ATTR_RE.lastIndex;
    }
  }
  return out;
}

const attrOf = (attrs: readonly Attr[], name: string): string | null => {
  const hit = attrs.find(([n]) => n.toLowerCase() === name);
  return hit ? (hit[1] === null ? '' : decodeAttr(hit[1])) : null;
};

function serialise(name: string, attrs: readonly Attr[], self: boolean): string {
  const parts = attrs.map(([n, v]) => (v === null ? n : `${n}="${v}"`));
  return `<${name}${parts.length ? ' ' + parts.join(' ') : ''}${self && !VOID.has(name) ? ' /' : ''}>`;
}

// ── What a rendered page asks for ──

/** The stylesheet and image addresses a rendered page names, in document order, without repeats. */
export function listPageAssets(html: string): { stylesheets: string[]; images: string[] } {
  const stylesheets: string[] = [];
  const images: string[] = [];
  const add = (list: string[], v: string | null) => {
    if (v && !v.startsWith('data:') && !list.includes(v)) list.push(v);
  };
  for (const t of tokenize(html)) {
    if (t.k !== 'open') continue;
    if (t.name === 'link') {
      const rel = (attrOf(t.attrs, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('stylesheet')) add(stylesheets, attrOf(t.attrs, 'href'));
      else if (rel.includes('icon')) add(images, attrOf(t.attrs, 'href'));
    } else if (t.name === 'img') add(images, attrOf(t.attrs, 'src'));
  }
  return { stylesheets, images };
}

const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;

/** The font and image addresses a stylesheet names, resolved against the stylesheet's own address. */
export function listCssAssets(css: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(CSS_URL_RE)) {
    const ref = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!ref || ref.startsWith('data:') || ref.startsWith('#')) continue;
    const u = toUrl(ref, toUrl(baseUrl)?.href ?? PLACEHOLDER_BASE);
    if (!u) continue;
    // Keep what the stylesheet's host is: a placeholder host means the caller's own origin.
    const resolved = u.host === 'site.invalid' ? u.pathname + u.search : u.href;
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

// ── Assets ──

const startsWith = (b: Uint8Array, ...bytes: number[]): boolean => bytes.every((x, i) => b[i] === x);

/** A file extension from the first bytes, or null when they are not a font or an image we know. */
function sniffExtension(b: Uint8Array): string | null {
  if (startsWith(b, 0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (startsWith(b, 0xff, 0xd8, 0xff)) return 'jpg';
  if (startsWith(b, 0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (startsWith(b, 0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (startsWith(b, 0x77, 0x4f, 0x46, 0x32)) return 'woff2';
  if (startsWith(b, 0x77, 0x4f, 0x46, 0x46)) return 'woff';
  if (startsWith(b, 0x4f, 0x54, 0x54, 0x4f)) return 'otf';
  if (startsWith(b, 0x00, 0x01, 0x00, 0x00) && b.length > 12) return 'ttf';
  const head = Buffer.from(b.subarray(0, 256)).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

const FONT_EXT = new Set(['woff2', 'woff', 'ttf', 'otf', 'eot']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico']);

const extOf = (name: string): string => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/** A file name that is safe on any host: letters, digits, dot, hyphen, underscore. */
function safeName(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // keep as is
  }
  const name = decoded.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(-80);
  return name;
}

interface Placed {
  /** Path in the file map. */
  file: string;
  kind: 'font' | 'image';
}

class AssetStore {
  private byHref = new Map<string, Uint8Array>();
  private byPathSearch = new Map<string, Uint8Array>();
  private byPath = new Map<string, Uint8Array>();
  private placed = new Map<string, Placed>();
  private taken = new Set<string>();
  readonly files: Record<string, Uint8Array> = {};

  constructor(assets: Readonly<Record<string, Uint8Array>>) {
    for (const [key, bytes] of Object.entries(assets)) {
      const u = toUrl(key);
      if (!u) continue;
      this.byHref.set(u.href, bytes);
      this.byPathSearch.set(u.pathname + u.search, bytes);
      this.byPath.set(u.pathname, bytes);
    }
  }

  /** The bytes for an address (resolved against `base`), or null. `id` is the resolved address. */
  find(ref: string, base: string): { id: string; bytes: Uint8Array } | null {
    const u = toUrl(ref, toUrl(base)?.href ?? PLACEHOLDER_BASE);
    if (!u) return null;
    const bytes = this.byHref.get(u.href) ?? this.byPathSearch.get(u.pathname + u.search) ?? this.byPath.get(u.pathname);
    return bytes ? { id: u.href, bytes } : null;
  }

  /** Put the file in the map (once per address) and say where it went. */
  place(id: string, bytes: Uint8Array, hint: 'font' | 'image'): Placed {
    const already = this.placed.get(id);
    if (already) return already;
    const u = toUrl(id);
    const base = safeName((u?.pathname ?? '').split('/').filter(Boolean).pop() ?? '');
    const sniffed = sniffExtension(bytes);
    let name = base;
    const ext = extOf(name);
    const knownExt = FONT_EXT.has(ext) || IMAGE_EXT.has(ext);
    if (!knownExt) name = `${name || (hint === 'font' ? 'font' : 'image')}.${sniffed ?? (hint === 'font' ? 'woff2' : 'img')}`;
    const kind: 'font' | 'image' = FONT_EXT.has(extOf(name)) ? 'font' : 'image';
    const dir = kind === 'font' ? 'assets/fonts' : 'images';
    let file = `${dir}/${name}`;
    for (let n = 2; this.taken.has(file); n++) {
      const dot = name.lastIndexOf('.');
      file = `${dir}/${dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`}`;
    }
    this.taken.add(file);
    this.files[file] = bytes;
    const out = { file, kind };
    this.placed.set(id, out);
    return out;
  }
}

/** An SVG that carries script is not shipped. */
const unsafeSvg = (bytes: Uint8Array): boolean => sniffExtension(bytes) === 'svg' && /<script|\son[a-z]+\s*=|javascript:/i.test(Buffer.from(bytes).toString('utf8'));

// ── CSS ──

function rewriteCss(text: string, baseUrl: string, store: AssetStore, problems: StaticSiteProblem[]): string {
  return text
    .replace(/\/\*#\s*sourceMappingURL=[\s\S]*?\*\//g, '')
    .replace(/@import[^;{]*;/gi, () => {
      problems.push({ code: 'missing_asset', ref: '@import' });
      return '';
    })
    .replace(CSS_URL_RE, (whole, a: string | undefined, b: string | undefined, c: string | undefined) => {
      const ref = (a ?? b ?? c ?? '').trim();
      if (!ref || ref.startsWith('data:') || ref.startsWith('#')) return whole;
      const hit = store.find(ref, baseUrl);
      if (!hit) {
        problems.push({ code: 'missing_asset', ref });
        return 'url("data:,")';
      }
      if (unsafeSvg(hit.bytes)) {
        problems.push({ code: 'unsafe_asset', ref });
        return 'url("data:,")';
      }
      const placed = store.place(hit.id, hit.bytes, FONT_EXT.has(extOf(ref.split(/[?#]/)[0])) ? 'font' : 'image');
      // The stylesheet is at assets/site.css: fonts are beside it, images one level up.
      return placed.kind === 'font' ? `url("fonts/${placed.file.slice('assets/fonts/'.length)}")` : `url("../${placed.file}")`;
    });
}

// ── The form ──

const BEDROOMS = Array.from({ length: 11 }, (_, i) => i);
const GUESTS = Array.from({ length: 16 }, (_, i) => i + 1);

/** The static form for a page: one step, every field, no JavaScript, posting to `action`. */
export function staticFormHtml(page: PageModel, action: string, privacyHref: string | null): string {
  const f = page.form;
  if (!f) return '';
  const company = page.site.companyName;
  const intro = company ? `Tell ${company} where to send it. It takes a minute.` : 'Tell us where to send it. It takes a minute.';
  const F = EXPORT_FORM_FIELDS;
  const text = (id: string, label: string, name: string, type: string, auto: string, max: number, extra = '') =>
    `<div class="tf-field"><label for="tf-${id}">${escapeHtml(label)}</label><input id="tf-${id}" name="${name}" type="${type}" autocomplete="${auto}" maxlength="${max}" required${extra}></div>`;
  const select = (id: string, label: string, name: string, options: string) =>
    `<div class="tf-field"><label for="tf-${id}">${escapeHtml(label)}</label><select id="tf-${id}" name="${name}" required><option value="">Choose</option>${options}</select></div>`;
  return [
    `<form class="tf-form" method="post" action="${encodeAttr(action)}" accept-charset="utf-8">`,
    `<h2 class="tf-heading">Get your free estimate</h2>`,
    `<p class="tf-intro">${escapeHtml(intro)}</p>`,
    text('name', 'Your name', F.name, 'text', 'name', 120),
    text('email', 'Email address', F.email, 'email', 'email', 254),
    text('phone', 'Phone number', F.phone, 'tel', 'tel', 40),
    text('address', 'Property address', F.address, 'text', 'street-address', 200),
    text('postcode', 'Postcode', F.postcode, 'text', 'postal-code', 10, ' minlength="3"'),
    select('bedrooms', 'Bedrooms', F.bedrooms, BEDROOMS.map((n) => `<option value="${n}">${n === 0 ? 'Studio' : n}</option>`).join('')),
    select('guests', 'Guests', F.guests, GUESTS.map((n) => `<option value="${n}">${n}</option>`).join('')),
    `<div class="tf-hp" aria-hidden="true"><label for="tf-hp">Leave this empty</label><input id="tf-hp" type="text" name="${F.honeypot}" tabindex="-1" autocomplete="off"></div>`,
    `<label class="tf-consent"><input type="checkbox" name="${F.consent}" value="yes" required><span>${escapeHtml(f.consentText)}</span></label>`,
    privacyHref ? `<p class="tf-privacy"><a href="${encodeAttr(privacyHref)}">Privacy &amp; Terms</a></p>` : '',
    `<button type="submit" class="tf-button">${escapeHtml(f.submitLabel)}</button>`,
    `</form>`,
  ].join('');
}

/** assets/form.css, written by hand. It reads the site's own colour variables and falls back to neutral ones. */
export const FORM_CSS = `/* The enquiry form. */
.tf-form { display: grid; gap: 1rem; max-width: 36rem; }
.tf-heading { margin: 0; font-size: 1.25rem; font-weight: 600; color: var(--foreground, #111827); }
.tf-intro { margin: 0; color: var(--muted-foreground, #475569); }
.tf-field { display: grid; gap: 0.25rem; }
.tf-field label { font-size: 0.875rem; font-weight: 500; color: var(--foreground, #111827); }
.tf-field input, .tf-field select { width: 100%; box-sizing: border-box; padding: 0.5rem 0.75rem; font: inherit; font-size: 0.875rem; color: var(--foreground, #111827); background: var(--background, #ffffff); border: 1px solid var(--input, #cbd5e1); border-radius: 0.5rem; }
.tf-field input:focus-visible, .tf-field select:focus-visible, .tf-button:focus-visible { outline: 2px solid var(--primary, #1e3a5f); outline-offset: 2px; }
.tf-consent { display: flex; gap: 0.5rem; align-items: flex-start; font-size: 0.875rem; color: var(--foreground, #111827); }
.tf-consent input { margin-top: 0.2rem; width: 1rem; height: 1rem; flex-shrink: 0; accent-color: var(--primary, #1e3a5f); }
.tf-privacy { margin: 0; font-size: 0.75rem; color: var(--muted-foreground, #475569); }
.tf-privacy a { color: inherit; text-decoration: underline; }
.tf-button { display: inline-flex; width: 100%; justify-content: center; padding: 0.75rem 1.25rem; font: inherit; font-size: 0.875rem; font-weight: 600; color: var(--primary-foreground, #ffffff); background: var(--primary, #1e3a5f); border: 0; border-radius: 0.5rem; cursor: pointer; }
.tf-button:hover { opacity: 0.9; }
.tf-hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
`;

// ── The converter ──

const KEEP_META = new Set(['viewport', 'description']);
const DROP_ATTR = /^(data-next|data-nextjs|data-precedence|data-href|data-nimg|data-n-|on[a-z]+$|nonce$|integrity$)/i;
const NEXT_ID = /^__next/i;

interface Shared {
  input: StaticSiteInput;
  hrefToPath: Map<string, string>;
  store: AssetStore;
  problems: StaticSiteProblem[];
  stylesheets: { url: string; base: string }[];
  seenSheets: Set<string>;
  inline: string[];
  logoUrl: string | null;
  domain: string | null;
}

function normaliseHref(p: string): string {
  const t = p.replace(/\/+$/, '');
  return t === '' ? '/' : t;
}

function linkTarget(raw: string, from: string, path: string, shared: Shared): string | null {
  const href = decodeAttr(raw).trim();
  if (!href) return null;
  if (href.startsWith('#')) return href;
  if (/^(mailto|tel):/i.test(href)) return href;
  if (/^javascript:/i.test(href)) return '';
  let pathname: string;
  let frag = '';
  const external = /^([a-z][a-z0-9+.-]*:)?\/\//i.test(href);
  if (external) {
    const u = toUrl(href.startsWith('//') ? `https:${href}` : href);
    if (!u) return href;
    if (!shared.domain || u.hostname.toLowerCase() !== shared.domain) return href;
    pathname = u.pathname;
    frag = u.hash.replace(/^#/, '');
  } else if (href.startsWith('/')) {
    const m = /^([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/.exec(href);
    pathname = m?.[1] ?? href;
    frag = m?.[2] ?? '';
  } else {
    return href;
  }
  const target = shared.hrefToPath.get(normaliseHref(pathname));
  if (target === undefined) {
    shared.problems.push({ code: 'unresolved_link', page: path, ref: pathname });
    return relativeFile(from, 'index.html');
  }
  if (target === path && frag) return `#${frag}`;
  return relativeFile(from, pageFile(target)) + (frag ? `#${frag}` : '');
}

function convertPage(page: PageModel, html: string, shared: Shared): string {
  const { path } = page;
  const from = pageFile(path);
  const up = rootPrefix(path);
  const privacy = shared.input.pages.find((p) => p.key === 'privacy');
  const privacyHref = privacy ? relativeFile(from, pageFile(privacy.path)) : null;
  const out: string[] = [];
  let skip = null as { name: string; depth: number } | null;
  let collectStyle = false;
  let sawTitle = false;
  let headDone = false;
  let formCount = 0;

  const headLinks = () =>
    `<link rel="stylesheet" href="${up}assets/site.css"><link rel="stylesheet" href="${up}assets/form.css">` +
    (sawTitle ? '' : `<title>${escapeHtml(page.title || shared.input.siteName)}</title>`);

  for (const t of tokenize(html)) {
    if (skip) {
      if (t.k === 'text' && collectStyle) {
        const css = t.s.trim();
        if (css && !shared.inline.includes(css)) shared.inline.push(css);
      } else if (t.k === 'open' && t.name === skip.name && !t.self && !VOID.has(t.name)) skip.depth++;
      else if (t.k === 'close' && t.name === skip.name && --skip.depth === 0) {
        skip = null;
        collectStyle = false;
      }
      continue;
    }
    if (t.k === 'comment') continue;
    if (t.k === 'decl') {
      out.push(/^<!doctype/i.test(t.s) ? '<!doctype html>' : '');
      continue;
    }
    if (t.k === 'text') {
      out.push(t.s);
      continue;
    }
    if (t.k === 'close') {
      if (t.name === 'head' && !headDone) {
        out.push(headLinks());
        headDone = true;
      }
      out.push(`</${t.name}>`);
      continue;
    }

    // An opening tag.
    const { name, attrs, self } = t;
    const startSkip = () => {
      if (!self && !VOID.has(name)) skip = { name, depth: 1 };
    };

    if (name === 'script' || name === 'noscript' || name === 'next-route-announcer') {
      startSkip();
      continue;
    }
    if (name === 'style') {
      collectStyle = true;
      startSkip();
      continue;
    }
    const id = attrOf(attrs, 'id') ?? '';
    if ((name === 'template' && /^[BP]:\d+$/.test(id)) || (attrOf(attrs, 'hidden') !== null && /^S:\d+$/.test(id))) {
      startSkip();
      continue;
    }
    if (attrs.some(([n]) => n.toLowerCase() === FORM_MARKER_ATTR)) {
      formCount++;
      if (formCount === 1 && page.form) out.push(staticFormHtml(page, shared.input.formAction, privacyHref));
      else shared.problems.push({ code: 'extra_form', page: path });
      startSkip();
      continue;
    }

    if (name === 'meta') {
      const metaName = (attrOf(attrs, 'name') ?? '').toLowerCase();
      if (attrOf(attrs, 'charset') !== null || KEEP_META.has(metaName)) out.push(serialise(name, clean(attrs).map(([n, v]) => [n.toLowerCase(), v] as Attr), false));
      continue;
    }

    if (name === 'link') {
      const rel = (attrOf(attrs, 'rel') ?? '').toLowerCase().split(/\s+/);
      const href = attrOf(attrs, 'href');
      if (rel.includes('stylesheet') && href) {
        const u = toUrl(href);
        const id2 = u ? u.pathname + u.search : href;
        if (!shared.seenSheets.has(id2)) {
          shared.seenSheets.add(id2);
          shared.stylesheets.push({ url: href, base: href });
        }
      } else if (rel.includes('canonical') && href && shared.domain) {
        const u = toUrl(href, 'https://invalid.invalid/');
        if (u && u.hostname.toLowerCase() === shared.domain) out.push(serialise(name, [['rel', 'canonical'], ['href', encodeAttr(href)]], false));
      } else if (rel.includes('icon') && href && shared.logoUrl && href === shared.logoUrl) {
        const hit = shared.store.find(href, PLACEHOLDER_BASE);
        if (hit && !unsafeSvg(hit.bytes)) {
          const placed = shared.store.place(hit.id, hit.bytes, 'image');
          out.push(serialise(name, [['rel', 'icon'], ['href', encodeAttr(up + placed.file)]], false));
        }
      }
      continue;
    }

    if (name === 'img') {
      const src = attrOf(attrs, 'src');
      if (!src || src.startsWith('data:')) {
        if (src) out.push(serialise(name, clean(attrs, ['srcset', 'sizes']), self));
        continue;
      }
      const hit = shared.store.find(src, PLACEHOLDER_BASE);
      if (!hit) {
        shared.problems.push({ code: 'missing_asset', page: path, ref: src });
        continue;
      }
      if (unsafeSvg(hit.bytes)) {
        shared.problems.push({ code: 'unsafe_asset', page: path, ref: src });
        continue;
      }
      const placed = shared.store.place(hit.id, hit.bytes, 'image');
      const next: Attr[] = clean(attrs, ['srcset', 'sizes']).map(([n, v]) => (n.toLowerCase() === 'src' ? ([n, encodeAttr(up + placed.file)] as Attr) : ([n, v] as Attr)));
      if (!next.some(([n]) => n.toLowerCase() === 'alt')) next.push(['alt', '']);
      out.push(serialise(name, next, self));
      continue;
    }

    if (name === 'title') sawTitle = true;

    if (name === 'a') {
      const next = clean(attrs).map(([n, v]) => {
        if (n.toLowerCase() !== 'href' || v === null) return [n, v] as Attr;
        const target = linkTarget(v, from, path, shared);
        return (target === null ? [n, v] : [n, encodeAttr(target)]) as Attr;
      });
      out.push(serialise(name, next, self));
      continue;
    }

    out.push(serialise(name, clean(attrs), self));
  }

  if (!headDone) {
    shared.problems.push({ code: 'no_head', page: path });
  }
  if (page.form && formCount === 0) shared.problems.push({ code: 'missing_form', page: path });
  return out.join('');
}

/** An element's attributes without Next.js traces, event handlers and the named extras. */
function clean(attrs: readonly Attr[], also: readonly string[] = []): Attr[] {
  return attrs.filter(([n, v]) => {
    const lower = n.toLowerCase();
    if (DROP_ATTR.test(lower) || also.includes(lower)) return false;
    if (lower === 'id' && v !== null && NEXT_ID.test(v)) return false;
    return true;
  });
}

/** The scan every output page gets: nothing here should ever be found. */
function scanLeaks(html: string, path: string, problems: StaticSiteProblem[]): void {
  if (/<script/i.test(html)) problems.push({ code: 'leak', page: path, ref: 'script' });
  if (/\/_next\/|__next|__NEXT/i.test(html)) problems.push({ code: 'leak', page: path, ref: 'next' });
}

/** The files of the static site, plus what the converter could not do. Throws on a missing page or a bad form address. */
export function buildStaticSiteReport(input: StaticSiteInput): StaticSiteReport {
  if (!FORM_ACTION.test(input.formAction)) throw new Error('export: bad form address');
  if (input.pages.length === 0) throw new Error('export: no pages');
  for (const p of input.pages) {
    if (typeof input.htmlByPath[p.path] !== 'string') throw new Error(`export: missing page ${p.path || 'home'}`);
  }

  const domain = (input.domain ?? '').trim().toLowerCase() || null;
  const hrefToPath = new Map<string, string>();
  for (const p of input.pages) hrefToPath.set(normaliseHref(p.href), p.path);

  const shared: Shared = {
    input,
    hrefToPath,
    store: new AssetStore(input.assets),
    problems: [],
    stylesheets: [],
    seenSheets: new Set(),
    inline: [],
    logoUrl: input.pages[0].site.logoUrl,
    domain,
  };

  const files: StaticFiles = {};
  for (const p of input.pages) {
    const html = convertPage(p, input.htmlByPath[p.path], shared);
    scanLeaks(html, p.path, shared.problems);
    files[pageFile(p.path)] = html;
  }

  // One stylesheet: every sheet the pages named, in the order first seen, then any inline rules.
  const cssIndex = new Map<string, string>();
  for (const sheet of input.css) {
    const u = toUrl(sheet.url);
    if (!u) continue;
    cssIndex.set(u.pathname + u.search, sheet.text);
    if (!cssIndex.has(u.pathname)) cssIndex.set(u.pathname, sheet.text);
  }
  const parts: string[] = [];
  for (const s of shared.stylesheets) {
    const u = toUrl(s.url);
    const text = u ? (cssIndex.get(u.pathname + u.search) ?? cssIndex.get(u.pathname)) : undefined;
    if (text === undefined) {
      shared.problems.push({ code: 'missing_stylesheet', ref: s.url });
      continue;
    }
    parts.push(rewriteCss(text, s.base, shared.store, shared.problems));
  }
  for (const rules of shared.inline) parts.push(rewriteCss(rules, PLACEHOLDER_BASE, shared.store, shared.problems));
  const siteCss = parts.join('\n');
  if (/\/_next\/|__next/i.test(siteCss)) shared.problems.push({ code: 'leak', ref: 'css' });
  files['assets/site.css'] = siteCss;
  files['assets/form.css'] = FORM_CSS;

  Object.assign(files, shared.store.files);
  return { files, problems: shared.problems };
}

/** The files of the static site: a map of path to text (html, css) or bytes (fonts, images). */
export function buildStaticSite(input: StaticSiteInput): StaticFiles {
  return buildStaticSiteReport(input).files;
}
