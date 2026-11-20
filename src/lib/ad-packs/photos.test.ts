import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPhoto, cleanPhotoRefs, isUploadRef, MAX_PACK_PHOTOS, ownUploadRef, PHOTO_MAX_BYTES, sniffPhoto, uploadRef } from './photos.ts';
import { MAX_PHOTOS } from './generate-core.ts';

const OWNER_A = '3f9a2c11-1111-4111-8111-111111111111';
const OWNER_B = '3f9a2c22-2222-4222-8222-222222222222';
const PHOTO = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

test('the pack photo limit is the generator’s', () => {
  assert.equal(MAX_PACK_PHOTOS, MAX_PHOTOS);
  assert.equal(PHOTO_MAX_BYTES, 5 * 1024 * 1024);
});

test('the first bytes decide: a JPEG or a PNG, nothing else', () => {
  assert.equal(sniffPhoto(PNG), 'png');
  assert.equal(sniffPhoto(JPG), 'jpeg');
  for (const bad of [GIF, WEBP, SVG, new Uint8Array(0), new Uint8Array([1, 2, 3])]) assert.equal(sniffPhoto(bad), null);
  assert.equal(sniffPhoto(null), null);
});

test('checkPhoto: type, size and magic bytes are all checked, and they must agree', () => {
  assert.deepEqual(checkPhoto(JPG, 'image/jpeg'), { ok: true, kind: 'jpeg', ext: 'jpg', contentType: 'image/jpeg' });
  assert.deepEqual(checkPhoto(PNG, 'image/png'), { ok: true, kind: 'png', ext: 'png', contentType: 'image/png' });
  // A lie about the type, or bytes that are not an image, are refused.
  assert.equal(checkPhoto(PNG, 'image/jpeg').ok, false);
  assert.equal(checkPhoto(JPG, 'image/png').ok, false);
  assert.equal(checkPhoto(JPG, 'text/html').ok, false);
  assert.equal(checkPhoto(JPG, '').ok, false);
  assert.equal(checkPhoto(SVG, 'image/jpeg').ok, false);
  assert.equal(checkPhoto(GIF, 'image/png').ok, false);
  assert.equal(checkPhoto(new TextEncoder().encode('<html>not a photo</html>'), 'image/jpeg').ok, false);
  const empty = checkPhoto(new Uint8Array(0), 'image/jpeg');
  assert.equal(empty.ok, false);
  // Size: exactly 5 MB is fine, one byte over is not.
  const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
  big.set(JPG);
  const over = checkPhoto(big, 'image/jpeg');
  assert.equal(over.ok, false);
  assert.match((over as { message: string }).message, /5 MB/);
  const exact = new Uint8Array(PHOTO_MAX_BYTES);
  exact.set(JPG);
  assert.equal(checkPhoto(exact, 'image/jpeg').ok, true);
});

test('upload references live in the owner’s own uploads folder and nowhere else', () => {
  const ref = uploadRef(OWNER_A, PHOTO, 'jpg');
  assert.equal(ref, `${OWNER_A}/uploads/${PHOTO}.jpg`);
  assert.equal(isUploadRef(ref), true);
  assert.equal(ownUploadRef(OWNER_A, ref), true);
  assert.equal(ownUploadRef(OWNER_B, ref), false, 'someone else’s photo is not yours');
  for (const bad of [`${OWNER_A}/${PHOTO}.jpg`, `${OWNER_A}/uploads/../${PHOTO}.jpg`, `${OWNER_A}/uploads/${PHOTO}.gif`, `${OWNER_A}/uploads/x.jpg`, `https://cdn.example.test/${PHOTO}.jpg`, `${OWNER_A}/uploads/${PHOTO}.jpg/extra`, '', `${OWNER_A}/v1/3a-card1-4x5.png`]) {
    assert.equal(isUploadRef(bad), false, bad);
    assert.equal(ownUploadRef(OWNER_A, bad), false, bad);
  }
  assert.equal(ownUploadRef(OWNER_A, 5), false);
});

test('cleanPhotoRefs: only the owner’s, no repeats, at most four; anything else refuses the whole request', () => {
  const mk = (n: number) => uploadRef(OWNER_A, `0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0${n}`, 'jpg');
  assert.deepEqual(cleanPhotoRefs(OWNER_A, undefined), []);
  assert.deepEqual(cleanPhotoRefs(OWNER_A, []), []);
  assert.deepEqual(cleanPhotoRefs(OWNER_A, [mk(1), mk(2), mk(1)]), [mk(1), mk(2)]);
  assert.equal(cleanPhotoRefs(OWNER_A, [mk(1), uploadRef(OWNER_B, PHOTO, 'png')]), null);
  assert.equal(cleanPhotoRefs(OWNER_A, ['https://cdn.example.test/p.jpg']), null);
  assert.equal(cleanPhotoRefs(OWNER_A, 'nope'), null);
  assert.equal(cleanPhotoRefs(OWNER_A, [mk(1), mk(2), mk(3), mk(4), mk(5)]), null);
  assert.equal(cleanPhotoRefs(OWNER_A, [mk(1), mk(2), mk(3), mk(4)])?.length, 4);
});
