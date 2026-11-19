/**
 * Batch 31: where a website's pages live. Path-based today: /s/<slug>, with
 * the pages under it (/s/<slug>/fees). Every link on the site and every link
 * we put in an email goes through siteHref, so Batch 33 (a customer's own
 * domain) changes this one file: when custom domains are on and a site has
 * one, the base is empty (the domain's root) instead of /s/<slug>, and the
 * proxy rewrites the host to the same pages.
 *
 * Pure: no network, no database, no server-only.
 */
import type { SiteRef } from './types.ts';

export const SITE_PREFIX = '/s';

/** Batch 33 flips this. While false a site's `domain` is ignored and every address is /s/<slug>. */
export const CUSTOM_DOMAINS_ON = false;

/** The custom domain in use, or null (always null until Batch 33). */
export function siteDomain(site: SiteRef): string | null {
  if (!CUSTOM_DOMAINS_ON) return null;
  const d = (site.domain ?? '').trim().toLowerCase();
  return d || null;
}

/** The site's own root: "/s/acme" today, "" on a custom domain. */
export function siteBase(site: SiteRef): string {
  if (siteDomain(site)) return '';
  return `${SITE_PREFIX}/${encodeURIComponent(site.slug)}`;
}

/**
 * A link within the site. `path` is "", "/", "fees" or "/fees" (a query
 * string or #fragment may follow); it is always read as inside the site, so
 * a "//host" or "https://host" can never become an off-site link. The home
 * page is the base itself ("/s/acme", or "/" on a custom domain).
 */
export function siteHref(site: SiteRef, path = ''): string {
  const raw = (path ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return siteBase(site) || '/';
  const rest = raw.replace(/^[/\\]+/, '');
  const base = siteBase(site);
  if (!rest) return base || '/';
  // "?x=1" or "#a" straight after the base keeps the home page.
  return rest.startsWith('?') || rest.startsWith('#') ? `${base || '/'}${rest}` : `${base}/${rest}`;
}
