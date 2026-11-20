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
import { siteUrl } from '../url.ts';
import { CO_UK_NAME } from '../domains/name.ts';
import type { SiteRef } from './types.ts';

export const SITE_PREFIX = '/s';

/**
 * Batch 33 turned this on. It is safe because websites.domain is set only when
 * a domain goes live (src/lib/domains/purchase-server.ts): a site with no
 * domain, or one still connecting, keeps the /s/<slug> address.
 */
export const CUSTOM_DOMAINS_ON = true;

/** The custom domain in use, or null. Only a plain <label>.co.uk counts: a stored value that is anything else is ignored. */
export function siteDomain(site: SiteRef): string | null {
  if (!CUSTOM_DOMAINS_ON) return null;
  const d = (site.domain ?? '').trim().toLowerCase();
  return CO_UK_NAME.test(d) ? d : null;
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

/**
 * The full address of a page, for emails, notices and canonical links: on the
 * site's own domain when it has one ("https://harbourmanagement.co.uk/fees"),
 * else on the app's address ("https://stayful.co.uk/s/harbour/fees"). Pass
 * `{ slug }` only to get the temporary address whatever the site has (go-live's
 * check does, so approval always tests the /s/<slug> pages).
 */
export function siteAbsoluteUrl(site: SiteRef, path = ''): string {
  const domain = siteDomain(site);
  const rel = siteHref(site, path);
  return domain ? `https://${domain}${rel}` : siteUrl(rel);
}
