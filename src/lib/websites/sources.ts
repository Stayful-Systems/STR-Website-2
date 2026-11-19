/**
 * Batch 31: where a website lead came from, read from the page address the
 * landlord arrived on: utm_source / utm_medium / utm_campaign / utm_content /
 * utm_term, fbclid, the ad code (?ad=<code>, trimmed, 40 characters at most:
 * lead_sources.ad_code is varchar(40)) and the landing page as a PATH only.
 *
 * Nothing here ever keeps a query string, a fragment or an origin in the
 * landing page, so no address a landlord typed can reach lead_sources. Values
 * are trimmed, control characters removed, and cut to a fixed length; an empty
 * value is null.
 *
 * Pure: no network, no database, no server-only.
 */
import type { LeadSourceFields } from './types.ts';

export const AD_CODE_MAX = 40;
const UTM_MAX = 100;
const FBCLID_MAX = 200;
export const LANDING_PATH_MAX = 200;

/** Anything a query can arrive as: a URLSearchParams, a "?a=b" / "a=b" string, or a parsed object. */
export type SourceInput = URLSearchParams | string | Record<string, string | string[] | undefined | null> | null | undefined;

function clean(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!t) return null;
  return t.slice(0, max).trim() || null;
}

function lookup(input: SourceInput, key: string): unknown {
  if (!input) return undefined;
  if (input instanceof URLSearchParams) return input.get(key) ?? undefined;
  if (typeof input === 'string') return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input).get(key) ?? undefined;
  const v = input[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The landing page as a path: "/s/acme/fees". A full URL loses its origin; a
 * query string and fragment are always dropped; anything that is not a path
 * on this site (empty, "//host", over 200 characters) is null.
 */
export function landingPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let t = clean(raw, 2000);
  if (!t) return null;
  const origin = t.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i);
  if (origin) t = t.slice(origin[0].length) || '/';
  t = t.split('#')[0].split('?')[0];
  if (!t.startsWith('/') || t.startsWith('//')) return null;
  if (t.length > LANDING_PATH_MAX) return null;
  return t;
}

/** utm_*, fbclid, the ad code and the landing path, as lead_sources stores them. */
export function parseSources(query: SourceInput, landing?: unknown): LeadSourceFields {
  return {
    utm_source: clean(lookup(query, 'utm_source'), UTM_MAX),
    utm_medium: clean(lookup(query, 'utm_medium'), UTM_MAX),
    utm_campaign: clean(lookup(query, 'utm_campaign'), UTM_MAX),
    utm_content: clean(lookup(query, 'utm_content'), UTM_MAX),
    utm_term: clean(lookup(query, 'utm_term'), UTM_MAX),
    fbclid: clean(lookup(query, 'fbclid'), FBCLID_MAX),
    ad_code: clean(lookup(query, 'ad'), AD_CODE_MAX),
    landing_page: landingPath(landing),
  };
}

/** True when at least one attribution value is present (the landing page alone does not count). */
export function hasAttribution(s: LeadSourceFields): boolean {
  return Boolean(s.utm_source || s.utm_medium || s.utm_campaign || s.utm_content || s.utm_term || s.fbclid || s.ad_code);
}
