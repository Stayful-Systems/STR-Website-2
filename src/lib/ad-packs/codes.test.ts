import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANGLES, PACK_CODE_MAX, normaliseCode, operatorCode, packCode, parseCode } from './codes.ts';

const OWNER = '3f9a2c11-7b4e-4d2a-9c10-aa55bb66cc77';

test('operator code is the first 6 hex of the owner id, upper case', () => {
  assert.equal(operatorCode(OWNER), '3F9A2C');
  assert.equal(operatorCode(OWNER.toUpperCase()), '3F9A2C');
});

test('a collision takes the next 6 hex, and the next again', () => {
  assert.equal(operatorCode(OWNER, new Set(['3F9A2C'])), '117B4E');
  assert.equal(operatorCode(OWNER, new Set(['3F9A2C', '117B4E'])), '4D2A9C');
  assert.equal(operatorCode(OWNER, new Set(['3f9a2c'])), '117B4E');
});

test('an exhausted owner id and a non-uuid throw clearly', () => {
  const hex = OWNER.replace(/-/g, '').toUpperCase();
  const all = new Set<string>();
  for (let i = 0; i + 6 <= hex.length; i += 6) all.add(hex.slice(i, i + 6));
  assert.throws(() => operatorCode(OWNER, all), /already taken/);
  assert.throws(() => operatorCode('not-a-uuid'), /not a uuid/);
});

test('pack code is SI-<op>-<ANGLE>-<n>, upper case, at most 40 characters', () => {
  assert.equal(packCode('3F9A2C', '5b', 1), 'SI-3F9A2C-5B-1');
  assert.equal(packCode('3f9a2c', '3a', 12), 'SI-3F9A2C-3A-12');
  assert.equal(packCode('3F9A2C', '17', 9999), 'SI-3F9A2C-17-9999');
  for (const a of ANGLES) {
    const c = packCode('3F9A2C', a, 9999);
    assert.ok(c.length <= PACK_CODE_MAX);
    assert.equal(c, c.toUpperCase());
  }
  assert.throws(() => packCode('3F9A2', '5b', 1));
  assert.throws(() => packCode('3F9A2C', '5b', 0));
  assert.throws(() => packCode('3F9A2C', '5b', 1.5));
  assert.throws(() => packCode('3F9A2C', 'x' as never, 1));
});

test('codes round-trip through parseCode and normaliseCode', () => {
  for (const a of ANGLES) {
    const code = packCode('3F9A2C', a, 3);
    assert.deepEqual(parseCode(code), { operatorCode: '3F9A2C', angle: a, n: 3 });
    assert.equal(normaliseCode(code), code);
  }
});

test('lowercase, padded and URL-encoded input normalises to the same code', () => {
  const want = 'SI-3F9A2C-5B-1';
  assert.equal(normaliseCode('si-3f9a2c-5b-1'), want);
  assert.equal(normaliseCode('  SI-3F9A2C-5B-1  '), want);
  assert.equal(normaliseCode('%20si-3f9a2c-5b-1%20'), want);
  assert.equal(normaliseCode('SI-3F9A2C-5B-1\n'), want);
  assert.equal(normaliseCode('SI-3F9A2C- 5B -1'), want);
  assert.equal(normaliseCode('SI–3F9A2C–5B–1'), want);
  assert.equal(normaliseCode('"SI-3F9A2C-5B-1".'), want);
  assert.deepEqual(parseCode(' si-3f9a2c-17-2 '), { operatorCode: '3F9A2C', angle: '17', n: 2 });
});

test('anything that is not a pack code is null', () => {
  for (const bad of ['', '   ', 'SI-3F9A2C-5B', 'SI-3F9A2C-9Z-1', 'SI-3F9A2G-5B-1', 'XX-3F9A2C-5B-1', 'SI-3F9A2C-5B-0', 'SI-3F9A2C-5B-12345', 'SI-3F9A2C-5B-1-9']) {
    assert.equal(normaliseCode(bad), null, bad);
    assert.equal(parseCode(bad), null, bad);
  }
  assert.equal(normaliseCode(null), null);
  assert.equal(normaliseCode(undefined), null);
  assert.equal(normaliseCode(42), null);
});
