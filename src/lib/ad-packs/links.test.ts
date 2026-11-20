import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANGLES, packCode } from './codes.ts';
import { adLink, adName, cleanMetaAdId, isAdIdPlaceholder } from './links.ts';

test('every link carries ?ad=<CODE> and a literal {{ad.id}}', () => {
  for (const a of ANGLES) {
    const code = packCode('3F9A2C', a, 1);
    const link = adLink({ domain: 'acme-lettings.co.uk', code, operatorCode: '3F9A2C' });
    assert.ok(link.includes(`?ad=${code}&`), link);
    assert.ok(link.endsWith('&utm_content={{ad.id}}'), link);
    assert.ok(!link.includes('%7B'), 'the placeholder must not be percent-encoded');
  }
});

test('the link has the exact shape', () => {
  assert.equal(
    adLink({ domain: 'acme-lettings.co.uk', code: 'SI-3F9A2C-5B-1', operatorCode: '3F9A2C' }),
    'https://acme-lettings.co.uk/?ad=SI-3F9A2C-5B-1&utm_source=facebook&utm_medium=paid_social&utm_campaign=SI-3F9A2C&utm_content={{ad.id}}',
  );
});

test('a lowercase code or a pasted scheme is tidied, a bad one throws', () => {
  assert.equal(
    adLink({ domain: 'https://Acme.co.uk/', code: 'si-3f9a2c-3a-2', operatorCode: '3f9a2c' }),
    'https://acme.co.uk/?ad=SI-3F9A2C-3A-2&utm_source=facebook&utm_medium=paid_social&utm_campaign=SI-3F9A2C&utm_content={{ad.id}}',
  );
  assert.throws(() => adLink({ domain: 'acme', code: 'SI-3F9A2C-5B-1', operatorCode: '3F9A2C' }));
  assert.throws(() => adLink({ domain: 'acme.co.uk', code: 'nope', operatorCode: '3F9A2C' }));
  assert.throws(() => adLink({ domain: 'acme.co.uk', code: 'SI-3F9A2C-5B-1', operatorCode: 'AAAAAA' }));
});

test('the ad name leads with the code and ends with the angle label', () => {
  assert.equal(adName('SI-3F9A2C-5B-1', '5b'), 'SI-3F9A2C-5B-1 · Tenant notice');
  assert.equal(adName('SI-3F9A2C-3A-1', '3a'), 'SI-3F9A2C-3A-1 · Moving abroad');
  assert.equal(adName('si-3f9a2c-17-1', '17'), 'SI-3F9A2C-17-1 · Renting rules changed');
  assert.throws(() => adName('nope', '5b'));
});

test('the untouched placeholder, its encoded form and blanks are placeholders', () => {
  for (const s of ['{{ad.id}}', ' {{ad.id}} ', '%7B%7Bad.id%7D%7D', '%7b%7bad.id%7d%7d', '', '   ', null, undefined]) {
    assert.equal(isAdIdPlaceholder(s), true, String(s));
  }
  for (const s of ['120210000000000001', 'abc']) assert.equal(isAdIdPlaceholder(s), false, s);
});

test('cleanMetaAdId keeps digits only, 30 at most', () => {
  assert.equal(cleanMetaAdId('120210000000000001'), '120210000000000001');
  assert.equal(cleanMetaAdId(' 123 '), '123');
  assert.equal(cleanMetaAdId('1'.repeat(30)), '1'.repeat(30));
  assert.equal(cleanMetaAdId('1'.repeat(31)), null);
  assert.equal(cleanMetaAdId('{{ad.id}}'), null);
  assert.equal(cleanMetaAdId('%7B%7Bad.id%7D%7D'), null);
  assert.equal(cleanMetaAdId(''), null);
  assert.equal(cleanMetaAdId(null), null);
  for (const bad of ['12a3', 'ad_123', '12 3', '-123', '1.5', '１２３']) assert.equal(cleanMetaAdId(bad), null, bad);
});
