import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadPath, signedDownloadUrlWith } from './download.ts';
import { estimateVideoPence, GENERATE_MESSAGES, SEED_SANDBOX_CPU_SECOND_PENCE, VIDEO_MESSAGES, voiceFilePaths, type GenerateInput, type GenerateOk, type GenerateResult } from './generate-core.ts';
import { voicePaths } from './render-core.ts';
import { readyVideo, harness, type Harness } from './test-store.ts';
import { estimateVoicePence } from './voice-core.ts';

/**
 * Batch 38b (B5a): the video wired into the generator, approve, the voice change and the retry, on the in-memory
 * stores (no database, no network, no sandbox). The render worker itself is tested in render.test.ts.
 */

const OWNER_A = '3f9a2c11-1111-4111-8111-111111111111';
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
const withBrand = (over: Partial<GenerateInput['brand']>, rest: Partial<GenerateInput> = {}): GenerateInput => ({ ...input(rest), brand: { ...input().brand, ...over } });

function ok(r: GenerateResult): GenerateOk {
  assert.ok(r.ok && !r.dry, `expected a made pack, got ${JSON.stringify(r.ok ? { dry: true } : { code: r.code })}`);
  return r as GenerateOk;
}

async function first(h: Harness, over: Partial<GenerateInput> = {}, owner = OWNER_A) {
  return ok(await h.engine.generatePack({ ownerId: owner, by: 'operator', input: input(over) }));
}

const ad5b = async (h: Harness, owner = OWNER_A) => {
  const pack = (await h.store.getPack(owner))!;
  return (await h.store.listAds(owner, pack.id)).find((a) => a.angle === '5b' && a.version === pack.version)!;
};
const slotStatus = async (h: Harness, owner = OWNER_A) => (await ad5b(h, owner)).files.video?.status;
const renderRow = async (h: Harness, owner = OWNER_A) => {
  const pack = (await h.store.getPack(owner))!;
  return h.renders.getRender(pack.id, pack.version);
};
const snapshot = async (h: Harness) => JSON.stringify([[...h.store.packs.values()], [...h.store.ads.values()], [...h.renders.rows.values()], h.deleted]);

// ── Generate enqueues the video ──

test('generate: the chosen voice is stored, the 5b slot is queued and the render is enqueued ONCE with that voice', async () => {
  const h = harness();
  const r = await first(h, { voiceKey: 'olivia' });
  assert.equal(r.status, 'preview');
  assert.equal(r.voiceKey, 'olivia');
  assert.deepEqual(r.video, { status: 'queued' });
  assert.deepEqual(h.enqueues, [{ packId: r.packId, version: 1, voiceKey: 'olivia' }]);
  assert.equal((await h.store.getPack(OWNER_A))?.voiceKey, 'olivia');
  assert.equal((await h.store.getPack(OWNER_A))?.voiceChanges, 0);
  assert.deepEqual((await ad5b(h)).files.video, { status: 'queued' });
  const row = await renderRow(h);
  assert.ok(row && row.state === 'queued' && row.voiceKey === 'olivia' && row.attempts === 0);
  // The image ads have no video slot.
  const ads = await h.store.listAds(OWNER_A, r.packId);
  assert.ok(ads.filter((a) => a.angle !== '5b').every((a) => a.files.video === null));
});

test('generate: no voice given is the default voice (jane); an unknown voice is invalid_input and writes nothing', async () => {
  const h = harness();
  const r = await first(h);
  assert.equal(r.voiceKey, 'jane');
  assert.equal(h.enqueues[0].voiceKey, 'jane');
  const g = harness();
  for (const bad of ['sarah', '', 7, null]) {
    const res = await g.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input({ voiceKey: bad as never }) });
    assert.ok(!res.ok && res.code === 'invalid_input', String(bad));
  }
  assert.deepEqual(g.store.writes, []);
  assert.deepEqual(g.enqueues, []);
});

test('a dry run enqueues nothing and writes nothing, and reports the voice', async () => {
  const h = harness();
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input({ voiceKey: 'oliver' }) });
  assert.ok(r.ok && r.dry && r.plan);
  if (r.ok && r.dry && r.plan) assert.equal(r.plan.voiceKey, 'oliver');
  assert.deepEqual(h.enqueues, []);
  assert.deepEqual(h.renders.writes, []);
  assert.deepEqual(h.store.writes, []);
  assert.deepEqual(h.deleted, []);
  // Also on an existing pack.
  await first(h);
  const before = await snapshot(h);
  const writes = h.store.writes.length;
  await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input() });
  assert.equal(h.enqueues.length, 1);
  assert.equal(h.store.writes.length, writes);
  assert.equal(await snapshot(h), before);
});

test('a pack that fails its checks is kept, with no video made or queued (no paid call for a pack nobody sees)', async () => {
  const h = harness();
  const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ logoUrl: null }) }));
  assert.equal(r.status, 'checks_failed');
  assert.deepEqual(r.video, { status: 'coming' });
  assert.deepEqual(h.enqueues, []);
  assert.deepEqual((await ad5b(h)).files.video, { status: 'coming' });
});

test('a failed enqueue does not lose the pack: the slot becomes failed with a code, and the screen can offer a retry', async () => {
  for (const mode of ['code', 'throw'] as const) {
    const h = harness();
    h.enqueueFails = mode;
    const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }));
    assert.equal(r.status, 'preview', 'the pack is still made');
    assert.deepEqual(r.video, { status: 'failed', code: 'store_failed' });
    assert.deepEqual((await ad5b(h)).files.video, { status: 'failed', code: 'store_failed' });
    assert.equal(await renderRow(h), null);
    assert.equal((await h.store.getPack(OWNER_A))?.status, 'preview');

    const view = (await h.engine.listPackForOwner(OWNER_A))!;
    assert.equal(view.video.status, 'failed');
    assert.equal(view.video.code, 'store_failed');
    assert.equal(view.video.canRetry, true);
    assert.equal(view.render, null);
    assert.equal(view.showAds, true);
    const approve = await h.engine.approvePack({ ownerId: OWNER_A });
    assert.ok(!approve.ok && approve.code === 'video_failed');

    h.enqueueFails = null;
    const retry = await h.engine.retryVideo({ ownerId: OWNER_A });
    assert.ok(retry.ok, JSON.stringify(retry));
    assert.equal((await renderRow(h))?.state, 'queued');
    assert.equal(await slotStatus(h), 'queued');
    assert.equal((await h.store.getPack(OWNER_A))?.version, 1, 'no new version');
  }
});

// ── A regenerate keeps the voice ──

test('a regenerate keeps the stored voice (input.voiceKey is ignored), enqueues the new version with it, and keeps voice_changes', async () => {
  const h = harness();
  await first(h, { voiceKey: 'olivia' });
  await h.finishVideo(OWNER_A);
  // A change used once.
  const changed = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'oliver' });
  assert.ok(changed.ok);
  assert.equal((await h.store.getPack(OWNER_A))?.voiceChanges, 1);
  const r2 = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ company: 'Brightstone Lettings' }, { voiceKey: 'jane' }) }));
  assert.equal(r2.version, 2);
  assert.equal(r2.voiceKey, 'oliver', 'the stored voice, not the one in the request');
  assert.deepEqual(h.enqueues.map((e) => [e.version, e.voiceKey]), [[1, 'olivia'], [2, 'oliver']]);
  const pack = await h.store.getPack(OWNER_A);
  assert.equal(pack?.voiceKey, 'oliver');
  assert.equal(pack?.voiceChanges, 1, 'the allowance is per pack: a regenerate does not give it back');
  // An admin regenerate keeps the operator's voice too, and never counts a voice change.
  const r3 = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() }));
  assert.equal(r3.voiceKey, 'oliver');
  assert.equal(h.enqueues[2].voiceKey, 'oliver');
  assert.equal((await h.store.getPack(OWNER_A))?.voiceChanges, 1);
  // Each version has its own render row.
  assert.equal(h.renders.rows.size, 3);
});

// ── The cost guard ──

test('estimateVideoPence: the voiceover plus the sandbox at its time limit (vcpus x seconds x unit cost), rounded up', () => {
  const lines = ['The first line of the script.', 'The second line of it.'];
  const voice = estimateVoicePence(lines, 'jane');
  const sandbox = Math.ceil(2 * 270 * SEED_SANDBOX_CPU_SECOND_PENCE - 1e-9);
  assert.equal(estimateVideoPence({ lines, voiceKey: 'jane', maxSeconds: 300, vcpus: 2 }), voice + sandbox);
  // The estimate prices what the worker really allows (270 s), whatever the setting says above it.
  assert.equal(estimateVideoPence({ lines, voiceKey: 'jane', maxSeconds: 900, vcpus: 2 }), voice + sandbox);
  // A shorter limit and a bigger sandbox move it.
  assert.equal(estimateVideoPence({ lines, voiceKey: 'jane', maxSeconds: 60, vcpus: 8, cpuSecondPence: 1 }), voice + 480);
  assert.equal(estimateVideoPence({ lines, voiceKey: 'jane', maxSeconds: 60, vcpus: 8, cpuSecondPence: 0 }), voice);
});

test('generate: the estimate includes the voice and the sandbox from the settings, checked before any paid call, any write or any enqueue', async () => {
  const h = harness();
  const dry = await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input() });
  assert.ok(dry.ok && dry.dry && dry.plan);
  const base = dry.ok && dry.dry && dry.plan ? dry.plan.estimatedCostPence : 0;
  assert.ok(base > 0);

  // A per-pack cap just under the estimate refuses: nothing rendered, uploaded, written or enqueued.
  const a = harness();
  a.store.settings.maxRawPence = base - 1;
  const refused = await a.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() });
  assert.ok(!refused.ok && refused.code === 'cost_cap');
  assert.deepEqual(a.store.writes, []);
  assert.equal(a.renderer.calls.length, 0);
  assert.deepEqual(a.enqueues, []);
  // Exactly at the cap passes.
  const b = harness();
  b.store.settings.maxRawPence = base;
  ok(await b.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }));

  // The sandbox settings move the estimate (more vCPUs cost more; the time limit is read too).
  const c = harness();
  c.store.settings.sandboxVcpus = 8;
  const big = await c.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input() });
  assert.ok(big.ok && big.dry && big.plan && big.plan.estimatedCostPence > base);
  const d = harness();
  d.store.settings.renderMaxSeconds = 60;
  const small = await d.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input() });
  assert.ok(small.ok && small.dry && small.plan && small.plan.estimatedCostPence <= base);

  // The live unit cost, when the server has it, replaces the seed.
  const e = harness();
  e.deps.sandboxCpuSecondPence = async () => 0.5;
  const pricey = await e.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: input() });
  assert.ok(pricey.ok && pricey.dry && pricey.plan && pricey.plan.estimatedCostPence > base + 100);

  // The monthly cap counts the estimate too.
  const m = harness();
  m.store.settings.monthlyCapPence = base - 1;
  const capped = await m.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() });
  assert.ok(!capped.ok && capped.code === 'monthly_cap');
  assert.deepEqual(m.store.writes, []);
});

// ── Approve ──

test('approve is refused while the video is queued or being made, with the plain "still being made" message', async () => {
  const h = harness();
  await first(h);
  for (const state of ['queued', 'running'] as const) {
    await h.setRender(OWNER_A, { state });
    const r = await h.engine.approvePack({ ownerId: OWNER_A });
    assert.ok(!r.ok && r.code === 'video_pending', state);
    if (!r.ok) assert.equal(r.message, 'Your video is still being made. It usually takes a few minutes.');
  }
  assert.equal((await h.store.getPack(OWNER_A))?.status, 'preview');
  const view = (await h.engine.listPackForOwner(OWNER_A))!;
  assert.deepEqual(view.approval, { ok: false, code: 'video_pending', message: VIDEO_MESSAGES.video_pending });
});

test('approve is refused when the video failed, in plain words; a voice that is not available says so', async () => {
  const h = harness();
  await first(h);
  await h.setRender(OWNER_A, { state: 'failed', errorCode: 'sandbox_failed' });
  const r = await h.engine.approvePack({ ownerId: OWNER_A });
  assert.ok(!r.ok && r.code === 'video_failed');
  if (!r.ok) {
    assert.match(r.message, /couldn’t make your video/);
    assert.ok(!/sandbox_failed/.test(r.message));
  }
  await h.setRender(OWNER_A, { state: 'failed', errorCode: 'voice_unavailable' });
  const v = await h.engine.approvePack({ ownerId: OWNER_A });
  assert.ok(!v.ok && v.code === 'video_failed');
  if (!v.ok) assert.match(v.message, /voice isn’t available/);
  assert.equal((await h.store.getPack(OWNER_A))?.status, 'preview', 'the pack stays in preview');
});

test('approve works once the video is ready and keeps the 38a version pin; there is no image-only fallback', async () => {
  const h = harness();
  const made = await first(h);
  // The three ads are all there but the video is not: no approval.
  const early = await h.engine.approvePack({ ownerId: OWNER_A });
  assert.ok(!early.ok);
  await h.finishVideo(OWNER_A);
  const stale = await h.engine.approvePack({ ownerId: OWNER_A, expectedVersion: 9 });
  assert.ok(!stale.ok && stale.code === 'not_preview');
  assert.deepEqual((await h.engine.listPackForOwner(OWNER_A))!.approval, { ok: true });
  const good = await h.engine.approvePack({ ownerId: OWNER_A, expectedVersion: 1 });
  assert.ok(good.ok);
  if (good.ok) assert.equal(good.packId, made.packId);
  assert.equal((await h.store.getPack(OWNER_A))?.status, 'approved');
});

test('approve is refused for a ready slot whose render row is not done (a stale slot never approves an old video)', async () => {
  const h = harness();
  await first(h);
  await h.finishVideo(OWNER_A);
  await h.setRender(OWNER_A, { state: 'queued' });
  const r = await h.engine.approvePack({ ownerId: OWNER_A });
  assert.ok(!r.ok && r.code === 'video_pending');
});

test('approve is refused after the video checks failed (the pack is checks_failed), and while checks are not all passing', async () => {
  const h = harness();
  await first(h);
  await h.finishVideo(OWNER_A);
  const pack = (await h.store.getPack(OWNER_A))!;
  await h.store.updatePack(OWNER_A, pack.id, { status: 'checks_failed', checks: { ok: false, failures: [{ check: 'video', rule: 'video_audio', where: 'ad 5b notice-9x16.mp4', detail: 'The video has no sound.' }], warnings: [], results: [] } });
  const r = await h.engine.approvePack({ ownerId: OWNER_A });
  assert.ok(!r.ok && r.code === 'not_preview');
  // A pack still marked preview but with failing checks is refused as well.
  await h.store.updatePack(OWNER_A, pack.id, { status: 'preview' });
  const again = await h.engine.approvePack({ ownerId: OWNER_A });
  assert.ok(!again.ok && again.code === 'not_preview');
  assert.equal((await h.store.getPack(OWNER_A))?.status, 'preview');
});

// ── Change the voice ──

test('changeVoice: allowed once, on the SAME version; codes unchanged; cached voice files removed; render reset; slot queued', async () => {
  const h = harness();
  const made = await first(h, { voiceKey: 'jane' });
  await h.finishVideo(OWNER_A);
  const codesBefore = (await h.store.listAds(OWNER_A, made.packId)).map((a) => a.code);
  const rowBefore = (await renderRow(h))!;
  h.renders.rows.get(rowBefore.id)!.attempts = 2;
  h.renders.rows.get(rowBefore.id)!.costPence = 11;

  const r = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia', expectedVersion: 1 });
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) assert.deepEqual([r.packId, r.version, r.voiceKey, r.free, r.changesLeft], [made.packId, 1, 'olivia', false, 0]);

  const pack = (await h.store.getPack(OWNER_A))!;
  assert.equal(pack.voiceKey, 'olivia');
  assert.equal(pack.voiceChanges, 1);
  assert.equal(pack.version, 1, 'no new version');
  assert.equal(pack.status, 'preview');
  assert.deepEqual((await h.store.listAds(OWNER_A, made.packId)).map((a) => a.code), codesBefore, 'the codes do not change');
  assert.equal(h.store.ads.size, 3);
  assert.deepEqual(h.deleted, [`${OWNER_A}/${made.packId}/v1/voice.mp3`, `${OWNER_A}/${made.packId}/v1/script.json`]);
  const row = (await renderRow(h))!;
  assert.equal(row.id, rowBefore.id, 'the same row, reset in place');
  assert.deepEqual([row.state, row.attempts, row.errorCode, row.files, row.voiceKey], ['queued', 0, null, null, 'olivia']);
  assert.equal(row.costPence, 11, 'the money spent so far stays on the row');
  assert.deepEqual((await ad5b(h)).files.video, { status: 'queued' });
  assert.equal(h.renders.rows.size, 1);
  // The video is not approvable until the new render is done.
  const early = await h.engine.approvePack({ ownerId: OWNER_A });
  assert.ok(!early.ok && early.code === 'video_pending');
});

test('changeVoice: refused the second time, for the same voice, after approval, and while a render is running; nothing changes', async () => {
  const h = harness();
  await first(h, { voiceKey: 'jane' });
  await h.finishVideo(OWNER_A);

  const same = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'jane' });
  assert.ok(!same.ok && same.code === 'same_voice');

  // Running: refused, and nothing is deleted or counted.
  await h.setRender(OWNER_A, { state: 'running' });
  const before = await snapshot(h);
  const running = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia' });
  assert.ok(!running.ok && running.code === 'video_running');
  if (!running.ok) assert.equal(running.message, VIDEO_MESSAGES.video_running);
  assert.equal(await snapshot(h), before);
  await h.finishVideo(OWNER_A);

  assert.ok((await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia' })).ok);
  await h.finishVideo(OWNER_A);
  const second = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'oliver' });
  assert.ok(!second.ok && second.code === 'voice_limit_used');
  assert.equal((await h.store.getPack(OWNER_A))?.voiceKey, 'olivia');
  assert.equal((await h.store.getPack(OWNER_A))?.voiceChanges, 1);

  // After approval: the plain message.
  assert.ok((await h.engine.approvePack({ ownerId: OWNER_A })).ok);
  const late = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'oliver' });
  assert.ok(!late.ok && late.code === 'after_approval');
  if (!late.ok) assert.equal(late.message, 'You can change the voice before you approve your ads.');
  const view = (await h.engine.listPackForOwner(OWNER_A))!;
  assert.equal(view.voice.canChange, false);
  assert.equal(view.voice.blocked?.code, 'after_approval');
});

test('changeVoice follows ad_pack_voice_changes (a bigger allowance allows more changes; 0 allows none)', async () => {
  const h = harness();
  h.store.settings.voiceChanges = 2;
  await first(h);
  await h.finishVideo(OWNER_A);
  assert.ok((await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia' })).ok);
  await h.finishVideo(OWNER_A);
  assert.equal((await h.engine.listPackForOwner(OWNER_A))!.voice.changesLeft, 1);
  assert.ok((await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'oliver' })).ok);
  await h.finishVideo(OWNER_A);
  const third = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'jane' });
  assert.ok(!third.ok && third.code === 'voice_limit_used');

  const z = harness();
  z.store.settings.voiceChanges = 0;
  await first(z);
  await z.finishVideo(OWNER_A);
  const none = await z.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia' });
  assert.ok(!none.ok && none.code === 'voice_limit_used');
});

test('voice_unavailable: the pack stays in preview, the change is FREE (not counted), and allowed even with the allowance used up', async () => {
  const h = harness();
  await first(h, { voiceKey: 'oliver' });
  await h.setRender(OWNER_A, { state: 'failed', errorCode: 'voice_unavailable' });
  const view = (await h.engine.listPackForOwner(OWNER_A))!;
  assert.equal(view.pack.status, 'preview');
  assert.equal(view.video.status, 'failed');
  assert.equal(view.video.code, 'voice_unavailable');
  assert.equal(view.video.canRetry, false, 'a retry cannot fix it: another voice can');
  assert.equal(view.voice.canChange, true);
  assert.equal(view.voice.free, true);
  assert.equal(view.render?.retryable, false);

  const r = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'jane' });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.free, true);
  assert.equal((await h.store.getPack(OWNER_A))?.voiceChanges, 0, 'the allowance was not used');
  assert.equal((await h.store.getPack(OWNER_A))?.voiceKey, 'jane');
  assert.equal((await renderRow(h))?.state, 'queued');
  assert.equal((await renderRow(h))?.voiceKey, 'jane');

  // Allowance already used, then the new voice is unavailable too: still free.
  const g = harness();
  await first(g);
  await g.finishVideo(OWNER_A);
  assert.ok((await g.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'oliver' })).ok);
  assert.equal((await g.store.getPack(OWNER_A))?.voiceChanges, 1);
  await g.setRender(OWNER_A, { state: 'failed', errorCode: 'voice_unavailable' });
  const free = await g.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia' });
  assert.ok(free.ok);
  assert.equal((await g.store.getPack(OWNER_A))?.voiceChanges, 1, 'still one: this one was free');
  // ... but other failures do not make a change free.
  await g.setRender(OWNER_A, { state: 'failed', errorCode: 'sandbox_failed' });
  const paid = await g.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'jane' });
  assert.ok(!paid.ok && paid.code === 'voice_limit_used');
});

test('changeVoice: the cost caps are checked before anything is deleted, reset or counted', async () => {
  const mk = async () => {
    const h = harness();
    await first(h);
    await h.finishVideo(OWNER_A);
    return h;
  };
  const guard = async (h: Harness, expected: string) => {
    const before = await snapshot(h);
    const r = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia' });
    assert.ok(!r.ok && r.code === expected, JSON.stringify(r));
    if (!r.ok) assert.equal(r.message, (GENERATE_MESSAGES as Record<string, string>)[expected]);
    assert.equal(await snapshot(h), before, 'nothing changed');
  };
  const a = await mk();
  a.store.settings.maxRawPence = 1;
  await guard(a, 'cost_cap');

  const b = await mk();
  const pack = (await b.store.getPack(OWNER_A))!;
  await b.store.insertRun(OWNER_A, { packId: pack.id, version: 1, by: 'admin', costPence: b.store.settings.monthlyCapPence - 1, result: b.store.runs[0].result! });
  await guard(b, 'monthly_cap');

  const c = await mk();
  c.store.spendUnreadable = true;
  await guard(c, 'spend_unknown');
});

test('changeVoice: a failing delete or a render that started meanwhile puts the old voice and the allowance back', async () => {
  const h = harness();
  await first(h);
  await h.finishVideo(OWNER_A);
  h.deleteFails = true;
  const failed = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia' });
  assert.ok(!failed.ok && failed.code === 'store_failed');
  let pack = (await h.store.getPack(OWNER_A))!;
  assert.deepEqual([pack.voiceKey, pack.voiceChanges], ['jane', 0]);
  assert.equal((await renderRow(h))?.state, 'done', 'the render row was not touched');
  assert.equal(await slotStatus(h), 'ready');

  // A worker takes the row between the check and the reset: the conditional reset refuses, and the pack is put back.
  h.deleteFails = false;
  const real = h.renders.requeueRender.bind(h.renders);
  h.renders.requeueRender = async (i) => {
    await h.setRender(OWNER_A, { state: 'running' });
    return real(i);
  };
  const raced = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia' });
  assert.ok(!raced.ok && raced.code === 'video_running');
  pack = (await h.store.getPack(OWNER_A))!;
  assert.deepEqual([pack.voiceKey, pack.voiceChanges], ['jane', 0]);
});

test('changeVoice: owner isolation, bad input and a stale version', async () => {
  const h = harness();
  await first(h);
  await h.finishVideo(OWNER_A);
  const before = await snapshot(h);
  const other = await h.engine.changeVoice({ ownerId: OWNER_B, voiceKey: 'olivia' });
  assert.ok(!other.ok && other.code === 'no_pack');
  assert.equal(await snapshot(h), before, 'A’s pack, render and files are untouched');
  for (const bad of [{ ownerId: 'x', voiceKey: 'olivia' }, { ownerId: OWNER_A, voiceKey: 'sarah' }, { ownerId: OWNER_A, voiceKey: '' }]) {
    const r = await h.engine.changeVoice(bad);
    assert.ok(!r.ok && r.code === 'invalid_input');
  }
  const stale = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia', expectedVersion: 4 });
  assert.ok(!stale.ok && stale.code === 'not_preview');
  assert.equal(await snapshot(h), before);
  // B has a pack of their own: A's request never reaches it.
  await first(h, {}, OWNER_B);
  await h.finishVideo(OWNER_B);
  assert.ok((await h.engine.changeVoice({ ownerId: OWNER_B, voiceKey: 'oliver' })).ok);
  assert.equal((await h.store.getPack(OWNER_A))?.voiceKey, 'jane');
  assert.equal((await h.store.getPack(OWNER_A))?.voiceChanges, 0);
  assert.ok(h.deleted.every((p) => p.startsWith(`${OWNER_B}/`)), 'only B’s files were deleted');
});

test('changeVoice is not possible on a pack that failed its checks or is still generating', async () => {
  const h = harness();
  ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: withBrand({ logoUrl: null }) }));
  const r = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia' });
  assert.ok(!r.ok && r.code === 'not_preview');
});

test('the voice file paths match the render worker’s own', async () => {
  const h = harness();
  const r = await first(h);
  assert.deepEqual(voiceFilePaths(OWNER_A, r.packId, 1), [voicePaths(OWNER_A, r.packId, 1).audio, voicePaths(OWNER_A, r.packId, 1).script]);
});

// ── Retry ──

test('retryVideo: a failed render with a retryable code goes round again on the same version and voice, counting nothing', async () => {
  const h = harness();
  const made = await first(h, { voiceKey: 'olivia' });
  const row = (await renderRow(h))!;
  const live = h.renders.rows.get(row.id)!;
  live.state = 'failed';
  live.errorCode = 'sandbox_failed';
  live.attempts = 3;
  live.costPence = 7;
  const view = (await h.engine.listPackForOwner(OWNER_A))!;
  assert.equal(view.video.canRetry, true);
  assert.deepEqual(view.render, { state: 'failed', errorCode: 'sandbox_failed', attempts: 3, voiceKey: 'olivia', retryable: true });

  const r = await h.engine.retryVideo({ ownerId: OWNER_A, expectedVersion: 1 });
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) assert.deepEqual([r.packId, r.version, r.voiceKey], [made.packId, 1, 'olivia']);
  const after = (await renderRow(h))!;
  assert.deepEqual([after.id, after.state, after.attempts, after.errorCode, after.voiceKey, after.costPence], [row.id, 'queued', 0, null, 'olivia', 7]);
  assert.equal(await slotStatus(h), 'queued');
  assert.deepEqual(h.deleted, [], 'the cached voice is kept: a retry never pays for the voice twice');
  const pack = (await h.store.getPack(OWNER_A))!;
  assert.deepEqual([pack.version, pack.voiceChanges, pack.regenCount, pack.status], [1, 0, 0, 'preview']);
});

test('retryVideo: refused for voice_unavailable (change the voice instead), bad_brief, a queued or running render, an approved pack, another owner', async () => {
  const h = harness();
  await first(h);
  const refused = async (expected: string, who = OWNER_A) => {
    const before = await snapshot(h);
    const r = await h.engine.retryVideo({ ownerId: who });
    assert.ok(!r.ok && r.code === expected, `${expected}: ${JSON.stringify(r)}`);
    assert.equal(await snapshot(h), before);
  };
  await refused('not_retryable'); // queued
  await h.setRender(OWNER_A, { state: 'failed', errorCode: 'voice_unavailable' });
  await refused('not_retryable');
  await h.setRender(OWNER_A, { state: 'failed', errorCode: 'bad_brief' });
  await refused('not_retryable');
  await h.setRender(OWNER_A, { state: 'running' });
  await refused('video_running');
  await h.setRender(OWNER_A, { state: 'failed', errorCode: 'timeout' });
  await refused('no_pack', OWNER_B);
  await h.finishVideo(OWNER_A);
  await refused('not_retryable'); // done: nothing to retry
  assert.ok((await h.engine.approvePack({ ownerId: OWNER_A })).ok);
  await h.setRender(OWNER_A, { state: 'failed', errorCode: 'timeout' });
  await refused('after_approval');
});

test('retryVideo: the cost caps apply before a retry is queued', async () => {
  const h = harness();
  await first(h);
  await h.setRender(OWNER_A, { state: 'failed', errorCode: 'sandbox_failed' });
  h.store.settings.maxRawPence = 1;
  const before = await snapshot(h);
  const r = await h.engine.retryVideo({ ownerId: OWNER_A });
  assert.ok(!r.ok && r.code === 'cost_cap');
  assert.equal(await snapshot(h), before);
  h.store.settings.maxRawPence = 500;
  h.store.settings.monthlyCapPence = 1;
  const m = await h.engine.retryVideo({ ownerId: OWNER_A });
  assert.ok(!m.ok && m.code === 'monthly_cap');
});

// ── The screen's read model ──

test('listPackForOwner exposes the video state and the render row, so the screen can poll and explain', async () => {
  const h = harness();
  await first(h);
  let v = (await h.engine.listPackForOwner(OWNER_A))!;
  assert.deepEqual(v.video, { status: 'queued', code: null, message: VIDEO_MESSAGES.video_pending, poll: true, canRetry: false });
  assert.deepEqual(v.render, { state: 'queued', errorCode: null, attempts: 0, voiceKey: 'jane', retryable: false });
  assert.equal(v.voice.key, 'jane');
  assert.equal(v.voice.changesLeft, 1);
  assert.equal(v.voice.canChange, true);

  await h.setRender(OWNER_A, { state: 'running' });
  v = (await h.engine.listPackForOwner(OWNER_A))!;
  assert.equal(v.video.status, 'making');
  assert.equal(v.video.poll, true);
  assert.equal(v.voice.canChange, false);
  assert.equal(v.voice.blocked?.code, 'video_running');

  await h.finishVideo(OWNER_A);
  v = (await h.engine.listPackForOwner(OWNER_A))!;
  assert.deepEqual(v.video, { status: 'ready', code: null, message: null, poll: false, canRetry: false });
  assert.equal(v.render?.state, 'done');
  const slot = v.ads.find((a) => a.angle === '5b')!.files.video;
  assert.ok(slot && slot.status === 'ready' && slot.videos.length === 3 && slot.poster.name === 'notice-poster.png');
  assert.deepEqual(v.approval, { ok: true });
});

// ── Downloads of the video files ──

test('download: the owner gets the three videos and the poster once the video is ready; nobody else does; the voice files never', async () => {
  const h = harness();
  await first(h);
  const ad = await ad5b(h);
  const sign = async (path: string) => `https://signed.example.test/${path}`;
  const names = ['notice-9x16.mp4', 'notice-4x5.mp4', 'notice-1x1.mp4', 'notice-poster.png'];
  // Not before the video exists.
  for (const n of names) assert.equal(await downloadPath(h.store, OWNER_A, ad.id, n), null, n);
  await h.finishVideo(OWNER_A);
  const pack = (await h.store.getPack(OWNER_A))!;
  for (const n of names) {
    assert.equal(await downloadPath(h.store, OWNER_A, ad.id, n), `${OWNER_A}/${pack.id}/v1/${n}`, n);
    assert.equal(await signedDownloadUrlWith(h.store, sign, OWNER_A, ad.id, n), `https://signed.example.test/${OWNER_A}/${pack.id}/v1/${n}`);
    assert.equal(await downloadPath(h.store, OWNER_B, ad.id, n), null, `${n} for another owner`);
    assert.equal(await signedDownloadUrlWith(h.store, sign, OWNER_B, ad.id, n), null);
  }
  for (const n of ['voice.mp3', 'script.json', 'notice-9x16.mov', '../voice.mp3']) assert.equal(await downloadPath(h.store, OWNER_A, ad.id, n), null, n);
  // A video path outside the owner's folder is never signed.
  const live = h.store.ads.get(ad.id)!;
  if (live.files.video && live.files.video.status === 'ready') live.files.video.videos[0].path = `${OWNER_B}/x/v1/notice-9x16.mp4`;
  assert.equal(await downloadPath(h.store, OWNER_A, ad.id, 'notice-9x16.mp4'), null);
  // The image ads' files still download as before.
  const a3 = (await h.store.listAds(OWNER_A, pack.id)).find((a) => a.angle === '3a')!;
  assert.ok(await downloadPath(h.store, OWNER_A, a3.id, a3.files.images[0].name));
});

test('readyVideo is the shape the worker writes (names, sizes, the poster)', () => {
  const v = readyVideo(OWNER_A, 'p1', 2, 'oliver');
  assert.deepEqual(v.videos.map((f) => [f.name, f.width, f.height]), [['notice-9x16.mp4', 1080, 1920], ['notice-4x5.mp4', 1080, 1350], ['notice-1x1.mp4', 1080, 1080]]);
  assert.equal(v.voice, 'oliver');
  assert.ok(v.videos.every((f) => f.path.startsWith(`${OWNER_A}/p1/v2/`)));
});
