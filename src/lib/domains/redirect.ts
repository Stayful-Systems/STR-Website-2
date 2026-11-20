/**
 * Batch 33: host routing, as pure functions. proxy.ts (through host-server.ts)
 * asks these three things and does what they say.
 *
 *   classifyHost(host, appHost)          'app' | 'site' | 'other'
 *   siteHostPath(pathname, slug)         what an own-domain host may serve
 *   tempAddressTarget(pathname, search, domain)
 *                                        where /s/<slug>[/page] goes once the
 *                                        site has a live domain, or null
 *
 * Fail closed. Our own app host is itself a .co.uk, so the app and everything
 * under stayful.co.uk are classified first, and only after that is any other
 * .co.uk host a customer site. A customer host serves an allowlist of paths
 * (the site's own pages, its own /api/s/<slug>/lead and /report, address
 * autocomplete, robots.txt) and nothing else: /login, /admin and the rest of the
 * app answer 404 there.
 *
 * tempAddressTarget is the one place an off-site redirect is built, so it is
 * strict: the target host comes from the database and must be a plain
 * <label>.co.uk, the path is rebuilt from known page segments (never copied),
 * and only utm_*, fbclid and ad survive from the query, re-encoded. Nothing
 * from the request can choose the host.
 *
 * Pure: no network, no database, no server-only.
 */
import { CO_UK_NAME } from './name.ts';

/** The site's fixed pages (app/s/[slug]/[page]). */
export const SITE_PAGES: readonly string[] = ['fees', 'about', 'faq', 'privacy'];

const SEGMENT = /^[a-z0-9-]{1,64}$/;
const SLUG = /^[a-z0-9-]{3,40}$/;
/** The query keys that survive the move to the new address. */
const KEPT_QUERY = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'ad']);
const KEPT_VALUE_MAX = 200;

/** Lower-case, no port, no trailing dot. */
export function cleanHost(host: unknown): string {
  if (typeof host !== 'string') return '';
  return host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/** The app's own host from NEXT_PUBLIC_SITE_URL ("https://www.stayful.co.uk" -> "www.stayful.co.uk"), or ''. */
export function appHostOf(siteUrl: string | undefined | null): string {
  if (!siteUrl) return '';
  try {
    return cleanHost(new URL(siteUrl).host);
  } catch {
    return '';
  }
}

/**
 * app:   our own host, stayful.co.uk and everything under it (intelligence.stayful.co.uk ...).
 * site:  any other .co.uk host. Whether it is really a customer's is the database's to say.
 * other: localhost, an IP, a *.vercel.app address, anything not .co.uk: the app as usual.
 */
export function classifyHost(host: unknown, appHost: string): 'app' | 'site' | 'other' {
  const h = cleanHost(host);
  if (!h) return 'other';
  const app = cleanHost(appHost);
  if (app && h === app) return 'app';
  if (h === 'stayful.co.uk' || h.endsWith('.stayful.co.uk')) return 'app';
  if (h.endsWith('.co.uk')) return 'site';
  return 'other';
}

/** The registered name behind a site host: "www.harbour.co.uk" -> "harbour.co.uk". Null when it is not a plain <label>.co.uk. */
export function siteNameFromHost(host: unknown): string | null {
  let h = cleanHost(host);
  if (h.startsWith('www.')) h = h.slice(4);
  return CO_UK_NAME.test(h) ? h : null;
}

export type HostPath =
  | { kind: 'rewrite'; pathname: string }
  | { kind: 'pass' }
  | { kind: 'notfound' };

/**
 * What a customer host may serve. The pathname is the raw one from the request
 * (percent signs are never decoded, so "%2f" is refused, not understood).
 *   /                   -> /s/<slug>
 *   /fees /about /faq /privacy        -> /s/<slug>/<page>
 *   /areas/<area>       -> /s/<slug>/areas/<area>
 *   /robots.txt         -> /s/<slug>/robots.txt
 *   /api/s/<slug>/lead and /report   (this site's own) and /api/address-autocomplete: unchanged
 *   /_next/...          unchanged (the app's own assets)
 * Everything else, including /s/..., another site's API and every app route, is a 404.
 */
export function siteHostPath(pathname: string, slug: string): HostPath {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || !SLUG.test(slug)) return { kind: 'notfound' };
  // One trailing slash is the same page; nothing else is normalised.
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const base = `/s/${slug}`;

  if (path === '/') return { kind: 'rewrite', pathname: base };
  if (path === '/robots.txt') return { kind: 'rewrite', pathname: `${base}/robots.txt` };
  if (path === '/api/address-autocomplete') return { kind: 'pass' };
  if (path === `/api/s/${slug}/lead` || path === `/api/s/${slug}/report`) return { kind: 'pass' };
  if (path.startsWith('/_next/')) return { kind: 'pass' };

  const parts = path.slice(1).split('/');
  if (parts.length === 1 && SITE_PAGES.includes(parts[0])) return { kind: 'rewrite', pathname: `${base}/${parts[0]}` };
  if (parts.length === 2 && parts[0] === 'areas' && SEGMENT.test(parts[1])) return { kind: 'rewrite', pathname: `${base}/areas/${parts[1]}` };
  return { kind: 'notfound' };
}

/** "/s/<slug>[/page | /areas/<area>]" -> the slug and the known page path inside the site ('' for home). Null for anything else. */
export function parseTempAddress(pathname: string): { slug: string; rest: string } | null {
  if (typeof pathname !== 'string' || !pathname.startsWith('/s/')) return null;
  const path = pathname.length > 3 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const parts = path.slice(1).split('/'); // ['s', slug, ...]
  if (parts.length < 2 || parts[0] !== 's') return null;
  const slug = parts[1];
  if (!SLUG.test(slug)) return null;
  const tail = parts.slice(2);
  if (tail.length === 0) return { slug, rest: '' };
  if (tail.length === 1 && SITE_PAGES.includes(tail[0])) return { slug, rest: tail[0] };
  if (tail.length === 2 && tail[0] === 'areas' && SEGMENT.test(tail[1])) return { slug, rest: `areas/${tail[1]}` };
  return null;
}

/** Only utm_*, fbclid and ad, re-encoded, in their original order; at most one of each. */
export function keptQuery(search: string): string {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(typeof search === 'string' ? search : '');
  } catch {
    return '';
  }
  const out = new URLSearchParams();
  for (const [key, value] of params) {
    if (!KEPT_QUERY.has(key) || out.has(key)) continue;
    const v = value.slice(0, KEPT_VALUE_MAX);
    if (v) out.set(key, v);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

/**
 * Where the temporary address goes once its site has a live domain: an
 * absolute https URL on that domain (a 301), or null when it must not
 * redirect: not an /s/<slug> page, an unknown page, or a domain that is not a
 * plain <label>.co.uk. `domain` comes from the database only. /api/s/* never
 * matches (it does not start with /s/).
 */
export function tempAddressTarget(pathname: string, search: string, domain: unknown): string | null {
  const name = typeof domain === 'string' ? domain : '';
  if (!CO_UK_NAME.test(name)) return null;
  const parsed = parseTempAddress(pathname);
  if (!parsed) return null;
  const path = parsed.rest ? `/${parsed.rest}` : '/';
  return `https://${name}${path}${keptQuery(search)}`;
}
