import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD_LIMITS, checkLength, firstSentence, wordCount } from './limits.ts';

test('the constants are the ones Meta and the pack use', () => {
  assert.equal(AD_LIMITS.headline.recommended, 27);
  assert.equal(AD_LIMITS.headline.hard, 40);
  assert.equal(AD_LIMITS.primary.visible, 125);
  assert.equal(AD_LIMITS.primary.hard, 300);
  assert.equal(AD_LIMITS.description.hard, 90);
  assert.equal(AD_LIMITS.description.metaVisible, 30);
});

test('headline: green to 27, amber to 40, red over', () => {
  assert.equal(checkLength('headline', 'a'.repeat(27)).level, 'green');
  assert.equal(checkLength('headline', 'a'.repeat(28)).level, 'amber');
  assert.equal(checkLength('headline', 'a'.repeat(40)).level, 'amber');
  const red = checkLength('headline', 'a'.repeat(41));
  assert.equal(red.level, 'red');
  assert.equal(red.length, 41);
  assert.ok(red.notes.length > 0);
  assert.deepEqual(checkLength('headline', 'Tenant giving notice?').notes, []);
});

test('empty text is red', () => {
  for (const k of ['headline', 'primary', 'description'] as const) {
    assert.equal(checkLength(k, '   ').level, 'red');
    assert.equal(checkLength(k, '').length, 0);
  }
});

test('primary: first sentence within 125 and total within 300 is green', () => {
  const t = 'Is your tenant leaving? Keep the property earning without the void. ' + 'x'.repeat(100);
  const r = checkLength('primary', t);
  assert.ok(r.length > 125 && r.length <= 300);
  assert.equal(r.level, 'green');
});

test('primary: a first sentence over 125 characters is amber, a total over 300 is red', () => {
  const longFirst = 'a'.repeat(130) + '. Short.';
  const amber = checkLength('primary', longFirst);
  assert.equal(amber.level, 'amber');
  assert.ok(amber.notes.some((n) => n.includes('first sentence')));
  assert.equal(checkLength('primary', 'Short one. ' + 'b'.repeat(300)).level, 'red');
  assert.equal(checkLength('primary', 'Short one. ' + 'b'.repeat(289)).level, 'green');
});

test('description: green to 90 with the cut-off caveat past 30, red over 90', () => {
  const short = checkLength('description', 'Keep your property, we run it.');
  assert.equal(short.level, 'green');
  assert.ok(!short.notes.some((n) => n.includes('cut off')));
  const mid = checkLength('description', 'Your tenant is leaving, so let guests stay for days instead of one tenant for years.');
  assert.equal(mid.level, 'green');
  assert.ok(mid.notes.some((n) => n.includes('cut off on some placements past 30')));
  assert.equal(checkLength('description', 'a '.repeat(46).trim()).level, 'red');
});

test('description word count is a note, never a failure', () => {
  const few = checkLength('description', 'Keep it earning.');
  assert.equal(few.level, 'green');
  assert.ok(few.notes.some((n) => n.includes('3 words')));
  const ok = checkLength('description', 'One two three four five six seven eight nine ten.');
  assert.ok(!ok.notes.some((n) => n.includes('words')));
});

test('helpers', () => {
  assert.equal(firstSentence('One. Two.'), 'One.');
  assert.equal(firstSentence('No end here'), 'No end here');
  assert.equal(firstSentence('Is it 3.5 beds? Yes.'), 'Is it 3.5 beds?');
  assert.equal(wordCount('  a  b c '), 3);
  assert.equal(wordCount(''), 0);
});
