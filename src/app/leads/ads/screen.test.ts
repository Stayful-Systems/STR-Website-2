import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Batch 36 phase 8: the screen's wiring, in the repo's source-pin style (the
 * page, the client component and the server actions need a session, a browser
 * and a database). The rules themselves are tested in ops.test.ts, view.test.ts
 * and state.test.ts.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const actions = code(read('./actions.ts'));
const client = code(read('./AdPackClient.tsx'));
const page = code(read('./page.tsx'));

test('actions.ts is a server-actions file that only exports async functions, each a thin wrapper over ops.ts', () => {
  assert.match(read('./actions.ts'), /^'use server';/);
  const exports = [...actions.matchAll(/^export (\w+)/gm)].map((m) => m[1]);
  assert.ok(exports.length >= 6);
  assert.ok(exports.every((e) => e === 'async'), `only async functions are exported, got ${exports.join(', ')}`);
  for (const op of ['generateOp', 'approveOp', 'downloadOp', 'copyOp', 'uploadPhotoOp', 'areaPreviewOp']) assert.match(actions, new RegExp(`${op}\\(liveDeps\\(\\)`), op);
  // The owner is the session's: no action reads an owner, user or brand from the form.
  assert.doesNotMatch(actions, /formData\.get\('(owner|user|member|brand|domain|company|website)/i);
  assert.match(actions, /ownerIdOrNull\(user\)/);
  assert.match(actions, /isAdminEmail\(user\.email\)/);
});

test('the copy log is handed the ad id, the kind and the position, never a text', () => {
  const fn = actions.slice(actions.indexOf('export async function recordCopyAction'));
  assert.match(fn, /recordCopyAction\(adId: string, kind: string, index: number\)/);
  assert.match(fn, /copyOp\(liveDeps\(\), \{ adId, kind, index \}\)/);
  assert.doesNotMatch(client, /recordCopyAction\([^)]*\.text/);
  assert.match(client, /recordCopyAction\(adId, item\.kind, item\.index\)/);
});

test('copy is instant: the clipboard first, the log after it and not waited for', () => {
  const fn = client.slice(client.indexOf('async function copy()'), client.indexOf('return (', client.indexOf('async function copy()')));
  assert.ok(fn.indexOf('navigator.clipboard.writeText(item.text)') >= 0);
  assert.ok(fn.indexOf('navigator.clipboard.writeText') < fn.indexOf('recordCopyAction'), 'clipboard before the log');
  assert.match(fn, /void recordCopyAction\(/);
  assert.doesNotMatch(fn, /await recordCopyAction/);
  assert.match(fn, /\.catch\(/);
  // The text is copied exactly as stored.
  assert.doesNotMatch(client, /item\.text\.trim\(\)|writeText\([^)]*trim/);
});

test('the page is the owner’s only, eligibility decides what it shows, and the admin preview passes admin through', () => {
  assert.match(page, /ownerIdOrNull\(user\)/);
  assert.match(page, /redirect\("\/leads"\)/);
  assert.match(page, /packEligibility\(user\.id, \{ admin \}\)/);
  assert.match(page, /isAdminEmail\(user\.email\)/);
  assert.match(page, /listPackForOwner\(ownerId\)/, 'the pack is read for the session’s owner id');
  assert.doesNotMatch(page, /searchParams|params\b/, 'nothing in the address chooses whose pack is shown');
  assert.match(page, /export const maxDuration = 60/);
});

test('the page leaves a place for the setup guide, and shows the video slot and the labelled figure', () => {
  assert.match(page, /id="guide"/);
  assert.match(page, /href="#guide"/);
  assert.match(page, /figureCallout\(pack\.figures\)/);
  assert.match(read('./AdSection.tsx'), /ad\.videoText/);
});

test('the form: the area pick list, photos up to four, a Generate button and the type-only tick only without a logo', () => {
  assert.match(client, /Confirm your main area/);
  assert.match(client, /MAX_PHOTOS = 4/);
  assert.match(client, /accept="image\/jpeg,image\/png"/);
  assert.match(client, /name="photoRef"/);
  assert.match(client, /name="typeOnly"/);
  assert.match(client, /!p\.hasLogo/);
  assert.match(client, /Make my ads/);
  assert.match(client, /Approve my ads/);
});

test('the entry card is for an account owner only, inside Suspense, with no new nav item', () => {
  const leads = code(read('../page.tsx'));
  assert.match(leads, /isOwner \? <Suspense fallback=\{null\}><AdPackEntryCard userId=\{user\.id\} \/><\/Suspense> : null/);
  assert.doesNotMatch(read('../LeadsNav.tsx'), /leads\/ads/);
  const entry = code(read('../../../lib/ad-packs/entry-server.ts'));
  assert.ok(entry.indexOf('readAdPacksEnabled()') < entry.indexOf('packEligibility('), 'the switch is read first: off means one tiny query');
  assert.match(entry, /catch \{\s*return false;/, 'it fails closed');
});

test('the generator reads an operator’s stored photos from the bucket, and the fonts are still traced for this page', () => {
  assert.match(code(read('../../../lib/ad-packs/generate-server.ts')), /fetchImage: adPackFetchImage/);
  assert.match(read('../../../../next.config.ts'), /"\/leads\/ads": AD_PACK_FONTS/);
});

test('the kinds the screen logs are registered', async () => {
  const { isActivityKind } = await import('../../../lib/activity/kinds.ts');
  assert.equal(isActivityKind('ad_pack_approved'), true);
  assert.equal(isActivityKind('ad_text_copied'), true);
  assert.match(actions, /liveDeps/);
});
