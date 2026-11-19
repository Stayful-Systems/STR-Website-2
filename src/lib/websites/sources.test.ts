import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD_CODE_MAX, hasAttribution, landingPath, parseSources } from './sources.ts';

test('utm values, fbclid and the ad code are read from a query', () => {
  const s = parseSources('?utm_source=facebook&utm_medium=paid&utm_campaign=spring&utm_content=test&utm_term=airbnb+host&fbclid=IwAR1&ad=SI-TEST-1', '/s/acme');
  assert.deepEqual(s, {
    utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'spring', utm_content: 'test', utm_term: 'airbnb host',
    fbclid: 'IwAR1', ad_code: 'SI-TEST-1', landing_page: '/s/acme',
  });
  assert.equal(hasAttribution(s), true);
});

test('URLSearchParams and plain objects work the same', () => {
  assert.equal(parseSources(new URLSearchParams('utm_source=g&ad=A1')).utm_source, 'g');
  const o = parseSources({ utm_source: ['x', 'y'], ad: ' B2 ', utm_medium: undefined });
  assert.equal(o.utm_source, 'x');
  assert.equal(o.ad_code, 'B2');
  assert.equal(o.utm_medium, null);
});

test('values are trimmed and empty means null', () => {
  const s = parseSources('utm_source=%20%20&utm_medium=%20cpc%20&ad=');
  assert.equal(s.utm_source, null);
  assert.equal(s.utm_medium, 'cpc');
  assert.equal(s.ad_code, null);
  assert.equal(hasAttribution(parseSources(null, '/s/acme')), false);
});

test('the ad code is 40 characters at most, control characters removed', () => {
  const s = parseSources(`ad=${'a'.repeat(100)}`);
  assert.equal(s.ad_code?.length, AD_CODE_MAX);
  assert.equal(parseSources({ ad: 'A\u0000B\nC' }).ad_code, 'ABC');
  assert.equal(parseSources({ ad: `${'a'.repeat(39)} bbbb` }).ad_code, 'a'.repeat(39));
});

test('the landing page is a path with no query, fragment or origin', () => {
  assert.equal(landingPath('/s/acme/fees?utm_source=x&postcode=LS1'), '/s/acme/fees');
  assert.equal(landingPath('https://stayful.co.uk/s/acme?address=1+High+St#form'), '/s/acme');
  assert.equal(landingPath('https://stayful.co.uk'), '/');
  assert.equal(landingPath('//evil.example/x'), null);
  assert.equal(landingPath('s/acme'), null);
  assert.equal(landingPath(''), null);
  assert.equal(landingPath(undefined), null);
  assert.equal(landingPath(`/${'a'.repeat(300)}`), null);
  assert.ok(!JSON.stringify(parseSources('', '/s/acme?address=10+Downing+Street')).includes('Downing'));
});
