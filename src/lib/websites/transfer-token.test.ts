import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSFER_TOKEN_TTL_SECONDS, signTransferToken, verifyTransferToken } from './transfer-token.ts';

const KEY = 'test-signing-key-0123456789abcdef';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-21T10:00:00.000Z');
const at = (s: number) => new Date(NOW.getTime() + s * 1000);

test('round trip: the token names the transfer it was signed for', () => {
  const token = signTransferToken(ID, NOW, { key: KEY });
  assert.ok(token);
  assert.equal(verifyTransferToken(token, NOW, { key: KEY }), ID);
});

test('valid for 15 minutes and not a second more', () => {
  assert.equal(TRANSFER_TOKEN_TTL_SECONDS, 15 * 60);
  const token = signTransferToken(ID, NOW, { key: KEY });
  assert.equal(verifyTransferToken(token, at(TRANSFER_TOKEN_TTL_SECONDS), { key: KEY }), ID);
  assert.equal(verifyTransferToken(token, at(TRANSFER_TOKEN_TTL_SECONDS + 1), { key: KEY }), null);
  assert.equal(verifyTransferToken(token, at(86400), { key: KEY }), null);
});

test('a wrong key, a swapped id, a changed expiry or signature is refused', () => {
  const token = signTransferToken(ID, NOW, { key: KEY })!;
  const [, exp, sig] = token.split('.');
  assert.equal(verifyTransferToken(token, NOW, { key: KEY + 'x' }), null);
  assert.equal(verifyTransferToken(`${OTHER}.${exp}.${sig}`, NOW, { key: KEY }), null);
  assert.equal(verifyTransferToken(`${ID}.${Number(exp) + 600}.${sig}`, NOW, { key: KEY }), null);
  assert.equal(verifyTransferToken(`${ID}.${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, NOW, { key: KEY }), null);
  assert.equal(verifyTransferToken(`${ID}.${exp}.${sig}x`, NOW, { key: KEY }), null);
});

test('malformed input never throws and is refused', () => {
  for (const bad of [undefined, null, 42, {}, '', 'a.b', 'a.b.c.d', `${ID}..sig`, `${ID}.abc.sig`, `${ID}.${'9'.repeat(20)}.sig`, 'x'.repeat(500)]) {
    assert.equal(verifyTransferToken(bad, NOW, { key: KEY }), null, String(bad));
  }
  assert.equal(signTransferToken('not-a-uuid', NOW, { key: KEY }), null);
});

test('no key means no token, and no verification', () => {
  const saved = [process.env.DEALS_PHOTO_SECRET, process.env.INTERNAL_API_SECRET];
  try {
    delete process.env.DEALS_PHOTO_SECRET;
    delete process.env.INTERNAL_API_SECRET;
    assert.equal(signTransferToken(ID, NOW), null);
    const token = signTransferToken(ID, NOW, { key: KEY });
    assert.equal(verifyTransferToken(token, NOW), null);
    assert.equal(signTransferToken(ID, NOW, { key: '' }), null);

    process.env.INTERNAL_API_SECRET = 'short';
    assert.equal(signTransferToken(ID, NOW), null, 'a short key is no key');

    process.env.INTERNAL_API_SECRET = KEY;
    const fromEnv = signTransferToken(ID, NOW);
    assert.ok(fromEnv);
    assert.equal(verifyTransferToken(fromEnv, NOW), ID);
    assert.equal(fromEnv, token, 'same HMAC as an explicit key');
  } finally {
    if (saved[0] === undefined) delete process.env.DEALS_PHOTO_SECRET;
    else process.env.DEALS_PHOTO_SECRET = saved[0];
    if (saved[1] === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = saved[1];
  }
});
