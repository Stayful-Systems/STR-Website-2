import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { createHostRouter, type Decision, type HostLookups } from './host-lookup.ts';
import { appHostOf, classifyHost } from './redirect.ts';
import { isSwitchedOff } from '../websites/grace-public.ts';

/**
 * Batch 33: the proxy's two host jobs, over the real database.
 *
 *   siteHostResponse(request)     a request on a customer's own domain: serve the
 *                                 site's allowlisted pages (rewritten to /s/<slug>/...),
 *                                 or a 404 for everything else. Never the app.
 *   tempAddressRedirect(request)  /s/<slug>[/page] on OUR host, for a site whose
 *                                 domain is live: a 301 to the same page on the domain.
 *
 * The rules are redirect.ts's and host-lookup.ts's (pure, tested). This file
 * only reads two small things with the service role and answers:
 *   siteByDomain       website_domains (connecting or live) joined to a LIVE website
 *   liveDomainBySlug   a LIVE website's domain row that is `live`
 * Both are cached per instance for 60 seconds, negatives too.
 *
 * Only .co.uk hosts that are not ours, and /s/* on our host, ever reach a
 * lookup: the proxy asks classifyHost first. The Supabase session refresh is
 * skipped for own-domain hosts (their requests never carry our cookies).
 *
 * Development only: DOMAINS_DEV_FAKE_HOSTS (JSON {"harbour.co.uk":"slug"}) stands in
 * for the database so the routing can be seen locally. It is read only when
 * NODE_ENV is "development" and is ignored everywhere else.
 */

type Row = Record<string, unknown>;

async function siteByDomain(name: string): Promise<{ slug: string } | null> {
  if (!hasServiceRole()) throw new Error('no_service_role');
  const { data, error } = await createAdminClient()
    .from('website_domains')
    .select('status, websites!inner(slug, status, website_grace(switched_off_at, cancelled_at))')
    .eq('name', name)
    .in('status', ['connecting', 'live'])
    // Batch 36: a switched-off (paused) site's domain still reaches /s/<slug>, which shows the neutral page; an admin-paused one is a 404.
    .in('websites.status', ['live', 'paused'])
    .maybeSingle();
  if (error) throw new Error(`host:${error.code ?? 'error'}`);
  const w = (data as Row | null)?.websites;
  const site = (Array.isArray(w) ? w[0] : w) as Row | undefined;
  const grace = (Array.isArray(site?.website_grace) ? site?.website_grace[0] : site?.website_grace) as { switched_off_at: string | null; cancelled_at: string | null } | null | undefined;
  return site && typeof site.slug === 'string' && (site.status === 'live' || isSwitchedOff(String(site.status), grace)) ? { slug: site.slug } : null;
}

async function liveDomainBySlug(slug: string): Promise<string | null> {
  if (!hasServiceRole()) throw new Error('no_service_role');
  const { data, error } = await createAdminClient().from('websites').select('status, website_domains!inner(name, status)').eq('slug', slug).eq('status', 'live').eq('website_domains.status', 'live').maybeSingle();
  if (error) throw new Error(`host:${error.code ?? 'error'}`);
  const d = (data as Row | null)?.website_domains;
  const row = (Array.isArray(d) ? d[0] : d) as Row | undefined;
  return row && typeof row.name === 'string' ? row.name : null;
}

function devFake(): HostLookups | null {
  if (process.env.NODE_ENV !== 'development' || !process.env.DOMAINS_DEV_FAKE_HOSTS) return null;
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(process.env.DOMAINS_DEV_FAKE_HOSTS) as Record<string, string>;
  } catch {
    map = {};
  }
  return {
    siteByDomain: async (name) => (map[name] ? { slug: map[name] } : null),
    liveDomainBySlug: async (slug) => Object.entries(map).find(([, s]) => s === slug)?.[0] ?? null,
  };
}

const router = createHostRouter({
  siteByDomain: (name) => (devFake() ?? { siteByDomain }).siteByDomain(name),
  liveDomainBySlug: (slug) => (devFake() ?? { liveDomainBySlug }).liveDomainBySlug(slug),
});

function decisionOf(request: NextRequest): Promise<Decision> {
  return router({ host: request.headers.get('host'), pathname: request.nextUrl.pathname, search: request.nextUrl.search, appHost: appHostOf(process.env.NEXT_PUBLIC_SITE_URL) });
}

/** Is this request for a customer's own domain? (The proxy asks before it does anything else.) */
export function isSiteHost(request: NextRequest): boolean {
  return classifyHost(request.headers.get('host'), appHostOf(process.env.NEXT_PUBLIC_SITE_URL)) === 'site';
}

/** The answer for a request on a customer's own domain. Always a response: the app's other routes are never reachable here. */
export async function siteHostResponse(request: NextRequest): Promise<NextResponse> {
  const d = await decisionOf(request);
  switch (d.kind) {
    case 'rewrite': {
      const url = request.nextUrl.clone();
      url.pathname = d.pathname;
      return NextResponse.rewrite(url);
    }
    case 'next':
      return NextResponse.next();
    case 'unavailable':
      return new NextResponse('Temporarily unavailable', { status: 503, headers: { 'Retry-After': '30', 'Cache-Control': 'no-store' } });
    default:
      return new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
}

/** A 301 to the live domain for /s/<slug>[/page] on our host, or null (carry on as usual). */
export async function tempAddressRedirect(request: NextRequest): Promise<NextResponse | null> {
  const d = await decisionOf(request);
  return d.kind === 'redirect' ? NextResponse.redirect(d.url, 301) : null;
}
