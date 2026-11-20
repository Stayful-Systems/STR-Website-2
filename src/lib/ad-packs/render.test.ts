import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildBriefScript, cleanLines, joinScriptLines, validateBriefScript } from './captions.ts';
import { harness, type Harness } from './test-store.ts';
import { makeAlignment } from './voice-test-support.ts';
import {
  attemptPence,
  BRIEF_PATH,
  briefProblems,
  buildBrief,
  enqueueRender,
  figureForBrief,
  isSafeRelative,
  loadRendererFiles,
  parseProbe,
  parseRenderInfo,
  RENDERER_FILES,
  renderErrCode,
  runRenderQueue,
  scriptLinesOf,
  wholePence,
  type Brief,
  type RenderDeps,
  type RenderReport,
} from './render-core.ts';
import { DEFAULT_RENDER_SETTINGS, parseAdVideo, parseRenderSettings, type RenderSettings } from './render-store.ts';
import { FakeSandboxes, FakeStorage, type MemoryRenderStore } from './render-test-store.ts';
import type { AdPackStore, PackAdRow, VideoBrand } from './store-types.ts';
import { estimateVoicePence, type SynthesiseResult } from './voice-core.ts';

/**
 * Batch 38b (B4): the render worker on in-memory fakes. No network, no real
 * sandbox, no database, no server-only. The pack and its 5b ad are made by the
 * real generator (generate-core) so the script, figure and fee are real.
 */

const OWNER = '3f9a2c11-1111-4111-8111-111111111111';
const CPU_SECOND_PENCE = 0.00280889;

const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5, 6, 7]);
const RENDER_INFO = new TextEncoder().encode(JSON.stringify({ captions: 17, scenes: ['L1', 'L2', 'L3', 'L4', 'L5'], duration: 38.03 }));
const OUTPUT_FILES: Record<string, Uint8Array> = {
  'out/notice_9x16.mp4': MP4,
  'out/notice_4x5.mp4': MP4,
  'out/notice_1x1.mp4': MP4,
  'out/poster.png': PNG,
  'out/render-info.json': RENDER_INFO,
};

/** What ffprobe prints for one of the three files (a video stream, an audio stream, the container length). */
function probeJson(file: string, over: { height?: number; audio?: boolean; duration?: string } = {}): string {
  const height = over.height ?? (file.includes('9x16') ? 1920 : file.includes('4x5') ? 1350 : 1080);
  return JSON.stringify({
    streams: [{ codec_type: 'video', width: 1080, height }, ...(over.audio === false ? [] : [{ codec_type: 'audio' }])],
    format: { duration: over.duration ?? '38.033333' },
  });
}
/** The sandbox's answer to a command in a healthy render: success, and ffprobe's JSON on stdout. */
function healthy(r: { advance: (ms: number) => void }, over: Parameters<typeof probeJson>[1] = {}) {
  return (cmd: { cmd: string; args: string[] }) => {
    r.advance(10_000);
    if (cmd.cmd === 'ffprobe') return { exitCode: 0, stderr: '', timedOut: false, stdout: probeJson(cmd.args[cmd.args.length - 1], over) };
    return { exitCode: 0, stderr: '', timedOut: false };
  };
}

const SECRET_TEXT = 'Brightstone Stays';
const LOGO = 'https://cdn.example.test/logo.png';

type Rig = {
  h: Harness;
  renders: MemoryRenderStore;
  sandboxes: FakeSandboxes;
  storage: FakeStorage;
  synthCalls: { voiceKey: string; lines: readonly string[]; packId: string }[];
  logs: { event: string; fields: Record<string, unknown> }[];
  settings: RenderSettings;
  /** Edit the 5b ad's pinned brand snapshot (what the worker reads); the live website settings are not read at all. */
  snap: (patch: Partial<VideoBrand>) => void;
  synthResult: { value: (lines: readonly string[]) => SynthesiseResult };
  deps: RenderDeps;
  packId: string;
  advance: (ms: number) => void;
  run: (opts?: { dry?: boolean; limit?: number }) => Promise<RenderReport>;
  row: () => ReturnType<MemoryRenderStore['rows']['get']>;
  ad5b: () => PackAdRow;
};

function okSynth(lines: readonly string[]): SynthesiseResult {
  const clean = cleanLines(lines);
  return {
    ok: true,
    audio: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]),
    mimeType: 'audio/mpeg',
    script: buildBriefScript(clean, makeAlignment(joinScriptLines(clean))),
    costPence: 3.2,
    characters: joinScriptLines(clean).length,
  };
}

async function rig(opts: { fee?: number | null; settings?: Partial<RenderSettings>; queue?: boolean } = {}): Promise<Rig> {
  const h = harness();
  const made = await h.engine.generatePack({
    ownerId: OWNER,
    by: 'operator',
    input: {
      areaKey: 'NG7',
      photos: ['https://cdn.example.test/photo-1.jpg'],
      brand: { company: SECRET_TEXT, logoUrl: LOGO, brandColour: '#1F6F5C', feePct: opts.fee === undefined ? 12 : opts.fee, areas: ['Nottingham'], photoUrl: null },
      domain: 'brightstone.co.uk',
      websiteId: '00000000-0000-4000-8000-0000000000aa',
    },
  });
  assert.ok(made.ok && !made.dry);
  const packId = (made as { packId: string }).packId;

  const advance = (ms: number) => {
    h.now = new Date(h.now.getTime() + ms);
  };
  // The generator's own render queue is the worker's queue, as in the app (generate enqueues, the cron drains it).
  const renders = h.renders;
  const sandboxes = new FakeSandboxes(advance);
  sandboxes.opts.outputs = OUTPUT_FILES;
  sandboxes.opts.onRun = healthy({ advance });
  const storage = new FakeStorage();
  const synthCalls: Rig['synthCalls'] = [];
  const logs: Rig['logs'] = [];
  const synthResult = { value: okSynth as (lines: readonly string[]) => SynthesiseResult };
  const settings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS, ...(opts.settings ?? {}) };

  const deps: RenderDeps = {
    packs: h.store as AdPackStore,
    renders,
    sandbox: sandboxes.factory,
    synth: async (i) => {
      synthCalls.push({ voiceKey: i.voiceKey, lines: i.lines, packId: i.packId });
      return synthResult.value(i.lines);
    },
    storage,
    fetchImage: async (ref) => ({ bytes: ref.includes('logo') ? PNG : JPG, contentType: null }),
    rendererFiles: async () => [
      { path: 'ad-render/notice.py', content: new TextEncoder().encode('# notice') },
      { path: 'ad-render/requirements.txt', content: new TextEncoder().encode('Pillow') },
    ],
    sandboxCpuSecondPence: async () => CPU_SECOND_PENCE,
    renderSettings: async () => settings,
    now: () => h.now,
    log: (event, fields) => logs.push({ event, fields }),
  };
  if (opts.queue === false) renders.rows.clear();
  else await renders.enqueue(packId, 1, 'jane');
  renders.writes.length = 0;
  return {
    h,
    renders,
    sandboxes,
    storage,
    synthCalls,
    logs,
    settings,
    snap: (patch) => {
      const ad = [...h.store.ads.values()].find((a) => a.angle === '5b' && a.version === 1)!;
      ad.texts = { ...ad.texts, brand: { ...ad.texts.brand!, ...patch } };
    },
    synthResult,
    deps,
    packId,
    advance,
    run: (o) => runRenderQueue(deps, o),
    row: () => [...renders.rows.values()][0],
    ad5b: () => [...h.store.ads.values()].find((a) => a.angle === '5b' && a.version === 1)!,
  };
}

const COMMANDS = [
  { cmd: 'apt-get', args: ['update', '-qq'], sudo: true },
  { cmd: 'apt-get', args: ['install', '-y', '-qq', '--no-install-recommends', 'ffmpeg'], sudo: true },
  { cmd: 'python3', args: ['-m', 'venv', '/tmp/venv'], sudo: undefined },
  { cmd: '/tmp/venv/bin/pip', args: ['install', '--quiet', '--disable-pip-version-check', '-r', 'ad-render/requirements.txt'], sudo: undefined },
  { cmd: '/tmp/venv/bin/python', args: ['ad-render/notice.py', '--brief', 'brief.json'], sudo: undefined },
  ...['notice_9x16.mp4', 'notice_4x5.mp4', 'notice_1x1.mp4'].map((f) => ({ cmd: 'ffprobe', args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', `out/${f}`], sudo: undefined })),
];

function failRender(r: Rig, stderr = `Traceback (most recent call last): ${SECRET_TEXT} 12 Acacia Road\nERR missing_asset\n`) {
  const ok = healthy(r);
  r.sandboxes.opts.onRun = (cmd) => (cmd.args[0] === 'ad-render/notice.py' ? (r.advance(10_000), { exitCode: 1, stderr, timedOut: false }) : ok(cmd));
}

// ── The happy path ──

test('a render: the exact command sequence, sudo on apt only, args arrays, no secrets, sandbox stopped', async () => {
  const r = await rig();
  const report = await r.run();
  assert.equal(report.claimed, 1);
  assert.equal(report.results[0].outcome, 'done');

  assert.equal(r.sandboxes.created.length, 1);
  const { sandbox, vcpus, timeoutMs } = r.sandboxes.created[0];
  assert.equal(vcpus, 2);
  assert.equal(timeoutMs, 270_000);
  assert.deepEqual(
    sandbox.commands.map((c) => ({ cmd: c.cmd, args: c.args, sudo: c.sudo })),
    COMMANDS,
  );
  for (const c of sandbox.commands) {
    assert.ok(Array.isArray(c.args));
    assert.ok(c.args.every((a) => typeof a === 'string' && !/[;&|`$]/.test(a)), 'no shell syntax in an argument');
    assert.ok(c.timeoutMs > 0 && c.timeoutMs <= 270_000, 'every command has a timeout');
    assert.equal(Boolean(c.sudo), c.cmd === 'apt-get', 'sudo only on apt');
    // The only environment any command gets is the non-interactive flag for apt.
    assert.ok(c.env === undefined || (Object.keys(c.env).length === 1 && c.env.DEBIAN_FRONTEND === 'noninteractive'));
  }
  assert.equal(sandbox.stopped, 1);
  // The factory is given a size and a time limit, nothing else (so no env, no secrets).
  assert.deepEqual(Object.keys(r.sandboxes.created[0]).sort(), ['sandbox', 'timeoutMs', 'vcpus']);
});

test('what goes into the sandbox: renderer files, brief.json, the voice and the assets, all relative', async () => {
  const r = await rig();
  await r.run();
  const files = r.sandboxes.created[0].sandbox.files;
  assert.ok(files.has('ad-render/notice.py'));
  assert.ok(files.has(BRIEF_PATH));
  assert.ok(files.has('voice.mp3'));
  assert.ok(files.has('assets/logo.png'));
  assert.ok(files.has('assets/photo1.jpg'));
  for (const p of files.keys()) assert.ok(isSafeRelative(p), p);
});

test('brief.json matches the contract: version, brand, photos, script validated, paths inside the folder', async () => {
  const r = await rig();
  await r.run();
  const brief = JSON.parse(new TextDecoder().decode(r.sandboxes.created[0].sandbox.files.get(BRIEF_PATH))) as Brief;
  assert.deepEqual(Object.keys(brief).sort(), ['area', 'audio', 'bedrooms', 'brand', 'fee_sentence', 'figure', 'out_dir', 'photos', 'script', 'version']);
  assert.equal(brief.version, 1);
  assert.deepEqual(brief.brand, { company: SECRET_TEXT, colour: '#1F6F5C', logo: 'assets/logo.png' });
  assert.deepEqual(brief.photos, ['assets/photo1.jpg']);
  assert.equal(brief.audio, 'voice.mp3');
  assert.equal(brief.out_dir, 'out');
  assert.equal(brief.area, 'Lenton, Nottingham');
  assert.equal(brief.bedrooms, 3);
  assert.equal(brief.fee_sentence, 'Our management fee is 12%.');
  assert.ok(brief.figure);
  assert.ok(['take-home', 'net', 'gross'].includes(brief.figure.basis));
  assert.match(brief.figure.label, /^Example: a typical 3-bed/);
  assert.ok(brief.figure.takeHome !== null || brief.figure.net !== null || brief.figure.gross !== null);
  assert.equal(validateBriefScript(brief.script).ok, true);
  assert.deepEqual(brief.script.lines.map((l) => l.id), ['L1', 'L2', 'L3', 'L4', 'L5']);
  assert.deepEqual(briefProblems(brief), []);
  // The script lines are exactly what the operator sees on screen.
  assert.deepEqual(brief.script.lines.map((l) => l.text), scriptLinesOf(r.ad5b()));
  for (const p of [brief.brand.logo, brief.audio, brief.out_dir, ...brief.photos]) assert.ok(isSafeRelative(p), String(p));
});

test('no fee set: no fee line in the brief, and the voice never says one', async () => {
  const r = await rig({ fee: null });
  await r.run();
  const brief = JSON.parse(new TextDecoder().decode(r.sandboxes.created[0].sandbox.files.get(BRIEF_PATH))) as Brief;
  assert.equal(brief.fee_sentence, null);
  assert.ok(!/management fee/i.test(brief.script.lines.map((l) => l.text).join(' ')));
});

test('a fee line only when the voice says it too (a snapshot fee line the script never says is left out)', async () => {
  const r = await rig({ fee: null });
  r.snap({ feeSentence: 'Our management fee is 15%.' });
  await r.run();
  const brief = JSON.parse(new TextDecoder().decode(r.sandboxes.created[0].sandbox.files.get(BRIEF_PATH))) as Brief;
  assert.equal(brief.fee_sentence, null);
});

test('files: the outputs are stored under <owner>/<pack>/v1/ with hyphen names and the 5b ad gets the ready shape', async () => {
  const r = await rig();
  const before = r.ad5b().files.images;
  await r.run();
  const folder = `${OWNER}/${r.packId}/v1`;
  for (const name of ['notice-9x16.mp4', 'notice-4x5.mp4', 'notice-1x1.mp4', 'notice-poster.png', 'voice.mp3', 'script.json']) {
    assert.ok(r.storage.files.has(`${folder}/${name}`), name);
  }
  assert.equal(r.storage.files.get(`${folder}/notice-9x16.mp4`)?.contentType, 'video/mp4');
  assert.equal(r.storage.files.get(`${folder}/notice-poster.png`)?.contentType, 'image/png');

  const video = parseAdVideo((r.ad5b().files as unknown as { video: unknown }).video);
  assert.ok(video && video.status === 'ready');
  assert.deepEqual(video.videos.map((v) => [v.name, v.width, v.height]), [
    ['notice-9x16.mp4', 1080, 1920],
    ['notice-4x5.mp4', 1080, 1350],
    ['notice-1x1.mp4', 1080, 1080],
  ]);
  assert.equal(video.poster.path, `${folder}/notice-poster.png`);
  assert.ok(video.durationSeconds > 20);
  assert.equal(video.voice, 'jane');
  for (const f of [...video.videos, video.poster]) {
    assert.ok(f.path.startsWith(`${OWNER}/`) && !f.path.includes('..'));
    assert.ok(f.bytes > 0);
  }
  // The image list of the ad is untouched.
  assert.deepEqual(r.ad5b().files.images, before);

  const row = r.row()!;
  assert.equal(row.state, 'done');
  assert.equal(row.errorCode, null);
  assert.equal(row.attempts, 1);
  assert.equal(row.sandboxId, 'sbx-1');
  assert.ok(row.finishedAt);
  assert.deepEqual(row.files, video);
  assert.equal(row.leaseUntil, null);
});

// ── Failure, retry, attempts ──

test('a render failure stops the sandbox, goes back to queued with a short code, and stores no stderr', async () => {
  const r = await rig();
  failRender(r);
  const report = await r.run();
  assert.equal(report.results[0].outcome, 'queued');
  assert.equal(report.results[0].code, 'missing_asset');
  assert.equal(r.sandboxes.created[0].sandbox.stopped, 1);
  const row = r.row()!;
  assert.equal(row.state, 'queued');
  assert.equal(row.errorCode, 'missing_asset');
  assert.equal(row.attempts, 1);
  assert.equal(row.files, null);
  // No video was written: the ad's slot goes back to queued for the retry (it was 'making' while the worker had it).
  assert.equal((r.ad5b().files.video as { status: string }).status, 'queued');
});

test('any other renderer exit is render_failed; the sandbox is stopped on every failure path', async () => {
  for (const [stderr, expected] of [['', 'render_failed'], ['ERR ffmpeg_failed\n', 'ffmpeg_failed'], ['ERR something_else\n', 'render_failed']] as const) {
    const r = await rig();
    failRender(r, stderr);
    const report = await r.run();
    assert.equal(report.results[0].code, expected);
    assert.equal(r.sandboxes.created[0].sandbox.stopped, 1);
  }
});

test('a setup command failing (apt, pip) is a sandbox/ffmpeg code, and the sandbox is stopped', async () => {
  const r = await rig();
  r.sandboxes.opts.onRun = (cmd) => {
    r.advance(5_000);
    return { exitCode: cmd.args[0] === 'install' && cmd.cmd === 'apt-get' ? 100 : 0, stderr: 'E: could not resolve', timedOut: false };
  };
  const report = await r.run();
  assert.equal(report.results[0].code, 'ffmpeg_failed');
  assert.equal(r.sandboxes.created[0].sandbox.stopped, 1);
  assert.equal(r.sandboxes.created[0].sandbox.commands.length, 2, 'it stops at the first failing command');
});

test('a sandbox that cannot be created is sandbox_failed (nothing to stop, nothing leaked)', async () => {
  const r = await rig();
  r.sandboxes.opts.failCreate = true;
  const report = await r.run();
  assert.equal(report.results[0].code, 'sandbox_failed');
  assert.equal(r.row()!.errorCode, 'sandbox_failed');
  assert.ok(!JSON.stringify([...r.renders.rows.values()]).includes('token'));
});

test('a command that times out is `timeout`, and an exhausted time budget is `timeout` before the next command', async () => {
  const a = await rig();
  a.sandboxes.opts.onRun = (cmd) => {
    a.advance(1000);
    return cmd.cmd === 'python3' ? { exitCode: 137, stderr: '', timedOut: true } : { exitCode: 0, stderr: '', timedOut: false };
  };
  assert.equal((await a.run()).results[0].code, 'timeout');
  assert.equal(a.sandboxes.created[0].sandbox.stopped, 1);

  const b = await rig();
  b.sandboxes.opts.onRun = () => {
    b.advance(200_000); // two commands use up the 270 s
    return { exitCode: 0, stderr: '', timedOut: false };
  };
  const rep = await b.run();
  assert.equal(rep.results[0].code, 'timeout');
  assert.equal(b.sandboxes.created[0].sandbox.commands.length, 2);
  assert.equal(b.sandboxes.created[0].sandbox.stopped, 1);
});

test('a missing or odd output file is render_failed (and the sandbox is stopped)', async () => {
  const r = await rig();
  r.sandboxes.opts.outputs = { ...OUTPUT_FILES, 'out/notice_1x1.mp4': new Uint8Array([1, 2, 3]) };
  assert.equal((await r.run()).results[0].code, 'render_failed');
  assert.equal(r.sandboxes.created[0].sandbox.stopped, 1);
  const s = await rig();
  s.sandboxes.opts.outputs = { ...OUTPUT_FILES };
  delete s.sandboxes.opts.outputs['out/poster.png'];
  assert.equal((await s.run()).results[0].code, 'render_failed');
});

test('an upload that fails is upload_failed and the sandbox was already stopped', async () => {
  const r = await rig();
  r.storage.failPut = (p) => p.endsWith('notice-4x5.mp4');
  const report = await r.run();
  assert.equal(report.results[0].code, 'upload_failed');
  assert.equal(r.sandboxes.created[0].sandbox.stopped, 1);
  assert.equal(r.row()!.state, 'queued');
});

test('attempts: queued, queued, then failed at max attempts; the code stays on the row', async () => {
  const r = await rig();
  failRender(r);
  const states: string[] = [];
  for (let i = 0; i < 4; i++) {
    const rep = await r.run();
    states.push(rep.results[0]?.outcome ?? 'none');
    r.advance(5 * 60_000);
  }
  assert.deepEqual(states, ['queued', 'queued', 'failed', 'none']);
  const row = r.row()!;
  assert.equal(row.attempts, 3);
  assert.equal(row.state, 'failed');
  assert.equal(row.errorCode, 'missing_asset');
  assert.ok(row.finishedAt);
  assert.equal(r.sandboxes.created.length, 3);
});

test('max attempts comes from the setting', async () => {
  const r = await rig({ settings: { maxAttempts: 1 } });
  failRender(r);
  assert.equal((await r.run()).results[0].outcome, 'failed');
});

// ── Voice ──

test('a retry reuses the stored voice: the voice is bought once', async () => {
  const r = await rig();
  failRender(r);
  await r.run();
  assert.equal(r.synthCalls.length, 1);
  const folder = `${OWNER}/${r.packId}/v1`;
  assert.ok(r.storage.files.has(`${folder}/voice.mp3`));
  assert.ok(r.storage.files.has(`${folder}/script.json`));

  r.sandboxes.opts.onRun = healthy(r);
  const second = await r.run();
  assert.equal(second.results[0].outcome, 'done');
  assert.equal(r.synthCalls.length, 1, 'synthesise was not called again');
  // The voice was paid for on the first attempt only.
  const voicePence = 3.2;
  const first = wholePence(attemptPence({ vcpus: 2, seconds: 50, cpuSecondPence: CPU_SECOND_PENCE, voicePence }));
  const again = wholePence(attemptPence({ vcpus: 2, seconds: 50, cpuSecondPence: CPU_SECOND_PENCE, voicePence: 0 }));
  assert.equal(r.row()!.costPence, first + again);
});

test('a stored voice that no longer matches the script is made again', async () => {
  const r = await rig();
  const folder = `${OWNER}/${r.packId}/v1`;
  const other = okSynth(['One. Two. Three.', 'Four five six.', 'Seven eight nine.']);
  assert.ok(other.ok);
  await r.storage.put(`${folder}/voice.mp3`, other.audio, 'audio/mpeg');
  await r.storage.put(`${folder}/script.json`, new TextEncoder().encode(JSON.stringify(other.script)), 'application/json');
  await r.run();
  assert.equal(r.synthCalls.length, 1);
});

test('voice_unavailable is not retried: failed at once, no sandbox is made', async () => {
  const r = await rig();
  r.synthResult.value = () => ({ ok: false, code: 'voice_unavailable' });
  const report = await r.run();
  assert.equal(report.results[0].outcome, 'failed');
  assert.equal(report.results[0].code, 'voice_unavailable');
  assert.equal(r.row()!.state, 'failed');
  assert.equal(r.row()!.attempts, 1);
  assert.equal(r.sandboxes.created.length, 0);
  assert.equal((await r.run()).claimed, 0, 'nothing left to claim');
});

test('other voice failures are retried and carry a voice_ code', async () => {
  for (const [code, expected] of [['rate_limited', 'voice_rate_limited'], ['quota', 'voice_quota'], ['no_key', 'voice_no_key'], ['timeout', 'voice_timeout'], ['bad_response', 'voice_bad_response'], ['failed', 'voice_failed']] as const) {
    const r = await rig();
    r.synthResult.value = () => ({ ok: false, code });
    const report = await r.run();
    assert.equal(report.results[0].outcome, 'queued');
    assert.equal(report.results[0].code, expected);
    assert.equal(r.sandboxes.created.length, 0);
  }
});

test('an unknown voice key on the row is voice_unavailable', async () => {
  const r = await rig();
  r.row()!.voiceKey = 'robot';
  const report = await r.run();
  assert.equal(report.results[0].code, 'voice_unavailable');
  assert.equal(r.row()!.state, 'failed');
});

// ── The monthly cap ──

test('the monthly cap: refused as monthly_cap, failed with no retry, before any paid call', async () => {
  const r = await rig();
  r.h.store.settings.monthlyCapPence = 100;
  await r.h.store.insertRun(OWNER, {
    packId: r.packId,
    version: 1,
    by: 'admin',
    costPence: 100,
    result: { outcome: 'preview', version: 1, regenerate: false, areaKey: null, adCodes: [], imageCount: 0, checkFailures: 0, checkWarnings: 0 },
  });
  const report = await r.run();
  assert.equal(report.results[0].outcome, 'failed');
  assert.equal(report.results[0].code, 'monthly_cap');
  assert.equal(r.row()!.state, 'failed');
  assert.equal(r.synthCalls.length, 0);
  assert.equal(r.sandboxes.created.length, 0);
  assert.equal(report.results[0].costPence, 0);
});

test('a cap of 0 stops everything, and an unreadable month is spend_unknown (retried)', async () => {
  const a = await rig();
  a.h.store.settings.monthlyCapPence = 0;
  assert.equal((await a.run()).results[0].code, 'monthly_cap');
  const b = await rig();
  b.h.store.spendUnreadable = true;
  const rep = await b.run();
  assert.equal(rep.results[0].code, 'spend_unknown');
  assert.equal(rep.results[0].outcome, 'queued');
});

test('a render that fits the cap runs, and its cost is part of the next month-spend read', async () => {
  const r = await rig();
  const before = await r.h.store.monthSpendPence('2026-11-01T00:00:00.000Z');
  await r.run();
  const after = await r.h.store.monthSpendPence('2026-11-01T00:00:00.000Z');
  assert.equal((after ?? 0) - (before ?? 0), r.row()!.costPence);
  assert.ok(r.row()!.costPence > 0);
});

// ── Cost ──

test('cost = ceil(vcpus x wall seconds x unit cost + voice), on the row, the pack and a non-dry run row', async () => {
  const r = await rig();
  const packBefore = (await r.h.store.getPack(OWNER))!.costPence;
  const runsBefore = r.h.store.runs.length;
  await r.run();
  // five commands of 10 s each = 50 s wall at 2 vCPUs.
  const expected = Math.ceil(2 * 50 * CPU_SECOND_PENCE + 3.2);
  assert.equal(expected, 4);
  assert.equal(r.row()!.costPence, expected);
  assert.equal((await r.h.store.getPack(OWNER))!.costPence, packBefore + expected);
  const added = r.h.store.runs.slice(runsBefore);
  assert.equal(added.length, 1);
  assert.equal(added[0].costPence, expected);
  assert.equal(added[0].dry, false);
  assert.equal(added[0].by, 'admin');
  assert.equal((added[0].result as unknown as { kind: string }).kind, 'render');
});

test('vcpus come from the setting and the cost scales with them', async () => {
  const r = await rig({ settings: { vcpus: 4 } });
  r.sandboxes.opts.onRun = () => {
    r.advance(100_000);
    return { exitCode: 0, stderr: '', timedOut: false };
  };
  r.settings.maxSeconds = 900; // plenty of time for 5 x 100 s? the route clamp keeps it at 270 s
  const report = await r.run();
  assert.equal(r.sandboxes.created[0].vcpus, 4);
  assert.equal(r.sandboxes.created[0].timeoutMs, 270_000);
  assert.equal(report.results[0].code, 'timeout');
  assert.ok(r.row()!.costPence >= Math.ceil(4 * 200 * CPU_SECOND_PENCE));
});

test('the cost maths: whole pence rounded up, zero only when nothing was spent', () => {
  assert.equal(wholePence(0), 0);
  assert.equal(wholePence(0.0001), 1);
  assert.equal(wholePence(3), 3);
  assert.equal(wholePence(3.0000001), 4, 'a sliver over a whole penny still rounds up (float noise below 1e-9 does not)');
  assert.equal(attemptPence({ vcpus: 2, seconds: 100, cpuSecondPence: CPU_SECOND_PENCE, voicePence: 0 }), 2 * 100 * CPU_SECOND_PENCE);
  assert.equal(attemptPence({ vcpus: 2, seconds: -5, cpuSecondPence: 1, voicePence: 1 }), 1);
});

test('a failed attempt costs what it used (the sandbox seconds, and the voice if it was bought)', async () => {
  const r = await rig();
  failRender(r);
  await r.run();
  assert.equal(r.row()!.costPence, Math.ceil(2 * 50 * CPU_SECOND_PENCE + 3.2));
  assert.equal(r.h.store.runs.length, 2, 'the generator run and one render run row');
  assert.equal((r.h.store.runs[1].result as unknown as { outcome: string }).outcome, 'failed');
});

// ── The sweep and the claim ──

test('the sweep: a running row whose lease passed goes back to queued (attempts counted) and is run again', async () => {
  const r = await rig();
  const claimed = await r.renders.claim(r.row()!.id, r.h.now.toISOString(), new Date(r.h.now.getTime() + 60_000).toISOString());
  assert.equal(claimed?.attempts, 1);
  r.advance(10 * 60_000);
  const report = await r.run();
  assert.deepEqual(report.swept, { requeued: 1, failed: 0 });
  assert.equal(report.results[0].outcome, 'done');
  assert.equal(r.row()!.attempts, 2);
});

test('the sweep: a stale row at max attempts is failed with timeout and not run', async () => {
  const r = await rig();
  r.row()!.attempts = 2;
  const claimed = await r.renders.claim(r.row()!.id, r.h.now.toISOString(), new Date(r.h.now.getTime() + 60_000).toISOString());
  assert.equal(claimed?.attempts, 3);
  r.advance(10 * 60_000);
  const report = await r.run();
  assert.deepEqual(report.swept, { requeued: 0, failed: 1 });
  assert.equal(report.claimed, 0);
  assert.equal(r.row()!.state, 'failed');
  assert.equal(r.row()!.errorCode, 'timeout');
  assert.equal(r.sandboxes.created.length, 0);
});

test('a row whose lease is still running is left alone', async () => {
  const r = await rig();
  await r.renders.claim(r.row()!.id, r.h.now.toISOString(), new Date(r.h.now.getTime() + 10 * 60_000).toISOString());
  const report = await r.run();
  assert.deepEqual(report.swept, { requeued: 0, failed: 0 });
  assert.equal(report.claimed, 0);
});

test('a claim sets the lease to now + max seconds + 60 and counts the attempt', async () => {
  const r = await rig();
  r.sandboxes.opts.failCreate = true;
  const start = r.h.now.getTime();
  let seen: string | null = null;
  const real = r.renders.claim.bind(r.renders);
  r.renders.claim = async (id, now, lease) => {
    seen = lease;
    return real(id, now, lease);
  };
  await r.run();
  assert.equal(Date.parse(seen!) - start, (300 + 60) * 1000);
  assert.equal(r.row()!.attempts, 1);
});

test('only queued rows are claimed, oldest first, limit 1 by default', async () => {
  const r = await rig();
  r.advance(1000);
  const second = await r.renders.enqueue('pack-other', 1, 'olivia');
  assert.equal(second.inserted, true);
  const report = await r.run();
  assert.equal(report.claimed, 1);
  assert.equal(report.results[0].packId, r.packId);
  assert.equal(r.renders.rows.get(second.row.id)!.state, 'queued');
});

test('a claim someone else already took is skipped', async () => {
  const r = await rig();
  r.renders.claim = async () => null;
  const report = await r.run();
  assert.equal(report.claimed, 0);
  assert.equal(r.sandboxes.created.length, 0);
});

test('a render whose pack is gone or on another version is superseded (no retry, no cost); a pack without its 5b ad is a bad_brief', async () => {
  const a = await rig({ queue: false });
  await a.renders.enqueue('no-such-pack', 1, 'jane');
  assert.equal((await a.run()).results[0].code, 'superseded');
  assert.equal([...a.renders.rows.values()][0].state, 'failed');

  const b = await rig({ queue: false });
  await b.renders.enqueue(b.packId, 7, 'jane'); // the pack is on version 1
  const rep = await b.run();
  assert.equal(rep.results[0].code, 'superseded');
  assert.equal(rep.results[0].outcome, 'failed');

  const c = await rig();
  c.h.store.ads.delete(c.ad5b().id);
  const rc = await c.run();
  assert.equal(rc.results[0].code, 'bad_brief');
  assert.equal(rc.results[0].outcome, 'failed');
});

test('no company name is a bad_brief; no pinned brand is a bad_brief too (never a fall-back to the live settings)', async () => {
  const a = await rig();
  a.snap({ company: '   ' });
  const ra = await a.run();
  assert.equal(ra.results[0].code, 'bad_brief');
  assert.equal(ra.results[0].outcome, 'failed');
  const b = await rig();
  const ad = b.ad5b();
  const { brand: _gone, ...rest } = ad.texts;
  void _gone;
  ad.texts = rest;
  const rb = await b.run();
  assert.equal(rb.results[0].code, 'bad_brief');
  assert.equal(rb.results[0].outcome, 'failed');
  assert.equal(b.sandboxes.created.length, 0);
  assert.equal(b.synthCalls.length, 0);
});

// ── Dry run ──

test('a dry run lists what would run and claims, calls and writes nothing', async () => {
  const r = await rig();
  const claimed = await r.renders.claim(r.row()!.id, r.h.now.toISOString(), new Date(r.h.now.getTime() + 1000).toISOString());
  assert.ok(claimed);
  r.advance(60_000);
  await r.renders.enqueue('pack-two', 3, 'oliver');
  r.renders.writes.length = 0;
  const packWrites = r.h.store.writes.length;
  const runs = r.h.store.runs.length;

  const report = await r.run({ dry: true });
  assert.equal(report.dry, true);
  assert.equal(report.claimed, 0);
  assert.deepEqual(report.results, []);
  assert.deepEqual(report.counts, { queued: 1, running: 1, done: 0, failed: 0 });
  assert.deepEqual(report.wouldSweep, [{ packId: r.packId, version: 1, attempts: 1 }]);
  assert.deepEqual(report.wouldRun, [{ packId: 'pack-two', version: 3, attempts: 0 }]);

  assert.deepEqual(r.renders.writes, [], 'no queue write');
  assert.equal(r.h.store.writes.length, packWrites, 'no pack write');
  assert.equal(r.h.store.runs.length, runs, 'no run row');
  assert.equal(r.synthCalls.length, 0, 'no voice');
  assert.equal(r.sandboxes.created.length, 0, 'no sandbox');
  assert.equal(r.storage.puts.length, 0, 'no upload');
  assert.equal(r.row()!.state, 'running', 'the stale row was not swept');
  assert.deepEqual(r.logs, []);
});

// ── Nothing sensitive in rows, reports or logs ──

test('rows, reports and logs never hold brief text, stderr, urls, addresses or the company name', async () => {
  const r = await rig();
  failRender(r);
  const outcomes: RenderReport[] = [];
  for (let i = 0; i < 3; i++) outcomes.push(await r.run());
  const all = JSON.stringify({ rows: [...r.renders.rows.values()], logs: r.logs, outcomes, runs: r.h.store.runs });
  for (const needle of [SECRET_TEXT, 'Acacia', 'Traceback', 'cdn.example.test', 'brightstone', 'Has your tenant', 'ERR missing_asset', 'Example: a typical']) {
    assert.ok(!all.includes(needle), `leaked: ${needle}`);
  }
  for (const l of r.logs) assert.deepEqual(Object.keys(l.fields).filter((k) => !['packId', 'code', 'seconds'].includes(k)), [], l.event);
  for (const row of r.renders.rows.values()) assert.ok((row.errorCode ?? '').length <= 60);
});

// ── Enqueue, pure helpers, files ──

test('enqueueRender: inserts once, a repeat finds the row, bad input is refused, a store failure is a code', async () => {
  const r = await rig({ queue: false });
  const a = await enqueueRender(r.renders, { packId: r.packId, version: 2, voiceKey: 'olivia' });
  assert.deepEqual({ ok: a.ok, inserted: a.ok && a.inserted, state: a.ok && a.state }, { ok: true, inserted: true, state: 'queued' });
  const b = await enqueueRender(r.renders, { packId: r.packId, version: 2, voiceKey: 'olivia' });
  assert.ok(b.ok && !b.inserted);
  assert.equal(r.renders.rows.size, 1);
  assert.deepEqual(await enqueueRender(r.renders, { packId: r.packId, version: 0, voiceKey: 'jane' }), { ok: false, code: 'invalid_input' });
  assert.deepEqual(await enqueueRender(r.renders, { packId: '', version: 1, voiceKey: 'jane' }), { ok: false, code: 'invalid_input' });
  assert.deepEqual(await enqueueRender(r.renders, { packId: r.packId, version: 1, voiceKey: 'robot' }), { ok: false, code: 'invalid_input' });
  const broken = { enqueue: async () => Promise.reject(new Error('db down: secret')) };
  assert.deepEqual(await enqueueRender(broken, { packId: r.packId, version: 1, voiceKey: 'jane' }), { ok: false, code: 'store_failed' });
});

test('isSafeRelative: only relative paths inside the folder', () => {
  for (const ok of ['voice.mp3', 'assets/logo.png', 'out']) assert.equal(isSafeRelative(ok), true, ok);
  for (const bad of ['/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'C:/x', 'a\\b', '', 'a/', null, 5]) assert.equal(isSafeRelative(bad), false, String(bad));
});

test('renderErrCode reads only the ERR line', () => {
  assert.equal(renderErrCode('ERR bad_brief\n'), 'bad_brief');
  assert.equal(renderErrCode('noise\nERR ffmpeg_failed'), 'ffmpeg_failed');
  assert.equal(renderErrCode('ERR something_else'), null);
  assert.equal(renderErrCode('an ERR render_failed in the middle of a line'), null);
  assert.equal(renderErrCode(''), null);
});

test('figureForBrief: a stored figure entry maps to the basis field; no entry is null; a bad entry is undefined', () => {
  assert.equal(figureForBrief(null), null);
  assert.equal(figureForBrief([]), null);
  const entry = { basis: 'take-home', amount: 2349.6, label: 'Example: a typical 3-bed in X, from 14 reports. Every property is different.', sentence: 'S' };
  assert.deepEqual(figureForBrief([entry]), { label: entry.label, sentence: 'S', gross: null, net: null, takeHome: 2350, occupancyPct: null, basis: 'take-home' });
  assert.equal(figureForBrief([{ ...entry, basis: 'net' }])?.net, 2350);
  assert.equal(figureForBrief([{ ...entry, basis: 'gross' }])?.gross, 2350);
  assert.equal(figureForBrief([{ ...entry, basis: 'weird' }]), undefined);
  assert.equal(figureForBrief([{ ...entry, amount: 0 }]), undefined);
  assert.equal(figureForBrief([{ ...entry, label: '' }]), undefined);
});

test('buildBrief and briefProblems: a bad colour falls back, an escaping path is a problem', () => {
  const script = buildBriefScript(['One two three.', 'Four five six.', 'Seven eight nine.'], makeAlignment(joinScriptLines(['One two three.', 'Four five six.', 'Seven eight nine.'])));
  const good = buildBrief({ company: 'X', colour: 'red', logo: null, photos: [], area: 'A', bedrooms: null, figure: null, feeSentence: null, script });
  assert.equal(good.brand.colour, '#1F3A5F');
  assert.deepEqual(briefProblems(good), []);
  assert.ok(briefProblems({ ...good, photos: ['../secret.jpg'] }).includes('photo path'));
  assert.ok(briefProblems({ ...good, audio: '/abs.mp3' }).includes('audio path'));
  assert.ok(briefProblems({ ...good, photos: ['a', 'b', 'c', 'd', 'e'] }).includes('photo count'));
  assert.ok(briefProblems({ ...good, script: { ...script, lines: script.lines.slice(0, 2) } }).length > 0);
});

test('photos: at most four, jpg or png only (a webp is skipped), the site photo only when the pack has none', async () => {
  const r = await rig();
  r.snap({ photos: ['u/1.jpg', 'u/2.jpg', 'u/3.jpg', 'u/4.jpg', 'u/5.jpg'] });
  r.deps.fetchImage = async (ref) => ({ bytes: ref === 'u/2.jpg' ? new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]) : ref.includes('logo') ? PNG : JPG, contentType: null });
  await r.run();
  const brief = JSON.parse(new TextDecoder().decode(r.sandboxes.created[0].sandbox.files.get(BRIEF_PATH))) as Brief;
  assert.equal(brief.photos.length, 3, 'five asked, four read, one of those a webp');

  const s = await rig();
  s.snap({ photos: [], sitePhotoRef: 'https://cdn.example.test/site.jpg' });
  await s.run();
  const briefS = JSON.parse(new TextDecoder().decode(s.sandboxes.created[0].sandbox.files.get(BRIEF_PATH))) as Brief;
  assert.deepEqual(briefS.photos, ['assets/photo1.jpg']);

  const t = await rig();
  t.snap({ photos: [] });
  t.deps.fetchImage = async () => {
    throw new Error('offline');
  };
  await t.run();
  const briefT = JSON.parse(new TextDecoder().decode(t.sandboxes.created[0].sandbox.files.get(BRIEF_PATH))) as Brief;
  assert.deepEqual(briefT.photos, [], 'no photo: the type-only look');
  assert.equal(briefT.brand.logo, null, 'a logo that cannot be read is a name in type');
});

test('the renderer files load from the repo, exactly the explicit list, no sample folder', async () => {
  const files = await loadRendererFiles(path.join(import.meta.dirname, '..', '..', '..', 'ad-render'));
  assert.deepEqual(files.map((f) => f.path), RENDERER_FILES.map((f) => `ad-render/${f}`));
  assert.ok(files.every((f) => f.content.byteLength > 0));
  assert.ok(files.every((f) => !f.path.includes('sample') && !f.path.includes('__pycache__')));
  await assert.rejects(() => loadRendererFiles('/no/such/folder'), (e: Error) => e.message === 'missing_asset');
});

test('wiring: the cron, the tracing include and the unit cost seed are in place', () => {
  const root = path.join(import.meta.dirname, '..', '..', '..');
  const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] };
  assert.deepEqual(vercel.crons.filter((c) => c.path === '/api/internal/ad-pack-renders'), [{ path: '/api/internal/ad-pack-renders', schedule: '*/5 * * * *' }]);
  const next = readFileSync(path.join(root, 'next.config.ts'), 'utf8');
  assert.match(next, /"\/api\/internal\/ad-pack-renders": AD_RENDER_FILES/);
  for (const g of ['ad-render/*.py', 'ad-render/*.txt', 'ad-render/fonts/*']) assert.ok(next.includes(`"${g}"`), g);
  assert.ok(!next.includes('ad-render/sample'));
  const route = readFileSync(path.join(root, 'src/app/api/internal/ad-pack-renders/route.ts'), 'utf8');
  assert.match(route, /export const maxDuration = 300;/);
  assert.match(route, /authoriseInternal/);
  assert.match(route, /get\('dry'\) === '1'/);
});

test('settings: parsed with defaults, bad values fall back', () => {
  assert.deepEqual(parseRenderSettings([]), DEFAULT_RENDER_SETTINGS);
  assert.deepEqual(
    parseRenderSettings([
      { key: 'ad_pack_render_max_seconds', value: 240 },
      { key: 'ad_pack_render_max_attempts', value: '2' },
      { key: 'ad_pack_sandbox_vcpus', value: 4 },
    ]),
    { maxSeconds: 240, maxAttempts: 2, vcpus: 4 },
  );
  assert.deepEqual(
    parseRenderSettings([
      { key: 'ad_pack_render_max_seconds', value: 5 },
      { key: 'ad_pack_render_max_attempts', value: 0 },
      { key: 'ad_pack_sandbox_vcpus', value: 'many' },
    ]),
    DEFAULT_RENDER_SETTINGS,
  );
});

test('a parsed AdVideo: queued, making and failed (with a short code) are read; ready needs videos and a poster; coming stays coming; junk is null', () => {
  assert.deepEqual(parseAdVideo({ status: 'queued' }), { status: 'queued' });
  assert.deepEqual(parseAdVideo({ status: 'making' }), { status: 'making' });
  assert.deepEqual(parseAdVideo({ status: 'failed', code: 'voice_unavailable' }), { status: 'failed', code: 'voice_unavailable' });
  assert.deepEqual(parseAdVideo({ status: 'failed' }), { status: 'failed', code: 'render_failed' });
  assert.deepEqual(parseAdVideo({ status: 'failed', code: 'x'.repeat(200) }), { status: 'failed', code: 'x'.repeat(60) });
  assert.deepEqual(parseAdVideo({ status: 'coming' }), { status: 'coming' });
  assert.equal(parseAdVideo(null), null);
  assert.equal(parseAdVideo({ status: 'ready', videos: [], poster: null }), null);
  assert.equal(parseAdVideo({ status: 'weird' }), null);
});

// ── 38b B5a: the video slot, the measurements and the video checks ──

const videoCheckFailures = async (r: Rig) => ((await r.h.store.getPack(OWNER))!.checks?.failures ?? []).filter((f) => f.check === 'video');

test('after a good render the video check passes: the checks hold a passing video result, the pack stays in preview', async () => {
  const r = await rig();
  await r.run();
  const pack = (await r.h.store.getPack(OWNER))!;
  assert.equal(pack.status, 'preview');
  assert.equal(pack.checks?.ok, true);
  assert.deepEqual(pack.checks?.results.find((c) => c.check === 'video'), { check: 'video', label: 'The video is made properly', ok: true, failures: 0, warnings: 0, ran: true });
  assert.equal((r.ad5b().files.video as { status: string }).status, 'ready');
  // And the operator may approve all three ads.
  assert.ok((await r.h.engine.approvePack({ ownerId: OWNER })).ok);
});

test('ffprobe runs after the render, as an args array with JSON output, and the renderer’s render-info.json is read back', async () => {
  const r = await rig();
  await r.run();
  const cmds = r.sandboxes.created[0].sandbox.commands;
  const probes = cmds.filter((c) => c.cmd === 'ffprobe');
  assert.equal(probes.length, 3);
  assert.equal(cmds.findIndex((c) => c.cmd === 'ffprobe') > cmds.findIndex((c) => c.args[0] === 'ad-render/notice.py'), true, 'after the render');
  for (const p of probes) {
    assert.ok(Array.isArray(p.args));
    assert.deepEqual(p.args.slice(0, 5), ['-v', 'error', '-print_format', 'json', '-show_format']);
    assert.ok(p.args[p.args.length - 1].startsWith('out/notice_') && p.args[p.args.length - 1].endsWith('.mp4'));
    assert.ok(p.args.every((a) => !/[;&|`$]/.test(a)));
    assert.ok(p.timeoutMs > 0 && p.timeoutMs <= 30_000);
    assert.equal(p.sudo, undefined);
  }
});

test('each video failure puts the pack in checks_failed with the failing check in plain words; the render row stays done; approve is refused', async () => {
  const cases: { name: string; make: (r: Rig) => void; rule: string; detail: RegExp }[] = [
    { name: 'no audio track', make: (r) => (r.sandboxes.opts.onRun = healthy(r, { audio: false })), rule: 'video_audio', detail: /no sound/ },
    { name: 'wrong size', make: (r) => (r.sandboxes.opts.onRun = healthy(r, { height: 1000 })), rule: 'video_size', detail: /must be exactly 1080x/ },
    { name: 'too long', make: (r) => (r.sandboxes.opts.onRun = healthy(r, { duration: '61.2' })), rule: 'video_length', detail: /60 seconds or less/ },
    { name: 'no length', make: (r) => (r.sandboxes.opts.onRun = healthy(r, { duration: '0' })), rule: 'video_length', detail: /no length/ },
    { name: 'no captions', make: (r) => (r.sandboxes.opts.outputs = { ...OUTPUT_FILES, 'out/render-info.json': new TextEncoder().encode(JSON.stringify({ captions: 0, scenes: [], duration: 38 })) }), rule: 'video_captions', detail: /no captions/ },
    { name: 'render-info.json missing', make: (r) => { const o = { ...OUTPUT_FILES }; delete o['out/render-info.json']; r.sandboxes.opts.outputs = o; }, rule: 'video_captions', detail: /no captions/ },
    { name: 'ffprobe cannot read the file', make: (r) => { const ok = healthy(r); r.sandboxes.opts.onRun = (cmd) => (cmd.cmd === 'ffprobe' ? (r.advance(1000), { exitCode: 1, stderr: 'Invalid data', timedOut: false }) : ok(cmd)); }, rule: 'video_length', detail: /no length/ },
  ];
  for (const c of cases) {
    const r = await rig();
    c.make(r);
    const report = await r.run();
    assert.equal(report.results[0].outcome, 'done', c.name);
    assert.equal(r.row()!.state, 'done', c.name);
    const pack = (await r.h.store.getPack(OWNER))!;
    assert.equal(pack.status, 'checks_failed', c.name);
    assert.equal(pack.checks?.ok, false, c.name);
    const fails = await videoCheckFailures(r);
    assert.ok(fails.some((f) => f.rule === c.rule && c.detail.test(f.detail)), `${c.name}: ${JSON.stringify(fails)}`);
    assert.ok(fails.every((f) => f.where.startsWith('ad 5b notice-') && f.detail.length > 0));
    assert.ok(!/ERR |Traceback|Invalid data/.test(JSON.stringify(pack.checks)));
    const approve = await r.h.engine.approvePack({ ownerId: OWNER });
    assert.ok(!approve.ok && approve.code === 'not_preview', c.name);
    assert.equal((await r.h.store.getPack(OWNER))!.status, 'checks_failed');
  }
});

test('the video check leaves the other stored checks as they were, and a newer version, an approved or a regenerating pack is not touched', async () => {
  const r = await rig();
  const before = (await r.h.store.getPack(OWNER))!;
  await r.run();
  const after = (await r.h.store.getPack(OWNER))!;
  assert.deepEqual(after.checks?.failures, before.checks?.failures);
  assert.deepEqual(after.checks?.warnings, before.checks?.warnings);
  assert.deepEqual(after.checks?.results.filter((c) => c.check !== 'video'), before.checks?.results.filter((c) => c.check !== 'video'));

  // Already moved on at the claim: superseded before anything is spent.
  for (const patch of [{ version: 2 }, { status: 'generating' as const }]) {
    const x = await rig();
    await x.h.store.updatePack(OWNER, x.packId, patch);
    x.sandboxes.opts.onRun = healthy(x, { audio: false });
    const rep = await x.run();
    assert.equal(rep.results[0].code, 'superseded');
    assert.equal(x.sandboxes.created.length, 0);
    const pack = (await x.h.store.getPack(OWNER))!;
    assert.equal(pack.status, patch.status ?? 'preview');
    assert.deepEqual(pack.checks, before.checks, 'untouched');
  }
  // Moved on DURING the render: the checks are not merged, the slot is not made ready and the row does not end done.
  for (const patch of [{ version: 2 }, { status: 'approved' as const }]) {
    const x = await rig();
    const ok = healthy(x, { audio: false });
    x.sandboxes.opts.onRun = (cmd) => {
      if (cmd.args[0] === 'ad-render/notice.py') void x.h.store.updatePack(OWNER, x.packId, patch);
      return ok(cmd);
    };
    const rep = await x.run();
    assert.equal(rep.results[0].code, 'superseded');
    assert.equal(rep.results[0].outcome, 'failed');
    assert.equal(x.row()!.state, 'failed');
    assert.notEqual((x.ad5b().files.video as { status: string }).status, 'ready');
    assert.deepEqual((await x.h.store.getPack(OWNER))!.checks, before.checks, 'untouched');
  }
});

test('the video check is merged BEFORE the row is done and the slot ready; if merging throws the row does not end done and the slot is not ready', async () => {
  const r = await rig();
  const order: string[] = [];
  const realUpdate = r.h.store.updatePack.bind(r.h.store);
  r.h.store.updatePack = async (...a: Parameters<typeof realUpdate>) => {
    if ((a[2] as { checks?: unknown }).checks) order.push('checks');
    return realUpdate(...a);
  };
  const realComplete = r.renders.complete.bind(r.renders);
  r.renders.complete = async (...a) => (order.push('complete'), realComplete(...a));
  const realSet = r.renders.setAdFiles.bind(r.renders);
  r.renders.setAdFiles = async (...a) => (order.push('slot'), realSet(...a));
  await r.run();
  assert.deepEqual(order, ['checks', 'slot', 'complete']);

  const t = await rig();
  t.h.store.updatePack = async () => {
    throw new Error('db down');
  };
  const rep = await t.run();
  assert.notEqual(rep.results[0].outcome, 'done');
  assert.equal(rep.results[0].code, 'store_failed');
  assert.notEqual(t.row()!.state, 'done');
  assert.equal(t.row()!.state, 'queued', 'tried again');
  assert.notEqual((t.ad5b().files.video as { status: string }).status, 'ready');
});

test('a row whose pack moved on is superseded before any spend: no voice, no sandbox, no cost, no retry', async () => {
  for (const patch of [{ version: 2 }, { status: 'failed' as const }, { status: 'generating' as const }]) {
    const r = await rig();
    await r.h.store.updatePack(OWNER, r.packId, patch);
    const rep = await r.run();
    assert.equal(rep.results[0].outcome, 'failed');
    assert.equal(rep.results[0].code, 'superseded');
    assert.equal(rep.results[0].costPence, 0);
    assert.equal(r.synthCalls.length, 0);
    assert.equal(r.sandboxes.created.length, 0);
    assert.equal(r.storage.puts.length, 0);
    assert.equal(r.row()!.state, 'failed');
    assert.equal(r.row()!.errorCode, 'superseded');
    assert.equal(r.h.store.runs.length, 1, 'no render run row: only the generator run');
    assert.equal((await r.run()).claimed, 0, 'not retried');
    assert.notEqual((r.ad5b().files.video as { status: string }).status, 'failed', 'the ad slot is left alone');
  }
  for (const status of ['preview', 'approved'] as const) {
    const r = await rig();
    await r.h.store.updatePack(OWNER, r.packId, { status });
    assert.equal((await r.run()).results[0].outcome, status === 'approved' ? 'failed' : 'done', 'preview and approved are rendered (approved fails only at the late check)');
  }
});

test('brand pinning: a retry and a voice change use the snapshot taken at generate, whatever the site or the pack columns say now', async () => {
  const r = await rig();
  failRender(r, 'ERR render_failed\n');
  await r.run(); // first try fails: queued for a retry
  assert.equal(r.row()!.state, 'queued');
  // The operator edits the site brand and the pack's own columns drift. The worker does not read the live settings at all (no
  // loadBrand dependency exists); the pack columns it used to read are changed here to prove they are not read either.
  const pack = r.h.store.packs.get(r.packId)!;
  pack.photos = ['u/new-photo.jpg'];
  pack.areaLabel = 'Somewhere else';
  pack.bedrooms = 9;
  pack.figures = [];
  const fetched: string[] = [];
  r.deps.fetchImage = async (ref) => (fetched.push(ref), { bytes: ref.includes('logo') ? PNG : JPG, contentType: null });
  r.sandboxes.opts.onRun = healthy(r);
  await r.run();
  const read = () => JSON.parse(new TextDecoder().decode(r.sandboxes.created.at(-1)!.sandbox.files.get(BRIEF_PATH))) as Brief;
  let brief = read();
  assert.equal(brief.area, 'Lenton, Nottingham');
  assert.equal(brief.bedrooms, 3);
  assert.ok(brief.figure, 'the pinned figure, not the pack column that is now empty');
  assert.deepEqual(brief.photos, ['assets/photo1.jpg']);
  assert.ok(!fetched.includes('u/new-photo.jpg'));
  assert.ok(fetched.includes('https://cdn.example.test/photo-1.jpg') && fetched.includes(LOGO));
  assert.equal(brief.brand.company, SECRET_TEXT);
  // The script and the brief agree: the lines the voice says are the lines on screen and name the same company and area.
  assert.deepEqual(brief.script.lines.map((l) => l.text), scriptLinesOf(r.ad5b()));
  assert.ok(brief.script.lines.map((l) => l.text).join(' ').includes(SECRET_TEXT));

  // A voice change after the same drift: the version is the same, the row starts again, the brief is still the pinned one.
  const changed = await r.h.engine.changeVoice({ ownerId: OWNER, voiceKey: 'olivia' });
  assert.ok(changed.ok, JSON.stringify(changed));
  r.storage.files.clear(); // the engine's deleteFiles removes the version's cached voice (the harness's fake does not touch this storage)
  const created = r.sandboxes.created.length;
  await r.run();
  assert.equal(r.sandboxes.created.length, created + 1);
  brief = read();
  assert.equal(brief.brand.company, SECRET_TEXT);
  assert.equal(brief.area, 'Lenton, Nottingham');
  assert.deepEqual(brief.script.lines.map((l) => l.text), scriptLinesOf(r.ad5b()));
  assert.equal(r.synthCalls.at(-1)!.voiceKey, 'olivia');
});

test('the pinned brand is stored with the 5b ad only, holds no more than the pack already stores, and is not part of the copyable texts', async () => {
  const r = await rig();
  const b = r.ad5b().texts.brand!;
  assert.deepEqual(Object.keys(b).sort(), ['areaLabel', 'bedrooms', 'colour', 'company', 'feeSentence', 'figure', 'logoRef', 'photos', 'sitePhotoRef']);
  assert.equal(b.company, SECRET_TEXT);
  assert.equal(b.logoRef, LOGO);
  assert.equal(b.feeSentence, 'Our management fee is 12%.');
  for (const a of r.h.store.ads.values()) if (a.angle !== '5b') assert.equal(a.texts.brand, undefined);
});

test('a failed voice call that reached ElevenLabs still costs its estimate once per call made; a refusal costs nothing', async () => {
  const est = estimateVoicePence(scriptLinesOf((await rig()).ad5b()), 'jane');
  assert.ok(est >= 1);
  for (const [billedCalls, expected] of [[1, 1], [2, 2], [undefined, 0]] as const) {
    const r = await rig();
    r.synthResult.value = () => ({ ok: false, code: 'timeout', ...(billedCalls ? { billedCalls } : {}) });
    const rep = await r.run();
    assert.equal(rep.results[0].code, 'voice_timeout');
    assert.equal(rep.results[0].outcome, 'queued');
    assert.equal(rep.results[0].costPence, expected * est);
    assert.equal(r.row()!.costPence, expected * est);
    assert.equal(r.h.store.packs.get(r.packId)!.costPence, expected * est);
    assert.equal(r.h.store.runs.length, expected === 0 ? 1 : 2, 'a non-dry run row lands in the month spend');
    assert.equal(await r.h.store.monthSpendPence('2000-01-01T00:00:00Z'), expected * est);
  }
});

test('every retry of a voice that fails after being billed counts again (the row cost and the month spend add up)', async () => {
  const r = await rig({ settings: { maxAttempts: 3 } });
  const est = estimateVoicePence(scriptLinesOf(r.ad5b()), 'jane');
  r.synthResult.value = () => ({ ok: false, code: 'bad_response', billedCalls: 1 });
  await r.run();
  await r.run();
  assert.equal(r.row()!.attempts, 2);
  assert.equal(r.row()!.costPence, 2 * est);
  assert.equal(await r.h.store.monthSpendPence('2000-01-01T00:00:00Z'), 2 * est);
  await r.run();
  assert.equal(r.row()!.state, 'failed');
  assert.equal(r.row()!.costPence, 3 * est);
});

test('a lease is at least the route limit plus a minute, even with a very low render time limit', async () => {
  const r = await rig({ settings: { maxSeconds: 60 } });
  r.sandboxes.opts.failCreate = true;
  const start = r.h.now.getTime();
  let seen: string | null = null;
  const real = r.renders.claim.bind(r.renders);
  r.renders.claim = async (id, now, lease) => {
    seen = lease;
    return real(id, now, lease);
  };
  await r.run();
  assert.equal(Date.parse(seen!) - start, (300 + 60) * 1000, 'not 60 + 60');
  const big = await rig({ settings: { maxSeconds: 600 } });
  big.sandboxes.opts.failCreate = true;
  let seenBig: string | null = null;
  const realBig = big.renders.claim.bind(big.renders);
  big.renders.claim = async (id, now, lease) => {
    seenBig = lease;
    return realBig(id, now, lease);
  };
  const t0 = big.h.now.getTime();
  await big.run();
  assert.equal(Date.parse(seenBig!) - t0, (600 + 60) * 1000, 'a longer render time limit lengthens the lease');
});


test('the 5b slot follows the worker: ready when done, queued for a retry, failed with the code once left failed', async () => {
  const r = await rig({ settings: { maxAttempts: 2 } });
  failRender(r, 'ERR missing_asset\n');
  await r.run();
  assert.deepEqual(r.ad5b().files.video, { status: 'queued' });
  assert.equal(r.row()!.state, 'queued');
  await r.run();
  assert.equal(r.row()!.state, 'failed');
  assert.deepEqual(r.ad5b().files.video, { status: 'failed', code: 'missing_asset' });
  // The pack stays in preview, and the screen reads the failure from both the slot and the row.
  assert.equal((await r.h.store.getPack(OWNER))!.status, 'preview');
  // voice_unavailable is left failed at once, in the slot too.
  const v = await rig();
  v.synthResult.value = () => ({ ok: false, code: 'voice_unavailable' });
  await v.run();
  assert.equal(v.row()!.state, 'failed');
  assert.deepEqual(v.ad5b().files.video, { status: 'failed', code: 'voice_unavailable' });
  assert.equal((await v.h.store.getPack(OWNER))!.status, 'preview', 'the pack stays in preview');
});

test('parseProbe: size, length and audio from ffprobe’s JSON; anything else is null', () => {
  assert.deepEqual(parseProbe(probeJson('notice_9x16.mp4')), { width: 1080, height: 1920, durationSeconds: 38.03, hasAudio: true });
  assert.equal(parseProbe(probeJson('notice_1x1.mp4', { audio: false }))?.hasAudio, false);
  assert.equal(parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: 10, height: 20, duration: '3.5' }], format: {} }))?.durationSeconds, 3.5);
  for (const bad of [undefined, '', 'not json', '[]', '{}', JSON.stringify({ streams: [{ codec_type: 'audio' }] })]) assert.equal(parseProbe(bad), null, String(bad));
});

test('parseRenderInfo: the renderer’s counts; anything else is null', () => {
  assert.deepEqual(parseRenderInfo(RENDER_INFO), { captions: 17, scenes: ['L1', 'L2', 'L3', 'L4', 'L5'], duration: 38.03 });
  for (const bad of [null, new TextEncoder().encode('nope'), new TextEncoder().encode('{"captions":"x"}'), new TextEncoder().encode('{"captions":-1}')]) assert.equal(parseRenderInfo(bad), null);
});

test('requeueRender: resets a finished row in place (keeps the cost), creates a missing one, and refuses a running one', async () => {
  const r = await rig();
  await r.run();
  const row = r.row()!;
  row.costPence = 9;
  const again = await r.renders.requeueRender({ packId: r.packId, version: 1, voiceKey: 'olivia' });
  assert.ok(again && again.id === row.id);
  assert.deepEqual([again!.state, again!.attempts, again!.errorCode, again!.files, again!.voiceKey, again!.costPence, again!.finishedAt, again!.leaseUntil], ['queued', 0, null, null, 'olivia', 9, null, null]);
  row.state = 'running';
  assert.equal(await r.renders.requeueRender({ packId: r.packId, version: 1, voiceKey: 'oliver' }), null);
  assert.equal(r.row()!.voiceKey, 'olivia', 'a running row is left alone');
  const fresh = await r.renders.requeueRender({ packId: r.packId, version: 7, voiceKey: 'jane' });
  assert.ok(fresh && fresh.state === 'queued' && fresh.version === 7);
});
