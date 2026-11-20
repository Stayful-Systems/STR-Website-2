import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOM_DOMAINS_ON, siteAbsoluteUrl, siteBase, siteDomain, siteHref } from './urls.ts';

const site = { slug: 'acme-lettings' };

test('the base is /s/<slug> today', () => {
  assert.equal(siteBase(site), '/s/acme-lettings');
  assert.equal(siteHref(site), '/s/acme-lettings');
  assert.equal(siteHref(site, '/'), '/s/acme-lettings');
});

test('pages sit under the base, with or without the leading slash', () => {
  assert.equal(siteHref(site, 'fees'), '/s/acme-lettings/fees');
  assert.equal(siteHref(site, '/fees'), '/s/acme-lettings/fees');
  assert.equal(siteHref(site, '/areas/leeds'), '/s/acme-lettings/areas/leeds');
  assert.equal(siteHref(site, '/fees?ad=X1#top'), '/s/acme-lettings/fees?ad=X1#top');
  assert.equal(siteHref(site, '?ad=X1'), '/s/acme-lettings?ad=X1');
});

test('a link can never leave the site', () => {
  assert.equal(siteHref(site, '//evil.example'), '/s/acme-lettings/evil.example');
  assert.equal(siteHref(site, 'https://evil.example/x'), '/s/acme-lettings');
  assert.equal(siteHref(site, 'javascript:alert(1)'), '/s/acme-lettings');
});

test('custom domains are on (Batch 33): a site with its own domain is addressed at the domain root', () => {
  assert.equal(CUSTOM_DOMAINS_ON, true);
  const withDomain = { slug: 'acme-lettings', domain: 'acmemanagement.co.uk' };
  assert.equal(siteDomain(withDomain), 'acmemanagement.co.uk');
  assert.equal(siteBase(withDomain), '');
  assert.equal(siteHref(withDomain), '/');
  assert.equal(siteHref(withDomain, '/fees'), '/fees');
  assert.equal(siteHref(withDomain, '/areas/leeds'), '/areas/leeds');
  assert.equal(siteHref(withDomain, '?ad=X1'), '/?ad=X1');
  assert.equal(siteHref(withDomain, '//evil.example'), '/evil.example');
  assert.equal(siteHref(withDomain, 'https://evil.example/x'), '/');
});

test('a site with no domain, or a domain that is not a plain <label>.co.uk, keeps the temporary address', () => {
  for (const domain of [null, undefined, '', '  ', 'evil.com', 'www.acme.co.uk', 'a.b.co.uk', 'acme.co.uk/x', 'https://acme.co.uk', '-x.co.uk', 'ac me.co.uk']) {
    const s = { slug: 'acme-lettings', domain };
    assert.equal(siteDomain(s), null, String(domain));
    assert.equal(siteBase(s), '/s/acme-lettings', String(domain));
    assert.equal(siteHref(s, '/fees'), '/s/acme-lettings/fees', String(domain));
  }
  assert.equal(siteDomain({ slug: 'a-b-c', domain: ' ACME.co.uk ' }), 'acme.co.uk');
});

test('siteAbsoluteUrl: the domain when the site has one, the app address when it has not, and {slug} only is always the temporary address', () => {
  const was = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = 'https://www.stayful.example';
  try {
    const own = { slug: 'acme-lettings', domain: 'acmemanagement.co.uk' };
    assert.equal(siteAbsoluteUrl(own), 'https://acmemanagement.co.uk/');
    assert.equal(siteAbsoluteUrl(own, '/fees'), 'https://acmemanagement.co.uk/fees');
    assert.equal(siteAbsoluteUrl(own, 'areas/leeds'), 'https://acmemanagement.co.uk/areas/leeds');
    assert.equal(siteAbsoluteUrl({ slug: 'acme-lettings' }), 'https://www.stayful.example/s/acme-lettings');
    assert.equal(siteAbsoluteUrl({ slug: 'acme-lettings' }, '/fees'), 'https://www.stayful.example/s/acme-lettings/fees');
    assert.equal(siteAbsoluteUrl({ slug: 'acme-lettings', domain: null }, '/fees'), 'https://www.stayful.example/s/acme-lettings/fees');
    assert.equal(siteAbsoluteUrl({ slug: 'acme-lettings', domain: 'evil.com' }, '/fees'), 'https://www.stayful.example/s/acme-lettings/fees');
    // Go-live checks the temporary address by passing the slug only, even for a site that has a domain.
    const { slug } = own;
    assert.equal(siteAbsoluteUrl({ slug }, '/fees'), 'https://www.stayful.example/s/acme-lettings/fees');
  } finally {
    if (was === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = was;
  }
});
