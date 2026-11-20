import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANGLES } from './codes.ts';
import { brandHash, estimateRawPence, estimateVideoPence, type BrandHashInput, GENERATE_CODES, generateMessage, plannedImageNames, type GenerateInput, type GenerateOk, type GenerateResult } from './generate-core.ts';
import { harness, MemoryAdPackStore, type Harness } from './test-store.ts';
import { PackConflict } from './store-types.ts';
import { loadImagesModule } from './images-test-support.ts';

/**
 * Batch 38 phase 6: the pack generator, on the in-memory store with a fake
 * renderer, uploader and market data (no database, no network, no server-only).
 */

const OWNER_A = '3f9a2c11-1111-4111-8111-111111111111';
// Same first six hex characters as A: its operator code must move on to the next six.
const OWNER_B = '3f9a2c22-2222-4222-8222-222222222222';

function input(over: Partial<GenerateInput> = {}): GenerateInput {
  return {
    areaKey: 'NG7',
    photos: ['https://cdn.example.test/photo-1.jpg'],
    brand: { company: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/logo.png', brandColour: '#1F6F5C', feePct: 12, areas: ['Nottingham'], photoUrl: null },
    domain: 'brightstone.co.uk',
    websiteId: '00000000-0000-4000-8000-0000000000aa',
    ...over,
  };
}

function withBrand(over: Partial<GenerateInput['brand']>): GenerateInput {
  const base = input();
  return { ...base, brand: { ...base.brand, ...over } };
}

function ok(r: GenerateResult): GenerateOk {
  assert.ok(r.ok && !r.dry, `expected a made pack, got ${JSON.stringify(r.ok ? { dry: true } : { code: r.code })}`);
  return r as GenerateOk;
}

function code(r: GenerateResult): string {
  assert.equal(r.ok, false, 'expected a refusal');
  return (r as { code: string }).code;
}

/** What the video (voiceover + sandbox) adds to every estimate with the default settings, read from a dry run. */
async function videoPence(): Promise<number> {
  const r = await harness().engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input() });
  assert.ok(r.ok && r.dry && r.plan);
  return r.ok && r.dry && r.plan ? r.plan.estimatedCostPence : 0;
}

async function first(h: Harness, owner = OWNER_A, over: Partial<GenerateInput> = {}) {
  return ok(await h.engine.generatePack({ ownerId: owner, by: 'operator', input: input(over) }));
}

// ── The first pack ──

test('the first pack: three ads with codes SI-<op>-5B-1 / 3A-1 / 17-1, every link tagged, status preview', async () => {
  const h = harness();
  const r = await first(h);
  assert.equal(r.status, 'preview');
  assert.equal(r.version, 1);
  assert.equal(r.operatorCode, '3F9A2C');
  assert.deepEqual(r.ads.map((a) => a.code), ['SI-3F9A2C-5B-1', 'SI-3F9A2C-3A-1', 'SI-3F9A2C-17-1']);
  assert.deepEqual(r.ads.map((a) => a.adName), ['SI-3F9A2C-5B-1 · Tenant notice', 'SI-3F9A2C-3A-1 · Moving abroad', 'SI-3F9A2C-17-1 · Renting rules changed']);
  for (const a of r.ads) {
    assert.ok(a.link.startsWith('https://brightstone.co.uk/?ad='), a.link);
    assert.ok(a.link.includes(`ad=${a.code}`));
    assert.ok(a.link.includes('utm_source=facebook&utm_medium=paid_social&utm_campaign=SI-3F9A2C'));
    assert.ok(a.link.endsWith('utm_content={{ad.id}}'), 'the placeholder stays literal');
  }
  assert.equal(r.checks.ok, true, JSON.stringify(r.checks.failures));

  const pack = await h.store.getPack(OWNER_A);
  assert.ok(pack);
  assert.equal(pack.status, 'preview');
  assert.equal(pack.version, 1);
  assert.equal(pack.areaKey, 'NG7');
  assert.equal(pack.areaLabel, 'Lenton, Nottingham');
  assert.equal(pack.bedrooms, 3);
  assert.equal(pack.regenCount, 0);
  assert.ok(pack.brandHash && pack.generatedAt && pack.errorCode === null);
  assert.deepEqual(pack.photos, ['https://cdn.example.test/photo-1.jpg']);
  assert.equal((pack.figures ?? []).length, 1);
});

test('the 5b ad has texts, code, link and script and a video slot that is "queued"; 3a and 17 have image files', async () => {
  const h = harness();
  const r = await first(h);
  const ads = await h.store.listAds(OWNER_A, r.packId);
  const byAngle = Object.fromEntries(ads.map((a) => [a.angle, a]));
  const b = byAngle['5b'];
  assert.equal(b.texts.primary.length, 5);
  assert.equal(b.texts.headlines.length, 5);
  assert.equal(b.texts.descriptions.length, 5);
  assert.ok(b.texts.script && b.texts.script.length > 100);
  assert.deepEqual(b.files, { images: [], video: { status: 'queued' } });
  assert.ok(b.leadForm.length > 0);
  for (const angle of ['3a', '17'] as const) {
    const a = byAngle[angle];
    assert.equal(a.files.video, null);
    assert.ok(a.files.images.length > 0 && a.files.images.length % 3 === 0, 'every card at three sizes');
    assert.equal((a.texts.cardsText ?? []).length, a.files.images.length / 3);
    for (const f of a.files.images) {
      assert.equal(f.path, `${OWNER_A}/${r.packId}/v1/${f.name}`);
      assert.equal(f.contentType, 'image/png');
      assert.ok(h.uploader.files.has(f.path), 'uploaded under <owner>/<pack>/v<n>/<name>');
    }
    assert.deepEqual(a.files.images.map((f) => `${f.width}x${f.height}`).filter((v, i, all) => all.indexOf(v) === i).sort(), ['1080x1080', '1080x1350', '1080x1920']);
  }
  assert.equal(h.renderer.calls.length, 2, 'only 3a and 17 are rendered');
  assert.equal(h.uploader.calls, byAngle['3a'].files.images.length + byAngle['17'].files.images.length);
});

test('nothing from the source brand reaches a stored text, and the example figure is the area’s own', async () => {
  const h = harness();
  const r = await first(h);
  const ads = await h.store.listAds(OWNER_A, r.packId);
  const blob = JSON.stringify(ads.map((a) => [a.texts, a.link, a.adName]));
  assert.ok(!/stay\s?ful/i.test(blob));
  for (const n of ['2,399', '1,349', '3,097', '7,681', '939']) assert.ok(!blob.includes(n), n);
  assert.ok(blob.includes('Example: a typical 3-bed in Lenton, Nottingham, from 14 reports. Every property is different.'));
});

test('one pack per owner: a second insert for the owner is a conflict, and a second generate reuses the pack', async () => {
  const h = harness();
  await first(h);
  await assert.rejects(h.store.insertPack({ ownerId: OWNER_A, websiteId: null, operatorCode: 'ABCDEF', status: 'draft' }), (e: unknown) => e instanceof PackConflict && e.which === 'owner');
  const again = await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() });
  assert.equal(code(again), 'no_brand_change');
  assert.equal(h.store.packs.size, 1);
});

// ── Operator codes ──

test('the operator code is the first six hex of the owner id; a second owner with the same six gets the next six', async () => {
  const h = harness();
  const a = await first(h, OWNER_A);
  const b = await first(h, OWNER_B);
  assert.equal(a.operatorCode, '3F9A2C');
  assert.equal(b.operatorCode, '222222');
  assert.ok(b.ads.every((x) => x.code.startsWith('SI-222222-')));
});

test('a unique-column clash on the operator code retries with the next six', async () => {
  class RacyStore extends MemoryAdPackStore {
    reads = 0;
    override async takenOperatorCodes() {
      this.reads++;
      // The first look misses the other owner's code (a race); later looks see it.
      return this.reads === 1 ? new Set<string>() : super.takenOperatorCodes();
    }
  }
  const h = harness();
  const racy = new RacyStore();
  racy.clock = () => h.now;
  h.deps.store = racy;
  const engine = (await import('./generate-core.ts')).createAdPackEngine(h.deps);
  await racy.insertPack({ ownerId: OWNER_A, websiteId: null, operatorCode: '3F9A2C', status: 'draft' });
  const r = ok(await engine.generatePack({ ownerId: OWNER_B, by: 'operator', input: input() }));
  assert.equal(r.operatorCode, '222222');
  assert.ok(racy.reads >= 2);
});

test('two generations started together for a new owner: one runs, the other is "in_progress"', async () => {
  const h = harness();
  const [x, y] = await Promise.all([
    h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }),
    h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }),
  ]);
  const codes = [x, y].map((r) => (r.ok ? 'ok' : r.code)).sort();
  assert.deepEqual(codes, ['in_progress', 'ok']);
  assert.equal(h.store.packs.size, 1);
  assert.equal(h.store.ads.size, 3);
});

// ── Regenerating ──

test('an operator regenerate is refused without a brand change, and nothing is written, rendered or uploaded', async () => {
  const h = harness();
  await first(h);
  const writes = h.store.writes.length;
  const uploads = h.uploader.calls;
  const renders = h.renderer.calls.length;
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() });
  assert.equal(code(r), 'no_brand_change');
  assert.equal(h.store.writes.length, writes);
  assert.equal(h.uploader.calls, uploads);
  assert.equal(h.renderer.calls.length, renders);
  // Whitespace and the case of the colour are not a change.
  const same = await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ company: '  Brightstone   Stays ', brandColour: '#1f6f5c' }) });
  assert.equal(code(same), 'no_brand_change');
});

test('after a brand change the free regenerate is version 2: -2 codes, version 1’s ads superseded, old codes still stored', async () => {
  const h = harness();
  const v1 = await first(h);
  const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ brandColour: '#C2410C' }) }));
  assert.equal(r.version, 2);
  assert.equal(r.regenerate, true);
  assert.equal(r.regenCount, 1);
  assert.deepEqual(r.ads.map((a) => a.code), ['SI-3F9A2C-5B-2', 'SI-3F9A2C-3A-2', 'SI-3F9A2C-17-2']);
  assert.ok(r.ads.every((a) => a.link.includes(`ad=${a.code}`)));
  const all = await h.store.listAds(OWNER_A, r.packId);
  assert.equal(all.length, 6);
  const old = all.filter((a) => a.version === 1);
  assert.deepEqual(old.map((a) => a.code).sort(), v1.ads.map((a) => a.code).sort(), 'the old codes stay valid');
  assert.ok(old.every((a) => a.supersededAt !== null));
  assert.ok(all.filter((a) => a.version === 2).every((a) => a.supersededAt === null));
  const pack = await h.store.getPack(OWNER_A);
  assert.equal(pack?.version, 2);
  assert.equal(pack?.regenCount, 1);
  // The read model shows version 2 and lists the old codes as older.
  const view = await h.engine.listPackForOwner(OWNER_A);
  assert.ok(view);
  assert.deepEqual(view.ads.map((a) => a.code), ['SI-3F9A2C-5B-2', 'SI-3F9A2C-3A-2', 'SI-3F9A2C-17-2']);
  assert.equal(view.olderCodes.length, 3);
  assert.equal(view.freeRegensLeft, 0);
  assert.equal(view.showAds, true);
});

test('after the free regenerate is used, another one is refused even with a brand change', async () => {
  const h = harness();
  await first(h);
  ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ brandColour: '#C2410C' }) }));
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ brandColour: '#1E3A8A' }) });
  assert.equal(code(r), 'regen_used');
  assert.equal((await h.store.getPack(OWNER_A))?.version, 2);
  // With the setting raised to 2 the same request works.
  h.store.settings.freeRegens = 2;
  const again = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ brandColour: '#1E3A8A' }) }));
  assert.equal(again.version, 3);
  // With 0 free regenerations the first regenerate is refused.
  const g = harness();
  g.store.settings.freeRegens = 0;
  await first(g);
  assert.equal(code(await g.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ brandColour: '#C2410C' }) })), 'regen_used');
});

test('an admin regenerate is unlimited, needs no brand change and never counts toward regen_count', async () => {
  const h = harness();
  await first(h);
  ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ brandColour: '#C2410C' }) }));
  assert.equal((await h.store.getPack(OWNER_A))?.regenCount, 1);
  for (let v = 3; v <= 5; v++) {
    const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() }));
    assert.equal(r.version, v);
    assert.equal(r.regenCount, 1, 'unchanged');
  }
  const pack = await h.store.getPack(OWNER_A);
  assert.equal(pack?.regenCount, 1);
  assert.equal(pack?.version, 5);
  assert.deepEqual(h.store.runs.map((r) => r.by), ['operator', 'operator', 'admin', 'admin', 'admin']);
});

test('regenerating an approved pack follows the same rule and needs approving again', async () => {
  const h = harness();
  await first(h);
  await h.finishVideo(OWNER_A);
  assert.equal((await h.engine.approvePack({ ownerId: OWNER_A })).ok, true);
  assert.equal((await h.store.getPack(OWNER_A))?.status, 'approved');
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() })), 'no_brand_change');
  ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ company: 'Brightstone Lettings' }) }));
  const pack = await h.store.getPack(OWNER_A);
  assert.equal(pack?.status, 'preview');
  assert.ok(pack?.approvedAt, 'a regenerate keeps the first approval time, so the ads already running keep linking leads');
});

// ── Dry run ──

test('a dry run for a new owner returns the whole plan and writes nothing at all', async () => {
  const h = harness();
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input() });
  assert.ok(r.ok && r.dry);
  if (!r.ok || !r.dry) return;
  assert.equal(r.wouldBlock, null);
  assert.ok(r.plan);
  assert.equal(r.plan.version, 1);
  assert.equal(r.plan.operatorCode, '3F9A2C');
  // 38b: the estimate is the voiceover plus the render sandbox at its time limit (images cost nothing).
  const planLines = (r.plan.ads[0].texts.script ?? '').split(/\n\s*\n/);
  assert.equal(r.plan.estimatedCostPence, estimateVideoPence({ lines: planLines, voiceKey: 'jane', maxSeconds: 300, vcpus: 2 }));
  assert.ok(r.plan.estimatedCostPence > 0 && r.plan.estimatedCostPence < 100);
  assert.equal(r.plan.voiceKey, 'jane');
  assert.deepEqual(r.plan.ads.map((a) => a.code), ['SI-3F9A2C-5B-1', 'SI-3F9A2C-3A-1', 'SI-3F9A2C-17-1']);
  assert.ok(r.plan.ads.every((a) => a.adName.startsWith(a.code) && a.link.includes(`ad=${a.code}`)));
  assert.ok(r.plan.ads[0].texts.script);
  assert.equal(r.plan.ads[0].video, 'coming');
  assert.ok(r.plan.ads[1].files.length > 0 && r.plan.ads[1].files[0].path.startsWith(`${OWNER_A}/<pack>/v1/3a-card1-`));
  assert.equal(r.plan.checks.ok, true);
  // Nothing was written, rendered or uploaded.
  assert.deepEqual(h.store.writes, []);
  assert.equal(h.store.packs.size, 0);
  assert.equal(h.store.ads.size, 0);
  assert.equal(h.store.runs.length, 0);
  assert.equal(h.uploader.calls, 0);
  assert.equal(h.uploader.files.size, 0);
  assert.equal(h.renderer.calls.length, 0);
});

test('a dry run on an existing pack reports the rule that would block an operator, and nothing else changes', async () => {
  const h = harness();
  await first(h);
  const before = JSON.stringify([...h.store.packs.values(), ...h.store.ads.values(), h.store.runs]);
  const writes = h.store.writes.length;
  const uploads = h.uploader.calls;
  const operator = await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', dry: true, input: input() });
  assert.ok(operator.ok && operator.dry);
  if (operator.ok && operator.dry) {
    assert.equal(operator.wouldBlock?.code, 'no_brand_change');
    assert.equal(operator.plan?.version, 2);
    assert.equal(operator.plan?.regenerate, true);
    assert.ok(operator.plan?.ads[0].files.length === 0 && operator.plan?.ads[1].files[0].path.includes(`/v2/`));
  }
  const admin = await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input() });
  assert.ok(admin.ok && admin.dry && admin.wouldBlock === null);
  assert.equal(h.store.writes.length, writes);
  assert.equal(h.uploader.calls, uploads);
  assert.equal(JSON.stringify([...h.store.packs.values(), ...h.store.ads.values(), h.store.runs]), before);
});

test('a dry run names the cost guard that would stop it, and its plan matches the real run', async () => {
  const h = harness({ pricing: { estimate: () => 600, actual: () => 0 } });
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input() });
  assert.ok(r.ok && r.dry);
  if (r.ok && r.dry) {
    assert.equal(r.wouldBlock?.code, 'cost_cap');
    assert.equal(r.plan?.estimatedCostPence, 600 + (await videoPence()));
  }
  const g = harness();
  const dry = await g.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input() });
  const real = ok(await g.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() }));
  assert.ok(dry.ok && dry.dry && dry.plan);
  if (dry.ok && dry.dry && dry.plan) {
    assert.deepEqual(dry.plan.ads.map((a) => [a.code, a.adName, a.link]), real.ads.map((a) => [a.code, a.adName, a.link]));
    const stored = await g.store.listAds(OWNER_A, real.packId);
    for (const ad of dry.plan.ads) {
      const s = stored.find((x) => x.code === ad.code);
      assert.deepEqual(ad.files.map((f) => f.name), (s?.files.images ?? []).map((f) => f.name), 'planned file names are the real ones');
      assert.deepEqual(ad.texts, s?.texts);
    }
  }
});

test('a dry run for thin data says so and writes nothing', async () => {
  const h = harness();
  h.area.result = { error: 'not_enough_data' };
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input() });
  assert.ok(r.ok && r.dry);
  if (r.ok && r.dry) {
    assert.equal(r.wouldBlock?.code, 'not_enough_data');
    assert.equal(r.plan, null);
  }
  assert.deepEqual(h.store.writes, []);
});

// ── Cost ──

test('the run row carries the cost; the pack keeps the running total', async () => {
  const h = harness({ pricing: { estimate: () => 40, actual: () => 35 } });
  const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }));
  assert.equal(r.costPence, 35);
  assert.equal(h.store.runs.length, 1);
  const run = h.store.runs[0];
  assert.equal(run.costPence, 35);
  assert.equal(run.by, 'operator');
  assert.equal(run.dry, false);
  assert.equal(run.version, 1);
  assert.equal(run.result?.outcome, 'preview');
  assert.deepEqual(run.result?.adCodes, ['SI-3F9A2C-5B-1', 'SI-3F9A2C-3A-1', 'SI-3F9A2C-17-1']);
  assert.equal(run.result?.imageCount, h.uploader.calls);
  assert.equal((await h.store.getPack(OWNER_A))?.costPence, 35);
  ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() }));
  assert.equal((await h.store.getPack(OWNER_A))?.costPence, 70);
  assert.equal(await h.store.monthSpendPence('2026-11-01T00:00:00Z'), 70);
});

test('estimateRawPence is 0p for the images alone, and adds the voiceover and the sandbox when asked (38b)', () => {
  assert.equal(estimateRawPence(ANGLES), 0);
  const lines = ['A line of the script.', 'Another line of it.'];
  const video = estimateRawPence(ANGLES, { lines, voiceKey: 'jane', maxSeconds: 300, vcpus: 2 });
  assert.equal(video, estimateVideoPence({ lines, voiceKey: 'jane', maxSeconds: 300, vcpus: 2 }));
  assert.ok(video > 0);
});

test('cost_cap: an estimate over ad_pack_max_raw_pence is refused before anything is rendered, uploaded or written', async () => {
  const v = await videoPence(); // the voiceover and sandbox estimate is part of every estimate
  const h = harness({ pricing: { estimate: () => 501 - v, actual: () => 501 } });
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() });
  assert.equal(code(r), 'cost_cap');
  assert.equal(h.renderer.calls.length, 0);
  assert.equal(h.uploader.calls, 0);
  assert.deepEqual(h.store.writes, []);
  // At the limit exactly it passes.
  const g = harness({ pricing: { estimate: () => 500 - v, actual: () => 500 } });
  ok(await g.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }));
  // The cap applies to an admin regenerate too.
  const a = harness({ pricing: { estimate: () => 501 - v, actual: () => 501 } });
  assert.equal(code(await a.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() })), 'cost_cap');
});

test('monthly_cap: this UK month’s spend plus the estimate may not pass the cap; last month does not count', async () => {
  const h = harness({ pricing: { estimate: () => 40, actual: () => 40 } });
  h.store.settings.monthlyCapPence = 100;
  ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() })); // spent 40
  ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() })); // spent 80
  const writes = h.store.writes.length;
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() }); // 80 + 40 > 100
  assert.equal(code(r), 'monthly_cap');
  assert.equal(h.store.writes.length, writes);
  assert.equal((await h.store.getPack(OWNER_A))?.version, 2);
  // A dry run says the same.
  const d = await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input() });
  assert.ok(d.ok && d.dry && d.wouldBlock?.code === 'monthly_cap');
  // The next UK month starts at zero.
  h.now = new Date('2026-12-02T09:00:00Z');
  const next = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() }));
  assert.equal(next.version, 3);
});

test('monthly_cap: a cap of 0 stops everything, and an unreadable spend is refused as spend_unknown', async () => {
  const h = harness();
  h.store.settings.monthlyCapPence = 0;
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() })), 'monthly_cap');
  h.store.settings.monthlyCapPence = 5000;
  h.store.spendUnreadable = true;
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() })), 'spend_unknown');
  assert.equal(h.store.packs.size, 0);
});

// ── Not enough data, checks, failures ──

test('not_enough_data stops cleanly: no pack, no ads, no run, nothing rendered', async () => {
  const h = harness();
  h.area.result = { error: 'not_enough_data', message: 'thin' };
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() });
  assert.equal(code(r), 'not_enough_data');
  assert.deepEqual(h.store.writes, []);
  assert.equal(h.store.packs.size, 0);
  assert.equal(h.renderer.calls.length, 0);
  assert.equal(await h.engine.listPackForOwner(OWNER_A), null);
});

test('not_enough_data on a regenerate leaves the earlier version exactly as it was', async () => {
  const h = harness();
  await first(h);
  const before = JSON.stringify([...h.store.packs.values(), ...h.store.ads.values()]);
  h.area.result = { error: 'not_enough_data' };
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ brandColour: '#C2410C' }) });
  assert.equal(code(r), 'not_enough_data');
  assert.equal(JSON.stringify([...h.store.packs.values(), ...h.store.ads.values()]), before);
});

test('a district too thin falls back to the area the source returns, and THAT key is stored', async () => {
  const h = harness();
  h.area.result = { areaKey: 'NG', areaLabel: 'Nottingham', level: 'area', fellBack: true, bedrooms: 3, agg: { bedrooms: 3, sample_count: 22, avg_gross_revenue: 45_000, avg_net_revenue: 29_000, avg_occupancy: 70 }, samples: 22 };
  const r = await first(h);
  assert.equal(r.status, 'preview', JSON.stringify(r.checks.failures));
  assert.equal((await h.store.getPack(OWNER_A))?.areaKey, 'NG');
});

test('after a fall-back, asking for the same district again is not a brand change, and the screen hash matches', async () => {
  const h = harness();
  h.area.result = { areaKey: 'NG', areaLabel: 'Nottingham', level: 'area', fellBack: true, bedrooms: 3, agg: { bedrooms: 3, sample_count: 22, avg_gross_revenue: 45_000, avg_net_revenue: 29_000, avg_occupancy: 70 }, samples: 22 };
  await first(h);
  const pack = await h.store.getPack(OWNER_A);
  const i = input();
  // What the operator screen computes: the brand, the stored photos and the STORED area key.
  assert.equal(pack?.brandHash, brandHash({ ...i.brand, photos: i.photos, areaKey: 'NG' }));
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: i })), 'no_brand_change');
});

test('approve is pinned to the version the operator looked at: a stale version is refused, the right one is approved', async () => {
  const h = harness();
  await first(h);
  await h.finishVideo(OWNER_A);
  const stale = await h.engine.approvePack({ ownerId: OWNER_A, expectedVersion: 7 });
  assert.ok(!stale.ok && stale.code === 'not_preview');
  assert.equal((await h.store.getPack(OWNER_A))?.status, 'preview', 'nothing was approved');
  const right = await h.engine.approvePack({ ownerId: OWNER_A, expectedVersion: 1 });
  assert.equal(right.ok, true);
});

test('checks_failed: no logo and no type-only choice stores the ads but does not show them, and does not use the free regenerate', async () => {
  const h = harness();
  const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ logoUrl: null }) }));
  assert.equal(r.status, 'checks_failed');
  assert.ok(r.checks.failures.some((f) => f.rule === 'brand_logo'));
  const pack = await h.store.getPack(OWNER_A);
  assert.equal(pack?.status, 'checks_failed');
  assert.equal(pack?.checks?.ok, false);
  assert.equal(h.store.runs[0].result?.outcome, 'checks_failed');
  assert.ok((h.store.runs[0].result?.checkFailures ?? 0) > 0);
  const view = await h.engine.listPackForOwner(OWNER_A);
  assert.equal(view?.showAds, false);
  const approve = await h.engine.approvePack({ ownerId: OWNER_A });
  assert.deepEqual(approve.ok ? null : approve.code, 'not_preview');
  // Fixing the brand is a brand change: the regenerate works and the free one is still there.
  const fixed = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }));
  assert.equal(fixed.status, 'preview');
  assert.equal(fixed.version, 2);
  assert.equal((await h.store.getPack(OWNER_A))?.regenCount, 1, 'this regenerate produced a pack to look at, so it counts');
  // Type-only is a valid choice for an operator with no logo.
  const t = harness();
  const typeOnly = ok(await t.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: { ...withBrand({ logoUrl: null }), typeOnly: true } }));
  assert.equal(typeOnly.status, 'preview');
});

test('checks_failed: a renderer that returns a wrong image size fails the files check', async () => {
  const h = harness();
  h.renderer.tweak = (images) => images.map((i, n) => (n === 0 ? { ...i, width: 1000, height: 1000 } : i));
  const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }));
  assert.equal(r.status, 'checks_failed');
  assert.ok(r.checks.failures.some((f) => f.rule === 'file_size'));
  // A regenerate that stays checks_failed does not use the free regenerate.
  const again = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ brandColour: '#C2410C' }) }));
  assert.equal(again.status, 'checks_failed');
  assert.equal((await h.store.getPack(OWNER_A))?.regenCount, 0);
  // checks_failed does not supersede the older version.
  assert.ok([...h.store.ads.values()].every((a) => a.supersededAt === null));
});

test('checks_failed: a company name that breaks a check (a source-brand word) is caught before the operator sees it', async () => {
  const h = harness();
  const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ company: 'Stay' + 'ful Copycat Ltd' }) }));
  assert.equal(r.status, 'checks_failed');
  assert.ok(r.checks.failures.some((f) => f.rule === 'source_word'));
});

test('a render failure sets the pack failed with a short code and keeps the raw error out of every row and log', async () => {
  const h = harness();
  h.renderer.fail = true;
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() });
  assert.equal(code(r), 'render_failed');
  const pack = await h.store.getPack(OWNER_A);
  assert.equal(pack?.status, 'failed');
  assert.equal(pack?.errorCode, 'render_failed');
  assert.equal(pack?.generatedAt, null);
  assert.equal(h.store.runs.length, 1);
  assert.equal(h.store.runs[0].result?.outcome, 'failed');
  assert.equal(h.store.runs[0].result?.errorCode, 'render_failed');
  assert.equal(h.store.ads.size, 0);
  const everything = JSON.stringify([[...h.store.packs.values()], h.store.runs, h.logs, r]);
  assert.ok(!everything.includes('boom') && !everything.includes('address'), 'no raw error text anywhere');
  for (const l of h.logs) assert.deepEqual(Object.keys(l.fields).sort().filter((k) => !['packId', 'code'].includes(k)), [], 'log lines carry a pack id and a code only');
  // The pack ran as a first generation, so a retry works and is version 1 again.
  h.renderer.fail = false;
  const retry = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }));
  assert.equal(retry.version, 1);
  assert.equal(retry.operatorCode, '3F9A2C');
  assert.equal((await h.store.getPack(OWNER_A))?.errorCode, null);
});

test('an upload failure and a store failure are their own codes', async () => {
  const h = harness();
  h.uploader.fail = true;
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() })), 'upload_failed');
  assert.equal((await h.store.getPack(OWNER_A))?.status, 'failed');

  const g = harness();
  g.store.failNext.insertAds = true;
  assert.equal(code(await g.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() })), 'store_failed');
  assert.equal((await g.store.getPack(OWNER_A))?.errorCode, 'store_failed');

  // A read that fails is "could not look", never "no pack".
  const k = harness();
  await first(k);
  k.store.failNext.getPack = true;
  assert.equal(code(await k.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() })), 'store_failed');
  assert.equal(k.store.packs.size, 1);
});

test('a failed regenerate leaves the earlier version, its ads and its brand hash alone, and the retry is judged against it', async () => {
  const h = harness();
  const v1 = await first(h);
  const hash1 = (await h.store.getPack(OWNER_A))?.brandHash;
  h.renderer.fail = true;
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ brandColour: '#C2410C' }) });
  assert.equal(code(r), 'render_failed');
  const pack = await h.store.getPack(OWNER_A);
  assert.equal(pack?.status, 'failed');
  assert.equal(pack?.version, 1);
  assert.equal(pack?.brandHash, hash1);
  assert.equal(pack?.regenCount, 0, 'a failed regenerate costs the operator nothing');
  assert.deepEqual((await h.store.listAds(OWNER_A, v1.packId)).map((a) => a.code).sort(), v1.ads.map((a) => a.code).sort());
  const view = await h.engine.listPackForOwner(OWNER_A);
  assert.equal(view?.showAds, true, 'the earlier good version is still shown');
  h.renderer.fail = false;
  const retry = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ brandColour: '#C2410C' }) }));
  assert.equal(retry.version, 2);
  assert.equal(retry.regenCount, 1);
});

test('ads left behind by an attempt that stopped half way are cleared, so the retry does not hit the unique code', async () => {
  const h = harness();
  h.store.failNext.updatePack = true; // the final pack update throws after the ads were inserted
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() })), 'store_failed');
  assert.equal(h.store.ads.size, 3, 'the half-made version’s ads are still there');
  const retry = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }));
  assert.equal(retry.version, 1);
  assert.equal(h.store.ads.size, 3);
});

test('a pack that is generating is "in_progress" until its claim goes stale (10 minutes)', async () => {
  const h = harness();
  await first(h);
  const pack = await h.store.getPack(OWNER_A);
  assert.ok(pack);
  await h.store.updatePack(OWNER_A, pack.id, { status: 'generating' });
  h.now = new Date(h.now.getTime() + 5 * 60_000);
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() })), 'in_progress');
  h.now = new Date(h.now.getTime() + 6 * 60_000);
  const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() }));
  assert.equal(r.version, 2);
});

// ── Input ──

test('bad input is refused before anything happens: more than 4 photos, a bad owner id, a bad domain, no area', async () => {
  const h = harness();
  const photos = Array.from({ length: 5 }, (_, i) => `https://cdn.example.test/p${i}.jpg`);
  const cases: GenerateInput[] = [input({ photos }), input({ domain: 'not a domain' }), input({ areaKey: '  ' }), { ...input(), brand: { ...input().brand, company: undefined as unknown as string } }];
  for (const i of cases) assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: i })), 'invalid_input');
  assert.equal(code(await h.engine.generatePack({ ownerId: 'not-a-uuid', by: 'operator', input: input() })), 'invalid_input');
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'nobody' as 'admin', input: input() })), 'invalid_input');
  assert.deepEqual(h.store.writes, []);
  assert.equal(h.area.calls, 0);
  // Exactly 4 photos is fine.
  ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input({ photos: photos.slice(0, 4) }) }));
});

// ── Approve ──

test('approvePack works only from preview, names the activity kind, and refuses every other state', async () => {
  const h = harness();
  assert.deepEqual(await h.engine.approvePack({ ownerId: OWNER_A }), { ok: false, code: 'no_pack', message: 'There is no pack to approve yet.' });
  const r = await first(h);
  await h.finishVideo(OWNER_A);
  const a = await h.engine.approvePack({ ownerId: OWNER_A });
  assert.ok(a.ok);
  if (a.ok) {
    assert.equal(a.activityKind, 'ad_pack_approved');
    assert.equal(a.packId, r.packId);
    assert.equal(a.version, 1);
    assert.equal(a.operatorCode, '3F9A2C');
  }
  const pack = await h.store.getPack(OWNER_A);
  assert.equal(pack?.status, 'approved');
  assert.ok(pack?.approvedAt);
  // Already approved: not from preview.
  const again = await h.engine.approvePack({ ownerId: OWNER_A });
  assert.ok(!again.ok && again.code === 'not_preview');
  // A failed pack and a checks_failed pack cannot be approved.
  const f = harness();
  f.renderer.fail = true;
  await f.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() });
  const fa = await f.engine.approvePack({ ownerId: OWNER_A });
  assert.ok(!fa.ok && fa.code === 'not_preview');
  assert.equal(JSON.stringify(await h.engine.approvePack({ ownerId: 'x' })), JSON.stringify({ ok: false, code: 'invalid_input', message: generateMessage('invalid_input') }));
});

// ── Owner isolation ──

test('owner isolation: another owner reads nothing, changes nothing, and cannot approve', async () => {
  const h = harness();
  const a = await first(h, OWNER_A);
  const adId = (await h.store.listAds(OWNER_A, a.packId))[0].id;
  assert.equal(await h.store.getPack(OWNER_B), null);
  assert.deepEqual(await h.store.listAds(OWNER_B, a.packId), []);
  assert.equal(await h.store.getPackAd(OWNER_B, adId), null);
  assert.equal(await h.store.updatePack(OWNER_B, a.packId, { status: 'approved' }), null);
  assert.equal(await h.store.beginGenerating(OWNER_B, a.packId, '2000-01-01T00:00:00Z'), null);
  assert.equal(await h.store.insertRun(OWNER_B, { packId: a.packId, version: 1, by: 'operator', costPence: 0, result: h.store.runs[0].result! }), null);
  assert.deepEqual(await h.store.listRuns(OWNER_B, a.packId), []);
  assert.equal(await h.store.clearAdsOfVersion(OWNER_B, a.packId, 1), 0);
  assert.equal(await h.store.supersedeAds(OWNER_B, a.packId, 9, '2026-11-20T00:00:00Z'), 0);
  await assert.rejects(h.store.insertAds(OWNER_B, [{ ...(await h.store.getPackAd(OWNER_A, adId))!, id: undefined } as never]));
  assert.equal(await h.engine.listPackForOwner(OWNER_B), null);
  const refused = await h.engine.approvePack({ ownerId: OWNER_B });
  assert.ok(!refused.ok && refused.code === 'no_pack');
  assert.equal((await h.store.getPack(OWNER_A))?.status, 'preview', 'A’s pack is untouched');
  // B's own pack is its own.
  const b = await first(h, OWNER_B);
  assert.notEqual(b.packId, a.packId);
  assert.equal((await h.store.listAds(OWNER_A, a.packId)).length, 3);
  assert.deepEqual(await h.store.listAds(OWNER_A, b.packId), []);
});

// ── Pinned pieces ──

test('brandHash: stable, ignores whitespace and case of the colour and area, and moves with every part of the brand', () => {
  const base: BrandHashInput = { company: 'Brightstone Stays', logoUrl: 'https://x.test/l.png', brandColour: '#1F6F5C', feePct: 12, photos: ['https://x.test/a.jpg', 'https://x.test/b.jpg'], areaKey: 'NG7' };
  const h0 = brandHash(base);
  assert.match(h0, /^[0-9a-f]{64}$/);
  assert.equal(brandHash({ ...base }), h0);
  assert.equal(brandHash({ ...base, company: '  Brightstone   Stays  ', brandColour: '#1f6f5c', areaKey: 'ng7' }), h0);
  assert.equal(brandHash({ ...base, photos: ['  https://x.test/a.jpg', 'https://x.test/b.jpg  ', ''] }), h0);
  const changes: Partial<BrandHashInput>[] = [
    { company: 'Brightstone Lettings' },
    { logoUrl: 'https://x.test/l2.png' },
    { logoUrl: null },
    { brandColour: '#C2410C' },
    { feePct: 15 },
    { feePct: null },
    { photos: ['https://x.test/a.jpg'] },
    { photos: ['https://x.test/b.jpg', 'https://x.test/a.jpg'] },
    { areaKey: 'NG' },
  ];
  const seen = new Set([h0]);
  for (const c of changes) {
    const h = brandHash({ ...base, ...c });
    assert.ok(!seen.has(h), JSON.stringify(c));
    seen.add(h);
  }
});

test('the planned image names and sizes are the real renderer’s', async () => {
  const m = await loadImagesModule();
  for (const angle of ['3a', '17'] as const) {
    const real: { name: string; width: number; height: number }[] = [];
    for (let c = 1; c <= 5; c++) for (const s of m.CARD_SIZES) real.push({ name: m.imageName(angle, c, s), width: m.SIZE_PX[s].width, height: m.SIZE_PX[s].height });
    assert.deepEqual(plannedImageNames(angle, 5), real);
  }
});

test('every refusal code has a plain-English message', () => {
  for (const c of GENERATE_CODES) {
    const m = generateMessage(c);
    assert.ok(m.length > 10 && !/stay\s?ful/i.test(m), c);
  }
  assert.ok(generateMessage('something_new').length > 10);
});
