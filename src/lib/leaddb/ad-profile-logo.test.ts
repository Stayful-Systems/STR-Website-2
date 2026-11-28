import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLogo, type FetchLike } from './ad-profile-logo.ts';

/** Batch 55 step 5 (55c A1): the logo is copied once from the pushed link, sniffed like an upload, with a size cap. */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const URL_OK = 'https://store.example.test/sign/logo.png?token=t1';

const serve = (bytes: Uint8Array, init: ResponseInit = {}): FetchLike => async () => new Response(bytes.slice().buffer as ArrayBuffer, { status: 200, ...init });

test('a PNG or a JPEG is copied, with its type and a hash of its bytes', async () => {
  const png = await fetchLogo(URL_OK, { fetch: serve(PNG) });
  assert.ok(png.ok && png.mime === 'image/png' && png.bytes.byteLength === PNG.byteLength && /^[0-9a-f]{64}$/.test(png.sha256));
  const jpg = await fetchLogo(URL_OK, { fetch: serve(JPEG) });
  assert.ok(jpg.ok && jpg.mime === 'image/jpeg');
});

test('dead, not an image, empty, too big, or not a safe https link: a code, and nothing else', async () => {
  assert.deepEqual(await fetchLogo(URL_OK, { fetch: async () => new Response('', { status: 404 }) }), { ok: false, code: 'fetch_failed' });
  assert.deepEqual(await fetchLogo(URL_OK, { fetch: async () => { throw new Error('boom'); } }), { ok: false, code: 'fetch_failed' });
  assert.deepEqual(await fetchLogo(URL_OK, { fetch: serve(new TextEncoder().encode('<svg xmlns="x"></svg>')) }), { ok: false, code: 'not_image' });
  assert.deepEqual(await fetchLogo(URL_OK, { fetch: serve(new Uint8Array(0)) }), { ok: false, code: 'not_image' });
  assert.deepEqual(await fetchLogo(URL_OK, { fetch: serve(PNG, { headers: { 'content-length': String(10 * 1024 * 1024) } }) }), { ok: false, code: 'too_big' });
  const big = new Uint8Array(64);
  big.set(PNG);
  assert.deepEqual(await fetchLogo(URL_OK, { fetch: serve(big), maxBytes: 32 }), { ok: false, code: 'too_big' }, 'the cap holds without a content-length');
  let called = false;
  const spy: FetchLike = async () => {
    called = true;
    return new Response(PNG.slice().buffer as ArrayBuffer);
  };
  assert.deepEqual(await fetchLogo('http://store.example.test/logo.png', { fetch: spy }), { ok: false, code: 'bad_url' });
  assert.deepEqual(await fetchLogo('https://169.254.169.254/latest', { fetch: spy }), { ok: false, code: 'bad_url' });
  assert.equal(called, false, 'an unsafe link is never fetched');
});
