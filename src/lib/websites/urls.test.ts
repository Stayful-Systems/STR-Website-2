import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOM_DOMAINS_ON, siteBase, siteDomain, siteHref } from './urls.ts';

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

test('a custom domain is ignored until Batch 33 turns it on', () => {
  assert.equal(CUSTOM_DOMAINS_ON, false);
  const withDomain = { slug: 'acme-lettings', domain: 'www.acme.co.uk' };
  assert.equal(siteDomain(withDomain), null);
  assert.equal(siteBase(withDomain), '/s/acme-lettings');
  assert.equal(siteHref(withDomain, '/fees'), '/s/acme-lettings/fees');
});
