import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appHostOf, classifyHost, keptQuery, parseTempAddress, siteHostPath, siteNameFromHost, tempAddressTarget } from './redirect.ts';

const APP = 'www.stayful.co.uk';

test('our own hosts are never a customer site: *.stayful.co.uk and the NEXT_PUBLIC_SITE_URL host', () => {
  for (const h of ['www.stayful.co.uk', 'stayful.co.uk', 'intelligence.stayful.co.uk', 'app.stayful.co.uk', 'a.b.stayful.co.uk', 'INTELLIGENCE.STAYFUL.CO.UK', 'intelligence.stayful.co.uk:443', 'stayful.co.uk.']) {
    assert.equal(classifyHost(h, APP), 'app', h);
  }
  // The app host is whatever NEXT_PUBLIC_SITE_URL says, even when it is another .co.uk.
  assert.equal(classifyHost('portal.example.co.uk', 'portal.example.co.uk'), 'app');
  assert.equal(classifyHost('portal.example.co.uk:3000', 'portal.example.co.uk'), 'app');
  assert.equal(appHostOf('https://portal.example.co.uk/'), 'portal.example.co.uk');
  assert.equal(appHostOf('http://localhost:3000'), 'localhost');
  assert.equal(appHostOf('not a url'), '');
  assert.equal(appHostOf(undefined), '');
});

test('any other .co.uk host is a site candidate; everything else is the app as usual', () => {
  for (const h of ['harbourmanagement.co.uk', 'www.harbourmanagement.co.uk', 'x.co.uk', 'a.b.co.uk', 'harbourmanagement.co.uk:443']) assert.equal(classifyHost(h, APP), 'site', h);
  for (const h of ['localhost', 'localhost:3000', '127.0.0.1', '10.0.0.1:3000', 'str-website-2.vercel.app', 'harbourmanagement.com', 'harbourmanagement.uk', 'co.uk.evil.com', 'evil.com', '']) assert.equal(classifyHost(h, APP), 'other', h);
  assert.equal(classifyHost(undefined, APP), 'other');
  assert.equal(classifyHost('evilstayful.co.uk', APP), 'site', 'a lookalike is not ours: it is a site candidate, and the database will not know it');
  assert.equal(classifyHost('stayful.co.uk.evil.co.uk', APP), 'site');
});

test('a site host name is a plain <label>.co.uk, with or without www', () => {
  assert.equal(siteNameFromHost('harbourmanagement.co.uk'), 'harbourmanagement.co.uk');
  assert.equal(siteNameFromHost('WWW.Harbourmanagement.co.uk:443'), 'harbourmanagement.co.uk');
  for (const bad of ['a.b.co.uk', 'co.uk', '-x.co.uk', 'x.com', 'evil.com/x.co.uk', '', null]) assert.equal(siteNameFromHost(bad), null, String(bad));
});

test('a site host serves the home page, the fixed pages, areas and robots.txt, rewritten under /s/<slug>', () => {
  assert.deepEqual(siteHostPath('/', 'harbour'), { kind: 'rewrite', pathname: '/s/harbour' });
  assert.deepEqual(siteHostPath('/fees', 'harbour'), { kind: 'rewrite', pathname: '/s/harbour/fees' });
  assert.deepEqual(siteHostPath('/fees/', 'harbour'), { kind: 'rewrite', pathname: '/s/harbour/fees' });
  for (const p of ['about', 'faq', 'privacy']) assert.deepEqual(siteHostPath(`/${p}`, 'harbour'), { kind: 'rewrite', pathname: `/s/harbour/${p}` });
  assert.deepEqual(siteHostPath('/areas/leeds-north', 'harbour'), { kind: 'rewrite', pathname: '/s/harbour/areas/leeds-north' });
  assert.deepEqual(siteHostPath('/robots.txt', 'harbour'), { kind: 'rewrite', pathname: '/s/harbour/robots.txt' });
});

test('a site host passes its own lead and report API, address autocomplete and the app\'s assets', () => {
  assert.deepEqual(siteHostPath('/api/s/harbour/lead', 'harbour'), { kind: 'pass' });
  assert.deepEqual(siteHostPath('/api/s/harbour/report', 'harbour'), { kind: 'pass' });
  assert.deepEqual(siteHostPath('/api/address-autocomplete', 'harbour'), { kind: 'pass' });
  assert.deepEqual(siteHostPath('/_next/data/x/y.json', 'harbour'), { kind: 'pass' });
});

test('/admin and /login on a site host are a 404, and so is the rest of the app', () => {
  for (const p of [
    '/admin', '/admin/management', '/login', '/signup', '/home', '/leads', '/account', '/today', '/api/internal/domains', '/api/stripe/webhook', '/api/presence',
    '/s/harbour', '/s/harbour/fees', '/s/other', '/areas', '/areas/', '/areas/a/b', '/areas/Leeds', '/fees/x', '/Fees', '/sitemap.xml', '/auth/callback', '/r/token', '/f/token', '/api',
  ]) {
    assert.deepEqual(siteHostPath(p, 'harbour'), { kind: 'notfound' }, p);
  }
});

test('/api/s/<other-slug>/lead on a site host is a 404: a site only reaches its own API', () => {
  assert.deepEqual(siteHostPath('/api/s/other-site/lead', 'harbour'), { kind: 'notfound' });
  assert.deepEqual(siteHostPath('/api/s/other-site/report', 'harbour'), { kind: 'notfound' });
  assert.deepEqual(siteHostPath('/api/s/harbour/lead/extra', 'harbour'), { kind: 'notfound' });
  assert.deepEqual(siteHostPath('/api/s/harbour/other', 'harbour'), { kind: 'notfound' });
  assert.deepEqual(siteHostPath('/api/s/harbour/../other/lead', 'harbour'), { kind: 'notfound' });
  assert.deepEqual(siteHostPath('/api/s/HARBOUR/lead', 'harbour'), { kind: 'notfound' });
});

test('traversal and encoded tricks on a site host are a 404', () => {
  for (const p of ['/..', '/../admin', '/fees/..', '/%2e%2e/admin', '/areas/%2e%2e', '/areas/..', '//evil.com', '/\\admin', '/fees%2f', '/areas/a%2fb', 'admin', '', '/areas/a b', '/fees\n']) {
    assert.deepEqual(siteHostPath(p, 'harbour'), { kind: 'notfound' }, JSON.stringify(p));
  }
  // A bad slug from the database never serves anything.
  assert.deepEqual(siteHostPath('/', 'Bad Slug'), { kind: 'notfound' });
  assert.deepEqual(siteHostPath('/', '../x'), { kind: 'notfound' });
});

test('the temporary address of a site with a live domain goes to the same page on its domain, utm kept', () => {
  assert.equal(tempAddressTarget('/s/harbour', '', 'harbourmanagement.co.uk'), 'https://harbourmanagement.co.uk/');
  assert.equal(tempAddressTarget('/s/harbour/', '', 'harbourmanagement.co.uk'), 'https://harbourmanagement.co.uk/');
  assert.equal(tempAddressTarget('/s/harbour/fees', '?utm_source=x', 'harbourmanagement.co.uk'), 'https://harbourmanagement.co.uk/fees?utm_source=x');
  assert.equal(tempAddressTarget('/s/harbour/areas/leeds', '?utm_source=fb&utm_medium=cpc&utm_campaign=c&utm_content=a&utm_term=t&fbclid=abc&ad=X1', 'harbourmanagement.co.uk'), 'https://harbourmanagement.co.uk/areas/leeds?utm_source=fb&utm_medium=cpc&utm_campaign=c&utm_content=a&utm_term=t&fbclid=abc&ad=X1');
  assert.equal(tempAddressTarget('/s/harbour/privacy', '?other=1&utm_source=x', 'harbourmanagement.co.uk'), 'https://harbourmanagement.co.uk/privacy?utm_source=x');
});

test('only utm_*, fbclid and ad are kept from the query, re-encoded and bounded', () => {
  assert.equal(keptQuery('?utm_source=a b&x=1'), '?utm_source=a+b');
  assert.equal(keptQuery('?utm_source=%0d%0aSet-Cookie:x'), '?utm_source=%0D%0ASet-Cookie%3Ax');
  assert.equal(keptQuery('?redirect=https://evil.com&next=//evil.com&url=x'), '');
  assert.equal(keptQuery('?utm_source=a&utm_source=b'), '?utm_source=a');
  assert.equal(keptQuery('?ad='), '');
  assert.equal(keptQuery(''), '');
  assert.ok(keptQuery(`?utm_source=${'a'.repeat(5000)}`).length < 300);
});

test('//evil.com, https://evil, %2f%2f, a backslash or a bad domain from the database never become an off-site redirect', () => {
  const ok = 'harbourmanagement.co.uk';
  // The path is rebuilt from known pieces, so no path trick can reach another host.
  for (const p of ['//evil.com', '/s//evil.com', '/s/harbour//evil.com', '/s/harbour/https://evil', '/s/harbour/%2f%2fevil.com', '/s/harbour/\\evil.com', '/s/harbour/..%2f..', '/s/harbour/fees/../../x', '/s/harbour/@evil.com', '/s/harbour/areas/%2f%2fevil.com', '/s/harbour/areas/a/b', '/s/harbour/unknown', '/s/harbour/areas', '/s/ha/fees', '/s/HARBOUR', '/api/s/harbour/lead', '/api/s/harbour/report', '/s', '/s/', '/x/s/harbour']) {
    assert.equal(tempAddressTarget(p, '', ok), null, p);
  }
  // The query can never change the host or the path.
  for (const q of ['?utm_source=//evil.com', '?redirect=//evil.com', '?x=%2f%2fevil.com']) {
    const t = tempAddressTarget('/s/harbour', q, ok);
    assert.ok(t === null || new URL(t).host === ok, q);
    assert.ok(t === null || new URL(t).pathname === '/', q);
  }
  // The domain from the database must be a plain <label>.co.uk, or nothing is built.
  for (const d of ['evil.com', 'evil.com/', 'https://evil.co.uk', 'evil.co.uk/x', 'evil.co.uk\n', 'a.b.co.uk', 'www.evil.co.uk', '-x.co.uk', 'x.co.uk@evil.com', 'x.co.uk:80', 'x.co.uk#', 'x.co.uk?x', 'EVIL.co.uk', '', null, undefined, 42, '//evil.co.uk', 'xn--x.co.uk.evil.com']) {
    const t = tempAddressTarget('/s/harbour', '', d);
    if (d === 'xn--x.co.uk.evil.com') assert.equal(t, null, String(d));
    else assert.equal(t, null, String(d));
  }
  // Every URL that is built is https on the stored domain, and nowhere else.
  const built = tempAddressTarget('/s/harbour/fees', '?utm_source=%2f%2fevil.com', ok);
  assert.ok(built);
  const u = new URL(built);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.host, ok);
  assert.equal(u.username, '');
});

test('parseTempAddress reads only /s/<slug> and its known pages', () => {
  assert.deepEqual(parseTempAddress('/s/harbour'), { slug: 'harbour', rest: '' });
  assert.deepEqual(parseTempAddress('/s/harbour/fees'), { slug: 'harbour', rest: 'fees' });
  assert.deepEqual(parseTempAddress('/s/harbour/areas/leeds'), { slug: 'harbour', rest: 'areas/leeds' });
  assert.equal(parseTempAddress('/s/harbour/robots.txt'), null);
  assert.equal(parseTempAddress('/api/s/harbour/lead'), null);
  assert.equal(parseTempAddress('/harbour'), null);
});
