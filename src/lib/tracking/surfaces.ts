/**
 * Where the cookie banner shows, where Meta's pixel may send, and what the
 * address must look like before it does.
 *
 * Meta's standard pixel always sends the whole address bar (and the
 * referrer) with every event, and nothing in it can change that. So:
 *
 *   - only the pages in config.ts's PageView list ever send (deny by default);
 *   - before sending, tracking tags and a page's one-shot flags are taken off
 *     the address (tidiedHref), after the page has read them;
 *   - just before every send the live address is checked again
 *     (isCleanForSend): anything still after the path, and nothing is sent.
 *
 * Review R4 (R4-01): a few pages (config.ts CONVERSION_ONLY_PATHS: the
 * reveal and Home) never send a PageView but may fire a member's held
 * conversions, from a clean address only (pixelPlan, and the `send` argument
 * of isCleanForSend). They show no banner: surfaceFor still says 'none'.
 *
 * White-label and admin pages (/f, /r, /admin), token pages and unknown paths
 * (404s render in the root layout) get nothing at all: no banner, no pixel,
 * nothing read from the address.
 *
 * Pure: no network, no database, no server-only.
 */
import { BANNER_ONLY_PREFIXES, CONVERSION_ONLY_PATHS, ONE_SHOT_PARAMS, PAGEVIEW_AREA_PREFIXES, PAGEVIEW_PATHS, STRIPE_RETURNS, TRACKING_PARAMS } from './config.ts';

export type Surface = 'tracked' | 'banner' | 'none';

/** What the pixel is about to send: a PageView, or one of the member's held conversions. */
export type PixelSend = 'PageView' | 'conversion';

/**
 * Never anything here, whatever the lists above say: the white-label funnel
 * and the prospect's report, admin, the API, auth handlers, token pages and
 * pages shown to people other than the member.
 */
const NEVER: readonly string[] = [
  '/f/',
  '/r/',
  '/admin',
  '/api/',
  '/auth/',
  '/team/join',
  '/extension/connect',
  '/presentation',
  '/demo-report',
  '/m',
  '/profiles/switch',
];

function normalise(pathname: string): string {
  const p = pathname.split('?')[0].split('#')[0] || '/';
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** A prefix ending in "/" matches below it; any other matches itself and below it. */
function under(path: string, prefix: string): boolean {
  return prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`);
}

const AREA_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function surfaceFor(pathname: string | null | undefined): Surface {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return 'none';
  const path = normalise(pathname);
  if (NEVER.some((p) => under(path, p))) return 'none';
  if (PAGEVIEW_PATHS.includes(path)) return 'tracked';
  for (const prefix of PAGEVIEW_AREA_PREFIXES) {
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length);
      if (!rest.includes('/') && rest.length <= 60 && AREA_SLUG.test(rest)) return 'tracked';
    }
  }
  if (BANNER_ONLY_PREFIXES.some((p) => under(path, p))) return 'banner';
  return 'none';
}

/**
 * Review R4 (R4-01): a page that never sends a PageView but where held
 * conversions may fire (the reveal, Home). Not a tracked page, no banner.
 */
export function firesConversionsOnly(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false;
  const path = normalise(pathname);
  if (NEVER.some((p) => under(path, p))) return false;
  return CONVERSION_ONLY_PATHS.includes(path);
}

function parse(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/**
 * The address without tracking tags and without the page's one-shot flags,
 * or null when nothing needs to go. ?via is left alone: the visit heartbeat
 * reads and removes it itself.
 */
export function tidiedHref(href: string): string | null {
  const url = parse(href);
  if (!url) return null;
  const path = normalise(url.pathname);
  let changed = false;
  for (const name of TRACKING_PARAMS) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  for (const flag of ONE_SHOT_PARAMS) {
    if (flag.path !== path || !url.searchParams.has(flag.param)) continue;
    if (flag.when !== undefined && url.searchParams.get(flag.param) !== flag.when) continue;
    url.searchParams.delete(flag.param);
    changed = true;
  }
  if (!changed) return null;
  const search = url.searchParams.toString();
  return `${url.origin}${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
}

/**
 * Whether the pixel may send from this address right now: nothing after the
 * path, at most a plain #anchor, and a page on the PageView list. A held
 * conversion (send = 'conversion') may also go from a conversion-only page
 * (the reveal, Home); a PageView never does.
 */
export function isCleanForSend(href: string | null | undefined, send: PixelSend = 'PageView'): boolean {
  if (typeof href !== 'string') return false;
  const url = parse(href);
  if (!url) return false;
  if (url.search !== '' || href.includes('?')) return false;
  if (url.hash !== '' && !/^#[A-Za-z0-9_-]{1,40}$/.test(url.hash)) return false;
  if (surfaceFor(url.pathname) === 'tracked') return true;
  return send === 'conversion' && firesConversionsOnly(url.pathname);
}

/**
 * Review R4 (R4-01): what the pixel may do on this page, for a member who
 * has accepted. `held`: how many of their conversions are waiting to fire.
 *   start       load the pixel here (a PageView page, or a conversion-only
 *               page with something to fire: Home never loads it for nothing)
 *   pageView    send a PageView (PageView pages only: never Home or the reveal)
 *   conversions fire the held conversions
 * All false on an address that is not clean.
 */
export function pixelPlan(href: string | null | undefined, held: number): { start: boolean; pageView: boolean; conversions: boolean } {
  const pageView = isCleanForSend(href, 'PageView');
  const conversions = isCleanForSend(href, 'conversion');
  return { start: pageView || (conversions && held > 0), pageView, conversions };
}

/** A return from Stripe Checkout (?topup=1 / ?subscribed=1 on the billing page): read before tidying. */
export function isStripeReturn(href: string | null | undefined): boolean {
  if (typeof href !== 'string') return false;
  const url = parse(href);
  if (!url) return false;
  // Batch 21 (E28): the pack's return (/today?pack=1) is a Stripe return too.
  return STRIPE_RETURNS.some((r) => normalise(url.pathname) === r.path && r.params.some((p) => url.searchParams.has(p)));
}
