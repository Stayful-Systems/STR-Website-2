import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Harness } from './test-store.ts';
import { runRenderQueue, type RenderDeps } from './render-core.ts';
import { DEFAULT_RENDER_SETTINGS, kindOf, type RenderRow } from './render-store.ts';
import { FakeSandboxes, FakeStorage } from './render-test-store.ts';
import { EXAMPLE_OUT, type ExampleDeps } from './example-step.ts';
import { buildBriefScript, cleanLines, joinScriptLines } from './captions.ts';
import { makeAlignment } from './voice-test-support.ts';
import { sampleAnalysis } from '../pdf/__fixtures__/sample.ts';
import { THUMB, type PictureStats } from './ld-gate.ts';
import type { AdPackStore, PackAdRow } from './store-types.ts';
import type { SynthesiseResult } from './voice-core.ts';

/** Batch 55 step 5 (Phase 2, 55c A3): the phone and loupe videos on fakes (no sandbox, no ElevenLabs, no engine). */

const OWNER = '3f9a2c11-1111-4111-8111-111111111111';
const APP_HOST = 'stay' + 'ful.co.uk';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 1, 2, 3]);

function stats(kind: 'flat' | 'h' | 'v', tint: [number, number, number]): PictureStats {
  const hist = new Array(64).fill(0);
  const thumb: number[] = [];
  for (let y = 0; y < THUMB; y++)
    for (let x = 0; x < THUMB; x++) {
      const v = kind === 'flat' ? 240 : kind === 'h' ? (x * 255) / 31 : (y * 255) / 31;
      thumb.push(v);
      const r = Math.min(3, Math.floor(Math.min(255, v * tint[0]) / 64));
      const g = Math.min(3, Math.floor(Math.min(255, v * tint[1]) / 64));
      const b = Math.min(3, Math.floor(Math.min(255, v * tint[2]) / 64));
      hist[r * 16 + g * 4 + b] += 1 / (THUMB * THUMB);
    }
  return { hist, thumb };
}

function okSynth(lines: readonly string[]): SynthesiseResult {
  const clean = cleanLines(lines);
  return { ok: true, audio: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), mimeType: 'audio/mpeg', script: buildBriefScript(clean, makeAlignment(joinScriptLines(clean))), costPence: 3.2, characters: joinScriptLines(clean).length };
}

type Rig = { h: Harness; deps: RenderDeps; sandboxes: FakeSandboxes; storage: FakeStorage; synth: string[][]; frames: Record<'phone' | 'loupe', PictureStats> };

async function rig(o: { loupeFails?: boolean; carousel?: PictureStats } = {}): Promise<Rig> {
  const h = harness({ exampleReports: true });
  const made = await h.engine.generatePack({
    ownerId: OWNER,
    by: 'operator',
    input: { areaKey: 'NG7', photos: [], brand: { company: 'Brightstone Stays', logoUrl: null, brandColour: '#1F6F5C', feePct: 12, areas: ['Nottingham'], photoUrl: null }, domain: APP_HOST, route: 'leaddb', sitePath: 'brightstone-calc', typeOnly: true },
  });
  assert.ok(made.ok && !made.dry, JSON.stringify(made));
  const advance = (ms: number) => (h.now = new Date(h.now.getTime() + ms));
  const frames = { phone: stats('h', [1, 0.3, 0.3]), loupe: stats('v', [0.3, 0.3, 1]) };
  const sandboxes = new FakeSandboxes(advance);
  const info = (k: 'phone' | 'loupe') => new TextEncoder().encode(JSON.stringify({ captions: 9, scenes: ['L1', 'L2', 'L3', 'L4', 'L5'], duration: 20, first_frame: frames[k] }));
  let current: 'phone' | 'loupe' | null = null;
  sandboxes.opts.onRun = (cmd, sb) => {
    advance(5_000);
    if (cmd.args[0] === 'ad-render/report_walk.py') current = 'phone';
    if (cmd.args[0] === 'ad-render/loupe.py') {
      current = 'loupe';
      if (o.loupeFails) return { exitCode: 1, stderr: 'ERR render_failed\n', timedOut: false };
    }
    if (cmd.cmd === 'ffprobe') {
      const f = cmd.args[cmd.args.length - 1];
      const height = f.includes('9x16') ? 1920 : f.includes('4x5') ? 1350 : 1080;
      return { exitCode: 0, stderr: '', timedOut: false, stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height }, { codec_type: 'audio' }], format: { duration: '20.0' } }) };
    }
    if (current && cmd.args[0]?.startsWith('ad-render/')) {
      for (const s of ['9x16', '4x5', '1x1']) sb.files.set(`out/${current}_${s}.mp4`, MP4);
      sb.files.set('out/poster.png', PNG);
      sb.files.set('out/render-info.json', info(current));
    }
    return { exitCode: 0, stderr: '', timedOut: false };
  };
  sandboxes.opts.outputs = {
    [`${EXAMPLE_OUT}/pages.json`]: new TextEncoder().encode(
      JSON.stringify({ pages: [1, 2, 3, 4].map((i) => ({ file: `page-${i}.png`, width: 1190, height: 1684, masked: 3, stamped: true })), targets: [0.5, 0.1, 0.3].map((y, i) => ({ page: i, x: 0.04, y, w: 0.92, h: 0.22 })) }),
    ),
    ...Object.fromEntries([1, 2, 3, 4].map((i) => [`${EXAMPLE_OUT}/page-${i}.png`, PNG])),
  };
  const storage = new FakeStorage();
  const synth: string[][] = [];
  const example: ExampleDeps = {
    runExample: async () => ({ result: sampleAnalysis(), costPence: 60 }),
    snapshotRow: async () => null,
    renderPdf: async () => new TextEncoder().encode('%PDF-1.4'),
    renderPhoneFrames: async () => [PNG, PNG],
    measurePng: async () => o.carousel ?? stats('flat', [1, 1, 1]),
    renderCarousel: async () => [{ name: '3a-card1-9x16.png', width: 1080, height: 1920, png: PNG }],
  };
  const deps: RenderDeps = {
    packs: h.store as AdPackStore,
    renders: h.renders,
    sandbox: sandboxes.factory,
    synth: async (i) => {
      synth.push([...i.lines]);
      return okSynth(i.lines);
    },
    storage,
    fetchImage: async () => ({ bytes: PNG, contentType: null }),
    rendererFiles: async (list) => (list ?? []).map((p) => ({ path: `ad-render/${p}`, content: new TextEncoder().encode('#') })),
    sandboxCpuSecondPence: async () => 0.00280889,
    renderSettings: async () => ({ ...DEFAULT_RENDER_SETTINGS }),
    now: () => h.now,
    example,
  };
  // The example report first; it queues the two videos.
  const ex = await runRenderQueue(deps);
  assert.equal(ex.results[0].outcome, 'done', JSON.stringify(ex.results));
  return { h, deps, sandboxes, storage, synth, frames };
}

const rows = (r: Rig): RenderRow[] => [...r.h.renders.rows.values()];
const ad = (r: Rig, angle: string): PackAdRow => [...r.h.store.ads.values()].find((a) => a.angle === angle)!;
const briefOf = (r: Rig, script: string) => {
  const sb = r.sandboxes.created.find((c) => c.sandbox.commands.some((x) => x.args[0] === script))!.sandbox;
  return JSON.parse(new TextDecoder().decode(sb.files.get('brief.json')!));
};

test('both videos: brief v2 with the concept, format, five screen lines, stamp and pages; each with a voice of its own', async () => {
  const r = await rig();
  const res = await runRenderQueue(r.deps, { limit: 2 });
  assert.deepEqual(res.results.map((x) => x.outcome), ['done', 'done'], JSON.stringify(res.results));
  const phone = briefOf(r, 'ad-render/report_walk.py');
  assert.equal(phone.version, 2);
  assert.equal(phone.format, 'phone_recording');
  assert.equal(phone.concept_id, '5b-tenant-leaving');
  assert.equal(phone.stamp, 'Example report');
  assert.equal(phone.screen_lines.length, 5);
  assert.equal(phone.screen_lines[4], 'Get your free income report');
  assert.equal(phone.phone_frames.length, 2);
  assert.equal(phone.report_pages.length, 4);
  const loupe = briefOf(r, 'ad-render/loupe.py');
  assert.equal(loupe.format, 'loupe');
  assert.equal(loupe.targets.length, 3);
  assert.equal(loupe.base, '#F5F4ED');
  // A voiceover on every video, each from its own script; the first line is the offer.
  assert.equal(r.synth.length, 2);
  for (const lines of r.synth) {
    assert.match(lines[0], /free/i);
    assert.equal(lines.at(-1), 'Get your free income report.');
  }
  assert.ok(r.storage.puts.some((p) => p.endsWith('/voice-phone.mp3')) && r.storage.puts.some((p) => p.endsWith('/voice-loupe.mp3')));
  // Both slots are ready, the video check ran for each, and approval is open.
  assert.equal(ad(r, '5b').files.video?.status, 'ready');
  assert.equal(ad(r, '17').files.video?.status, 'ready');
  const pack = (await r.h.store.getPack(OWNER))!;
  assert.equal(pack.checks?.ok, true, JSON.stringify(pack.checks?.failures));
  assert.ok(pack.checks!.results.some((x) => x.check === 'ld_picture' && x.ok));
  const view = await r.h.engine.listPackForOwner(OWNER);
  assert.equal(view?.approval.ok, true, JSON.stringify(view?.approval));
  // The cost stays under the generation's ceiling.
  assert.ok(pack.costPence <= r.h.store.settings.maxRawPence, String(pack.costPence));
});

test('the picture measure fails a pack whose ads start alike, with a plain reason', async () => {
  const r = await rig({ carousel: undefined });
  r.frames.loupe = r.frames.phone;
  await runRenderQueue(r.deps, { limit: 2 });
  const pack = (await r.h.store.getPack(OWNER))!;
  assert.equal(pack.status, 'checks_failed');
  const f = pack.checks!.failures.find((x) => x.rule === 'picture_similar')!;
  assert.ok(f && /start too much alike/.test(f.detail));
});

test('approval waits for the loupe as well as the phone video', async () => {
  const r = await rig();
  await runRenderQueue(r.deps, { limit: 1 });
  const view = await r.h.engine.listPackForOwner(OWNER);
  assert.equal(view?.approval.ok, false);
});

test('a loupe that fails for good leaves 17 on its type-only cards, recorded; the pack is still approvable', async () => {
  const r = await rig({ loupeFails: true });
  for (let i = 0; i < DEFAULT_RENDER_SETTINGS.maxAttempts + 1; i++) await runRenderQueue(r.deps, { limit: 2 });
  const loupe = rows(r).find((x) => kindOf(x) === 'loupe')!;
  assert.equal(loupe.state, 'failed');
  assert.equal(ad(r, '17').format, 'type_cards');
  assert.equal(ad(r, '17').files.video, null);
  assert.ok(ad(r, '17').files.images.length > 0);
  const view = await r.h.engine.listPackForOwner(OWNER);
  assert.equal(view?.approval.ok, true, JSON.stringify(view?.approval));
});
