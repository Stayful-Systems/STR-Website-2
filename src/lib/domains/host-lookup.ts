/**
 * Batch 33: what the proxy does with a request, decided from the host, the
 * path and two database lookups (injected), as pure functions with a small
 * per-instance cache. host-server.ts wires the real lookups and turns the
 * decision into a NextResponse; src/proxy.ts calls that.
 *
 *   own-domain host (any .co.uk that is not ours)
 *       lookup the name; a site whose domain row is connecting or live, and whose
 *       website is live, serves the allowlisted paths (siteHostPath); anything else
 *       on it is a 404. A lookup that fails is a 503, never a guess.
 *   our own host
 *       /s/<slug>[/page] of a site whose domain is LIVE gets a 301 to the same
 *       page on that domain (tempAddressTarget); every other request goes on
 *       as usual, and a failed lookup never breaks the app.
 *   anything else (localhost, a *.vercel.app preview): the app as usual.
 *
 * The cache: per instance, a 60 second TTL, negative answers too, at most 1000
 * entries (the oldest goes first). An instance restart empties it.
 *
 * Pure: no network, no database, no server-only.
 */
import { classifyHost, parseTempAddress, siteHostPath, siteNameFromHost, tempAddressTarget } from './redirect.ts';

export const HOST_CACHE_TTL_MS = 60_000;
export const HOST_CACHE_MAX = 1000;

export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  private readonly ttlMs: number;
  private readonly max: number;
  constructor(ttlMs: number = HOST_CACHE_TTL_MS, max: number = HOST_CACHE_MAX) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  get(key: string, now: number): { hit: true; value: V } | { hit: false } {
    const e = this.map.get(key);
    if (!e) return { hit: false };
    if (e.expires <= now) {
      this.map.delete(key);
      return { hit: false };
    }
    return { hit: true, value: e.value };
  }

  set(key: string, value: V, now: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: now + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/** A cached lookup. A failed load is not cached (the next request tries again) and is rethrown. */
export async function cached<V>(cache: TtlCache<V>, key: string, load: () => Promise<V>, now: number): Promise<V> {
  const got = cache.get(key, now);
  if (got.hit) return got.value;
  const value = await load();
  cache.set(key, value, now);
  return value;
}

/** A site that answers on its own domain. */
export interface SiteHost {
  slug: string;
}

export interface HostLookups {
  /** By registered name (harbourmanagement.co.uk): the site when its domain row is connecting or live and its website is live; else null. */
  siteByDomain(name: string): Promise<SiteHost | null>;
  /** By slug: the domain, when that site's domain row is LIVE and its website is live; else null. */
  liveDomainBySlug(slug: string): Promise<string | null>;
}

export type Decision =
  | { kind: 'next' }
  | { kind: 'rewrite'; pathname: string }
  | { kind: 'redirect'; url: string }
  | { kind: 'notfound' }
  | { kind: 'unavailable' };

export interface HostRequest {
  host: string | null;
  pathname: string;
  search: string;
  /** Our own host from NEXT_PUBLIC_SITE_URL ('' when unknown). */
  appHost: string;
}

export function createHostRouter(lookups: HostLookups, now: () => number = Date.now) {
  const sites = new TtlCache<SiteHost | null>();
  const temps = new TtlCache<string | null>();

  return async function decide(req: HostRequest): Promise<Decision> {
    const kind = classifyHost(req.host, req.appHost);

    if (kind === 'site') {
      const name = siteNameFromHost(req.host);
      if (!name) return { kind: 'notfound' };
      let site: SiteHost | null;
      try {
        site = await cached(sites, name, () => lookups.siteByDomain(name), now());
      } catch {
        return { kind: 'unavailable' };
      }
      if (!site) return { kind: 'notfound' };
      const path = siteHostPath(req.pathname, site.slug);
      if (path.kind === 'rewrite') return { kind: 'rewrite', pathname: path.pathname };
      if (path.kind === 'pass') return { kind: 'next' };
      return { kind: 'notfound' };
    }

    if (kind === 'app' && req.pathname.startsWith('/s/')) {
      const parsed = parseTempAddress(req.pathname);
      if (!parsed) return { kind: 'next' };
      let domain: string | null;
      try {
        domain = await cached(temps, parsed.slug, () => lookups.liveDomainBySlug(parsed.slug), now());
      } catch {
        return { kind: 'next' };
      }
      const target = domain ? tempAddressTarget(req.pathname, req.search, domain) : null;
      return target ? { kind: 'redirect', url: target } : { kind: 'next' };
    }

    return { kind: 'next' };
  };
}
