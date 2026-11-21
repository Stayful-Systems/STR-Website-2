import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAG_PATTERN, TRANSFER_PROVIDERS, isValidTag, normaliseTag, providerByKey, resolveProvider } from './transfer-providers.ts';

test('the four providers carry their IPS tags', () => {
  assert.deepEqual(
    TRANSFER_PROVIDERS.map((p) => [p.name, p.tag]),
    [
      ['123 Reg', '123-REG'],
      ['Namecheap', 'NAMECHEAP-INC'],
      ['IONOS', '1AND1'],
      ['GoDaddy', 'GODADDY'],
    ],
  );
  for (const p of TRANSFER_PROVIDERS) {
    assert.ok(TAG_PATTERN.test(p.tag), p.key);
    assert.match(p.helpUrl, /^https:\/\//);
  }
  assert.equal(new Set(TRANSFER_PROVIDERS.map((p) => p.key)).size, TRANSFER_PROVIDERS.length);
});

test('a known provider uses our tag, whatever else was typed', () => {
  assert.deepEqual(resolveProvider('namecheap', 'evil-tag'), { ok: true, key: 'namecheap', name: 'Namecheap', tag: 'NAMECHEAP-INC' });
  assert.equal(providerByKey('godaddy')?.tag, 'GODADDY');
  assert.equal(providerByKey('nope'), null);
  assert.equal(providerByKey(undefined), null);
});

test('other: the typed tag is trimmed and upper cased', () => {
  assert.equal(normaliseTag('  my-reg '), 'MY-REG');
  assert.deepEqual(resolveProvider('other', '  my-registrar '), { ok: true, key: 'other', name: 'Other', tag: 'MY-REGISTRAR' });
});

test('other: a bad or missing tag is refused', () => {
  for (const bad of ['', ' ', 'A', '-ABC', 'AB CD', 'AB_CD', 'AB.CD', 'A'.repeat(32), undefined, null, 42]) {
    const r = resolveProvider('other', bad);
    assert.equal(r.ok, false, String(bad));
    if (!r.ok) assert.equal(r.code, 'bad_tag');
  }
  assert.equal(isValidTag('AB'), true);
  assert.equal(isValidTag('A'.repeat(31)), true);
  assert.equal(isValidTag('1AND1'), true);
});

test('an unknown provider key is refused', () => {
  for (const k of ['', 'Namecheap', 'bogus', null, undefined, 3]) {
    const r = resolveProvider(k, 'ABC');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, 'unknown_provider');
      assert.ok(r.message.length > 0);
    }
  }
});
