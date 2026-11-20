import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VOICE_KEY, VOICES, isVoiceKey, previewUrlFor, voiceById, voiceByKey } from './voices.ts';

test('exactly three voices, unique keys, ids and labels', () => {
  assert.equal(VOICES.length, 3);
  assert.deepEqual(VOICES.map((v) => v.key), ['jane', 'olivia', 'oliver']);
  assert.equal(new Set(VOICES.map((v) => v.key)).size, 3);
  assert.equal(new Set(VOICES.map((v) => v.id)).size, 3);
  assert.equal(new Set(VOICES.map((v) => v.label)).size, 3);
  for (const v of VOICES) {
    assert.match(v.id, /^[A-Za-z0-9]{20}$/);
    assert.ok(v.description.trim().length > 10 && v.description.length <= 100, v.key);
  }
});

test('preview URLs are https mp3 clips', () => {
  for (const v of VOICES) {
    const u = new URL(v.previewUrl);
    assert.equal(u.protocol, 'https:');
    assert.ok(u.pathname.endsWith('.mp3'), v.key);
    assert.ok(u.pathname.includes(v.id), `${v.key}: the preview is of this voice`);
  }
});

test('lookups', () => {
  assert.equal(isVoiceKey('jane'), true);
  assert.equal(isVoiceKey('Jane'), false);
  assert.equal(isVoiceKey(''), false);
  assert.equal(isVoiceKey(null), false);
  assert.equal(isVoiceKey('toString'), false);
  assert.equal(isVoiceKey(DEFAULT_VOICE_KEY), true);
  assert.equal(voiceById('lo1O1Dz1Tu4FWVEPaxuT')?.key, 'oliver');
  assert.equal(voiceById('nope'), null);
  assert.equal(voiceById(undefined), null);
  assert.equal(voiceByKey('olivia')?.id, 'NbkKnEAZ7Bqw4EAkVEaz');
  assert.equal(voiceByKey('x'), null);
  assert.equal(previewUrlFor('jane'), VOICES[0].previewUrl);
  assert.equal(previewUrlFor('x'), null);
});

test('no source-brand words in the operator-facing text', () => {
  for (const v of VOICES) assert.doesNotMatch(`${v.label} ${v.description}`, /stayful/i);
});
