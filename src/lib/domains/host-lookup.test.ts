import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOST_CACHE_MAX, HOST_CACHE_TTL_MS, TtlCache, cached, createHostRouter, type HostLookups } from './host-lookup.ts';

const APP = 'www.stayful.co.uk';

function router(sites: Record<string, string> = { 'harbourmanagement.co.uk': 'harbour' }, live: Record<string, string> = { harbour: 'harbourmanagement.co.uk' }) {
  const calls = { site: [] as string[], temp: [] as string[] };
  let clock = 1_000_000;
  const lookups: HostLookups = {
    siteByDomain: async (name) => { calls.site.push(name); return sites[name] ? { slug: sites[name] } : null; },
    liveDomainBySlug: async (slug) => { calls.temp.push(slug); return live[slug] ?? null; },
  };
  const decide = createHostRouter(lookups, () => clock);
  const at = (host: string | null, pathname: string, search = '') => decide({ host, pathname, search, appHost: APP });
  return { at, calls, advance: (ms: number) => { clock += ms; }, lookups };
}

test('a site host serves the home page and /fees from the site\'s own pages', async () => {
  const r = router();
  assert.deepEqual(await r.at('harbourmanagement.co.uk', '/'), { kind: 'rewrite', pathname: '/s/harbour' });
  assert.deepEqual(await r.at('harbourmanagement.co.uk', '/fees'), { kind: 'rewrite', pathname: '/s/harbour/fees' });
  assert.deepEqual(await r.at('www.harbourmanagement.co.uk', '/areas/leeds'), { kind: 'rewrite', pathname: '/s/harbour/areas/leeds' });
  assert.deepEqual(await r.at('harbourmanagement.co.uk', '/api/s/harbour/lead'), { kind: 'next' });
});

test('/login, /admin and the rest of the app are a 404 on a site host; an unknown .co.uk host is a 404 too', async () => {
  const r = router();
  for (const p of ['/login', '/admin', '/home', '/api/internal/domains', '/s/harbour', '/api/s/other/lead']) assert.deepEqual(await r.at('harbourmanagement.co.uk', p), { kind: 'notfound' }, p);
  assert.deepEqual(await r.at('unknown.co.uk', '/'), { kind: 'notfound' });
  assert.deepEqual(await r.at('a.b.co.uk', '/'), { kind: 'notfound' });
  assert.deepEqual(await r.at('evilstayful.co.uk', '/login'), { kind: 'notfound' });
});

test('/s/<slug> on the app host is a 301 to the live domain with utm kept; other app requests go on', async () => {
  const r = router();
  assert.deepEqual(await r.at(APP, '/s/harbour', '?utm_source=x'), { kind: 'redirect', url: 'https://harbourmanagement.co.uk/?utm_source=x' });
  assert.deepEqual(await r.at(APP, '/s/harbour/fees', '?utm_source=x&junk=1&fbclid=abc'), { kind: 'redirect', url: 'https://harbourmanagement.co.uk/fees?utm_source=x&fbclid=abc' });
  assert.deepEqual(await r.at('intelligence.stayful.co.uk', '/s/harbour'), { kind: 'redirect', url: 'https://harbourmanagement.co.uk/' });
  assert.deepEqual(await r.at(APP, '/s/other-site'), { kind: 'next' }, 'a site without a live domain stays put');
  assert.deepEqual(await r.at(APP, '/api/s/harbour/lead'), { kind: 'next' }, 'the API is never redirected');
  assert.deepEqual(await r.at(APP, '/s/harbour/unknown'), { kind: 'next' });
  assert.deepEqual(await r.at(APP, '/login'), { kind: 'next' });
});

test('our own hosts are never a customer site: intelligence.stayful.co.uk and the app host never trigger a site lookup', async () => {
  const r = router();
  for (const host of ['intelligence.stayful.co.uk', APP, 'stayful.co.uk', 'app.stayful.co.uk']) assert.deepEqual(await r.at(host, '/login'), { kind: 'next' }, host);
  assert.deepEqual(r.calls.site, []);
  assert.deepEqual(r.calls.temp, [], 'and an ordinary app path looks nothing up');
});

test('only .co.uk hosts that are not ours, and /s/* on our host, trigger a lookup; everything else is untouched', async () => {
  const r = router();
  for (const host of ['localhost:3000', '127.0.0.1', 'str-website-2.vercel.app', 'harbourmanagement.com', null]) {
    assert.deepEqual(await r.at(host, '/'), { kind: 'next' }, String(host));
    assert.deepEqual(await r.at(host, '/s/harbour'), { kind: 'next' }, `${host} /s/harbour: only our own host redirects`);
  }
  assert.deepEqual(r.calls.site, []);
  assert.deepEqual(r.calls.temp, []);
  await r.at('harbourmanagement.co.uk', '/');
  assert.deepEqual(r.calls.site, ['harbourmanagement.co.uk']);
  await r.at(APP, '/s/harbour');
  assert.deepEqual(r.calls.temp, ['harbour']);
});

test('a failed lookup is a 503 on a site host (never served, never a guess) and never breaks our own app', async () => {
  const broken: HostLookups = { siteByDomain: async () => { throw new Error('db down'); }, liveDomainBySlug: async () => { throw new Error('db down'); } };
  const decide = createHostRouter(broken);
  assert.deepEqual(await decide({ host: 'harbourmanagement.co.uk', pathname: '/', search: '', appHost: APP }), { kind: 'unavailable' });
  assert.deepEqual(await decide({ host: APP, pathname: '/s/harbour', search: '', appHost: APP }), { kind: 'next' });
});

test('lookups are cached for 60 seconds, negatives too, and a failed lookup is not cached', async () => {
  const r = router();
  await r.at('harbourmanagement.co.uk', '/');
  await r.at('harbourmanagement.co.uk', '/fees');
  await r.at('unknown.co.uk', '/');
  await r.at('unknown.co.uk', '/');
  assert.deepEqual(r.calls.site, ['harbourmanagement.co.uk', 'unknown.co.uk']);
  await r.at(APP, '/s/harbour');
  await r.at(APP, '/s/harbour/fees');
  assert.deepEqual(r.calls.temp, ['harbour']);
  r.advance(HOST_CACHE_TTL_MS - 1);
  await r.at('harbourmanagement.co.uk', '/');
  assert.equal(r.calls.site.length, 2);
  r.advance(2);
  await r.at('harbourmanagement.co.uk', '/');
  assert.equal(r.calls.site.length, 3, 'looked up again after the TTL');

  let fail = true;
  const flaky = createHostRouter({ siteByDomain: async () => { if (fail) throw new Error('x'); return { slug: 'harbour' }; }, liveDomainBySlug: async () => null });
  assert.equal((await flaky({ host: 'harbourmanagement.co.uk', pathname: '/', search: '', appHost: APP })).kind, 'unavailable');
  fail = false;
  assert.equal((await flaky({ host: 'harbourmanagement.co.uk', pathname: '/', search: '', appHost: APP })).kind, 'rewrite');
});

test('the cache holds at most 1000 entries, the oldest going first', async () => {
  const c = new TtlCache<number>(1000, HOST_CACHE_MAX);
  for (let i = 0; i < HOST_CACHE_MAX + 50; i++) c.set(`k${i}`, i, 0);
  assert.equal(c.size, HOST_CACHE_MAX);
  assert.equal(c.get('k0', 1).hit, false);
  assert.equal(c.get(`k${HOST_CACHE_MAX + 49}`, 1).hit, true);
  assert.equal(c.get('k60', 1000).hit, false, 'expired');
  let n = 0;
  const cache = new TtlCache<string | null>();
  await cached(cache, 'a', async () => { n++; return null; }, 0);
  await cached(cache, 'a', async () => { n++; return null; }, 1);
  assert.equal(n, 1, 'a null is cached');
});

test('the proxy: the lines Batch 33 added, and nothing else changed', () => {
  const proxy = readFileSync(new URL('../../proxy.ts', import.meta.url), 'utf8');
  assert.match(proxy, /^import \{ isSiteHost, siteHostResponse, tempAddressRedirect \} from '@\/lib\/domains\/host-server'$/m);
  const block = `  if (isSiteHost(request)) return siteHostResponse(request)
  if (request.nextUrl.pathname.startsWith('/s/')) {
    const moved = await tempAddressRedirect(request)
    if (moved) return moved
  }
`;
  assert.ok(proxy.includes(block), 'the host block is as planned');
  // It runs after the Supabase-configured check and before the session refresh.
  assert.ok(proxy.indexOf('isSupabaseConfigured()') < proxy.indexOf(block) && proxy.indexOf(block) < proxy.indexOf('await updateSupabaseSession(request)'));
  // The rest of the proxy is as it was: the protected prefixes and the matcher are unchanged.
  assert.match(proxy, /const PROTECTED_PREFIXES = \['\/welcome', '\/home', '\/today', '\/my-deals', '\/estimate', '\/reports', '\/picks', '\/deals', '\/leads', '\/profile', '\/profiles', '\/account', '\/upgrade', '\/admin', '\/extension\/connect'\]/);
  assert.match(proxy, /'\/\(\(\?!_next\/static\|_next\/image\|favicon\.ico\|api\/presence\|\.\*\\\\\.\(\?:svg\|png\|jpg\|jpeg\|gif\|webp\|ico\|pdf\)\$\)\.\*\)'/);
});

test('the host server answers a site host with a rewrite, a 404 or a 503 and never the app; the dev stand-in is development only', () => {
  const src = readFileSync(new URL('./host-server.ts', import.meta.url), 'utf8');
  assert.match(src, /process\.env\.NODE_ENV !== 'development' \|\| !process\.env\.DOMAINS_DEV_FAKE_HOSTS/);
  assert.match(src, /NextResponse\.redirect\(d\.url, 301\)/);
  assert.match(src, /status: 404/);
  assert.match(src, /status: 503/);
  assert.doesNotMatch(src, /console\./);
  assert.doesNotMatch(src, /updateSupabaseSession/, 'the session refresh is skipped on own-domain hosts');
});
