import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Harness } from '../../../lib/ad-packs/test-store.ts';
import type { GenerateInput, GenerateOk } from '../../../lib/ad-packs/generate-core.ts';
import { KEPT_NOTICE, packScreen, regenView } from './state.ts';

const OWNER = '3f9a2c11-1111-4111-8111-111111111111';
const BRAND = { company: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/logo.png', brandColour: '#1F6F5C', feePct: 12 };
const INPUT: GenerateInput = { areaKey: 'NG7', photos: [], brand: { ...BRAND, photoUrl: null }, domain: 'brightstone.co.uk' };

async function made(h: Harness, input: GenerateInput = INPUT) {
  const out = await h.engine.generatePack({ ownerId: OWNER, by: 'operator', input });
  assert.equal(out.ok, true);
  return { out: out as GenerateOk, view: (await h.engine.listPackForOwner(OWNER))! };
}

test('no pack: the start screen; a pack being made is "working" until it is ten minutes old, then it can be started again', async () => {
  const h = harness();
  assert.deepEqual(packScreen(null, h.now.getTime()), { kind: 'start', failedBefore: false });
  const { view } = await made(h);
  await h.store.updatePack(OWNER, view.pack.id, { status: 'generating' });
  const generating = (await h.engine.listPackForOwner(OWNER))!;
  assert.deepEqual(packScreen(generating, h.now.getTime()), { kind: 'working' });
  assert.deepEqual(packScreen(generating, h.now.getTime() + 11 * 60_000), { kind: 'start', failedBefore: true });
});

test('a pack to look at, an approved pack and a pack that failed its checks each get their own screen', async () => {
  const h = harness();
  const { view } = await made(h);
  assert.deepEqual(packScreen(view, h.now.getTime()), { kind: 'preview', notice: null });
  await h.finishVideo(OWNER); // 38b: a pack is approved only with its video ready
  assert.equal((await h.engine.approvePack({ ownerId: OWNER })).ok, true);
  assert.deepEqual(packScreen((await h.engine.listPackForOwner(OWNER))!, h.now.getTime()), { kind: 'approved', notice: null });

  const h2 = harness();
  const failing = await made(h2, { ...INPUT, brand: { ...INPUT.brand, logoUrl: null } });
  assert.equal(failing.out.status, 'checks_failed');
  assert.deepEqual(packScreen(failing.view, h2.now.getTime()), { kind: 'checks_failed' });
});

test('a failed first attempt starts again; a failed regenerate keeps showing the good version, with a line saying so', async () => {
  const h = harness();
  h.renderer.fail = true;
  const first = await h.engine.generatePack({ ownerId: OWNER, by: 'operator', input: INPUT });
  assert.equal(first.ok, false);
  assert.deepEqual(packScreen((await h.engine.listPackForOwner(OWNER))!, h.now.getTime()), { kind: 'start', failedBefore: true });

  const h2 = harness();
  await made(h2);
  await h2.finishVideo(OWNER);
  assert.equal((await h2.engine.approvePack({ ownerId: OWNER })).ok, true);
  h2.renderer.fail = true;
  const again = await h2.engine.generatePack({ ownerId: OWNER, by: 'operator', input: { ...INPUT, brand: { ...INPUT.brand, brandColour: '#223344' } } });
  assert.equal(again.ok, false);
  const view = (await h2.engine.listPackForOwner(OWNER))!;
  assert.equal(view.pack.status, 'failed');
  assert.deepEqual(packScreen(view, h2.now.getTime()), { kind: 'approved', notice: KEPT_NOTICE });
});

test('regenerate: offered only with a free regeneration left AND a changed brand; otherwise the plain reason', async () => {
  const h = harness();
  const { view } = await made(h);
  assert.equal(view.freeRegensLeft, 1);
  // Nothing changed: not offered, and the reason is the sentence the generator gives.
  const same = regenView(view, BRAND);
  assert.equal(same.canRegenerate, false);
  assert.equal(same.left, 1);
  assert.match(same.reason ?? '', /Change your logo, colour, company name, fee, photos or area first/);
  // Each part of the brand counts as a change.
  for (const changed of [{ ...BRAND, company: 'Brightstone Lettings' }, { ...BRAND, brandColour: '#223344' }, { ...BRAND, logoUrl: 'https://cdn.example.test/new.png' }, { ...BRAND, feePct: 10 }, { ...BRAND, logoUrl: null }]) {
    const v = regenView(view, changed);
    assert.equal(v.canRegenerate, true);
    assert.equal(v.reason, null);
  }
  // Whitespace and the case of the colour do not.
  assert.equal(regenView(view, { ...BRAND, company: '  Brightstone   Stays ', brandColour: '#1f6f5c' }).canRegenerate, false);
});

test('regenerate: once the free regeneration is used it is never offered, however much changes, and the reason says so', async () => {
  const h = harness();
  await made(h);
  const re = await h.engine.generatePack({ ownerId: OWNER, by: 'operator', input: { ...INPUT, brand: { ...INPUT.brand, brandColour: '#223344' } } });
  assert.equal(re.ok, true);
  const view = (await h.engine.listPackForOwner(OWNER))!;
  assert.equal(view.freeRegensLeft, 0);
  const v = regenView(view, { ...BRAND, brandColour: '#556677', company: 'Another Name' });
  assert.equal(v.canRegenerate, false);
  assert.equal(v.left, 0);
  assert.equal(v.reason, 'You have used your free regeneration.');
  // Directly after that regenerate the unchanged brand reads as "no change" for the new version.
  assert.equal(regenView({ ...view, freeRegensLeft: 1, pack: { ...view.pack, regenCount: 0 } }, { ...BRAND, brandColour: '#223344' }).canRegenerate, false);
});
