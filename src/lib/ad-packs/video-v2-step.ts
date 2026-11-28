/**
 * Batch 55 step 5 (Phase 2, 55c A3): the render worker's step for the two lead database videos (ad_pack_renders kinds
 * 'phone' and 'loupe'), queued by the example report step once the masked pages exist.
 *
 *   phone  ad 5b, ad-render/report_walk.py: the drawn calculator on a phone (two frames drawn with Satori from the
 *          customer's calculator design: deps.example.renderPhoneFrames), then the example report
 *   loupe  ad 17, ad-render/loupe.py: a report page under a moving magnifier, at the three stops the pages step found
 *
 * Same pipeline as the notice video (render-core.ts): the cap before any paid call, the voiceover (ElevenLabs, its own
 * cache per kind), the sandbox (ffmpeg + Python), ffprobe, the video check, the upload, the slot, the cost. Brief
 * version 2 (brief-v2.ts). After either video is done, the picture measure runs once all three ads have a first frame
 * (ld-gate.ts, mergeLdPictureChecks).
 *
 * A video that fails for good never blocks the pack: the phone falls back to the notice video (queued, format
 * notice_video); the loupe leaves 17 on its type-only cards (format type_cards, no video slot).
 *
 * Pure: no network, no database, no server-only.
 */
import { buildBriefV2, briefV2Problems, outputsV2, posterV2, type LoupeTarget } from './brief-v2.ts';
import { mergeLdPictureChecks, mergeVideoChecks, type CheckVideo } from './checks.ts';
import { FALLBACK_FORMAT } from './concepts.ts';
import { cleanLines } from './captions.ts';
import type { Coverage } from './coverage.ts';
import { renderLdTexts } from './ld-angles.ts';
import type { PictureStats } from './ld-gate.ts';
import {
  attemptPence,
  fetchAsset,
  MIN_SANDBOX_SECONDS,
  OUT_DIR,
  parseProbe,
  RenderFail,
  RENDER_INFO_PATH,
  ROUTE_MAX_SECONDS,
  ROUTE_RESERVE_SECONDS,
  settle,
  VENV,
  voiceFor,
  wholePence,
  AUDIO_PATH,
  BRIEF_PATH,
  MAX_VIDEO_BYTES,
  MAX_POSTER_BYTES,
  type RenderDeps,
  type RenderLine,
  type SandboxLike,
  type SandboxRun,
} from './render-core.ts';
import { kindOf, type AdVideoReady, type RenderRow, type RenderSettings } from './render-store.ts';
import { StoreError, type AdFileRef, type PackAdRow, type PackRow } from './store-types.ts';
import { fitsCap } from './settings.ts';
import { isVoiceKey } from './voices.ts';
import { monthStartIso } from './month.ts';

/** The renderer files the two new videos need (notice.py too: its caption pages are imported, not copied). */
export const RENDERER_FILES_V2 = [
  'report_walk.py',
  'loupe.py',
  'ld_common.py',
  'notice.py',
  'components.py',
  'theme.py',
  'video.py',
  'requirements.txt',
  'fonts/Anton-Regular.ttf',
  'fonts/Archivo-Medium.ttf',
  'fonts/Archivo-SemiBold.ttf',
  'fonts/OFL.txt',
] as const;

const NO_RETRY = new Set(['voice_unavailable', 'monthly_cap', 'bad_brief', 'superseded']);
const isPng = (b: Uint8Array | null): b is Uint8Array => !!b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isMp4 = (b: Uint8Array) => b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;

export function v2VoicePaths(ownerId: string, packId: string, version: number, kind: 'phone' | 'loupe') {
  const folder = `${ownerId}/${packId}/v${version}`;
  return { audio: `${folder}/voice-${kind}.mp3`, script: `${folder}/script-${kind}.json` };
}

/** render-info.json of a v2 render: the caption count and the first frame's picture measure. */
export function parseRenderInfoV2(bytes: Uint8Array | null): { captions: number; firstFrame: PictureStats | null } | null {
  if (!bytes) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const captions = Number(j.captions);
    if (!Number.isFinite(captions) || captions < 0) return null;
    const ff = j.first_frame as { hist?: unknown; thumb?: unknown } | undefined;
    const firstFrame = ff && Array.isArray(ff.hist) && Array.isArray(ff.thumb) && ff.hist.length === 64 && ff.thumb.length === 1024 ? { hist: ff.hist.map(Number), thumb: ff.thumb.map(Number) } : null;
    return { captions: Math.trunc(captions), firstFrame };
  } catch {
    return null;
  }
}

type Spend = { voicePence: number; sandboxSeconds: number; sandboxId: string | null; videos: CheckVideo[]; startedMs: number; firstFrame: PictureStats | null };

async function makeVideo(deps: RenderDeps, row: RenderRow, pack: PackRow, kind: 'phone' | 'loupe', settings: RenderSettings, spend: Spend): Promise<{ ready: AdVideoReady; ad: PackAdRow }> {
  const angle = kind === 'phone' ? '5b' : '17';
  const ads = await deps.packs.listAds(pack.ownerId, pack.id);
  const ad = ads.find((a) => a.angle === angle && a.version === row.version);
  const brand = ad?.texts.brand;
  const ld = ad?.texts.ld;
  if (!ad || !brand || !ld || !brand.company.trim()) throw new RenderFail('bad_brief');
  const lines = cleanLines(ld.scriptLines ?? []);
  if (lines.length < 3) throw new RenderFail('bad_brief');
  const example = (await deps.renders.getRender(pack.id, row.version, 'example_report'))?.example;
  if (!example || example.pages.length === 0) throw new RenderFail('bad_brief');
  if (kind === 'loupe' && example.targets.length !== 3) throw new RenderFail('bad_brief');

  // The cap, before any paid call.
  const effectiveMax = Math.min(settings.maxSeconds, ROUTE_MAX_SECONDS - ROUTE_RESERVE_SECONDS);
  const cpuSecondPence = await deps.sandboxCpuSecondPence();
  const capCheck = async (voiceWorstPence: number) => {
    const cfg = await deps.packs.readSettings();
    const spent = await deps.packs.monthSpendPence(monthStartIso(deps.now()), pack.route);
    if (spent === null) throw new RenderFail('spend_unknown');
    const worst = wholePence(attemptPence({ vcpus: settings.vcpus, seconds: effectiveMax, cpuSecondPence, voicePence: voiceWorstPence }));
    if (!fitsCap(spent, worst, cfg.ldMonthlyCapPence)) throw new RenderFail('monthly_cap');
  };
  if (!isVoiceKey(row.voiceKey)) throw new RenderFail('voice_unavailable');
  const { audio, script } = await voiceFor(deps, pack.ownerId, pack, row, lines, spend, capCheck, v2VoicePaths(pack.ownerId, pack.id, row.version, kind));

  // The assets: the masked pages, the logo, the phone frames.
  const assets: { path: string; content: Uint8Array }[] = [];
  const pages: string[] = [];
  for (const [i, p] of example.pages.entries()) {
    const bytes = await deps.storage.get(p.path);
    if (!isPng(bytes)) throw new RenderFail('missing_asset');
    const rel = `assets/page-${i + 1}.png`;
    assets.push({ path: rel, content: bytes });
    pages.push(rel);
  }
  let logo: string | null = null;
  if (brand.logoRef) {
    const a = await fetchAsset(deps, brand.logoRef, 'assets/logo');
    if (a) {
      assets.push(a);
      logo = a.path;
    }
  }
  const phoneFrames: string[] = [];
  if (kind === 'phone') {
    const draw = deps.example?.renderPhoneFrames;
    if (!draw) throw new RenderFail('missing_asset');
    let frames: Uint8Array[];
    try {
      frames = await draw({ company: brand.company, brandColour: brand.colour, logoRef: brand.logoRef, areaLabel: brand.areaLabel, bedrooms: brand.bedrooms });
    } catch {
      throw new RenderFail('missing_asset');
    }
    for (const [i, f] of frames.slice(0, 2).entries()) {
      if (!isPng(f)) throw new RenderFail('missing_asset');
      assets.push({ path: `assets/phone-${i + 1}.png`, content: f });
      phoneFrames.push(`assets/phone-${i + 1}.png`);
    }
  }
  const brief = buildBriefV2({
    conceptId: kind === 'phone' ? '5b-tenant-leaving' : '17-rules-changed',
    format: kind === 'phone' ? 'phone_recording' : 'loupe',
    company: brand.company,
    colour: brand.colour,
    logo,
    base: ld.look.base,
    screenLines: ld.screenLines,
    figureLabel: typeof brand.figure?.label === 'string' ? (brand.figure.label as string) : null,
    reportPages: pages,
    phoneFrames,
    targets: example.targets as LoupeTarget[],
    script,
  });
  if (briefV2Problems(brief).length > 0) throw new RenderFail('bad_brief');
  const files = await deps.rendererFiles(RENDERER_FILES_V2);

  const startMs = deps.now().getTime();
  const sandboxMax = Math.min(effectiveMax, Math.floor(ROUTE_MAX_SECONDS - ROUTE_RESERVE_SECONDS - (startMs - spend.startedMs) / 1000));
  if (sandboxMax < MIN_SANDBOX_SECONDS) throw new RenderFail('timeout');
  const deadline = startMs + sandboxMax * 1000;
  const left = () => deadline - deps.now().getTime();
  const outs = [...outputsV2(brief.out_prefix), posterV2(brief.out_prefix)];
  const got: { o: (typeof outs)[number]; bytes: Uint8Array }[] = [];
  let sandbox: SandboxLike | null = null;
  try {
    try {
      sandbox = await deps.sandbox({ vcpus: settings.vcpus, timeoutMs: sandboxMax * 1000 });
    } catch {
      throw new RenderFail('sandbox_failed');
    }
    spend.sandboxId = sandbox.id;
    try {
      await sandbox.writeFiles([...files, { path: BRIEF_PATH, content: new TextEncoder().encode(JSON.stringify(brief)) }, { path: AUDIO_PATH, content: audio }, ...assets]);
    } catch {
      throw new RenderFail('sandbox_failed');
    }
    const script = kind === 'phone' ? 'ad-render/report_walk.py' : 'ad-render/loupe.py';
    const steps: { cmd: string; args: string[]; sudo?: boolean; env?: Record<string, string>; capMs: number; fail: string }[] = [
      { cmd: 'apt-get', args: ['update', '-qq'], sudo: true, capMs: 90_000, fail: 'sandbox_failed' },
      { cmd: 'apt-get', args: ['install', '-y', '-qq', '--no-install-recommends', 'ffmpeg'], sudo: true, env: { DEBIAN_FRONTEND: 'noninteractive' }, capMs: 150_000, fail: 'ffmpeg_failed' },
      { cmd: 'python3', args: ['-m', 'venv', VENV], capMs: 60_000, fail: 'sandbox_failed' },
      { cmd: `${VENV}/bin/pip`, args: ['install', '--quiet', '--disable-pip-version-check', '-r', 'ad-render/requirements.txt'], capMs: 120_000, fail: 'sandbox_failed' },
      { cmd: `${VENV}/bin/python`, args: [script, '--brief', BRIEF_PATH], capMs: Number.POSITIVE_INFINITY, fail: 'render_failed' },
    ];
    for (const [i, step] of steps.entries()) {
      const remaining = left();
      if (remaining < 5_000) throw new RenderFail('timeout');
      let res: SandboxRun;
      try {
        res = await sandbox.run({ cmd: step.cmd, args: step.args, ...(step.sudo ? { sudo: true } : {}), ...(step.env ? { env: step.env } : {}), timeoutMs: Math.floor(Math.min(step.capMs, remaining)) });
      } catch {
        throw new RenderFail('sandbox_failed');
      }
      if (res.timedOut) throw new RenderFail('timeout');
      if (res.exitCode !== 0) {
        const m = i === steps.length - 1 ? /^ERR (bad_brief|missing_asset|render_failed|ffmpeg_failed)\s*$/m.exec(res.stderr ?? '') : null;
        throw new RenderFail(m ? m[1] : step.fail);
      }
    }
    const info = parseRenderInfoV2(await sandbox.readFile(RENDER_INFO_PATH).catch(() => null));
    spend.firstFrame = info?.firstFrame ?? null;
    spend.videos = [];
    for (const o of outputsV2(brief.out_prefix)) {
      const remaining = left();
      if (remaining < 2_000) throw new RenderFail('timeout');
      let res: SandboxRun;
      try {
        res = await sandbox.run({ cmd: 'ffprobe', args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', `${OUT_DIR}/${o.src}`], timeoutMs: Math.floor(Math.min(30_000, remaining)) });
      } catch {
        throw new RenderFail('sandbox_failed');
      }
      if (res.timedOut) throw new RenderFail('timeout');
      const probe = res.exitCode === 0 ? parseProbe(res.stdout) : null;
      spend.videos.push({ name: o.name, width: probe?.width ?? 0, height: probe?.height ?? 0, durationSeconds: probe?.durationSeconds ?? 0, hasAudio: probe?.hasAudio ?? false, captionCount: info?.captions ?? 0 });
    }
    for (const o of outs) {
      let bytes: Uint8Array | null;
      try {
        bytes = await sandbox.readFile(`${OUT_DIR}/${o.src}`);
      } catch {
        throw new RenderFail('sandbox_failed');
      }
      const max = o.contentType === 'video/mp4' ? MAX_VIDEO_BYTES : MAX_POSTER_BYTES;
      const valid = bytes !== null && bytes.byteLength > 0 && bytes.byteLength <= max && (o.contentType === 'video/mp4' ? isMp4(bytes) : isPng(bytes));
      if (!valid || !bytes) throw new RenderFail('render_failed');
      got.push({ o, bytes });
    }
  } finally {
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch {
        (deps.log ?? (() => {}))('sandbox_stop_failed', { packId: pack.id, code: 'sandbox_failed' });
      }
      spend.sandboxSeconds = Math.max(0, (deps.now().getTime() - startMs) / 1000);
    }
  }

  const folder = `${pack.ownerId}/${pack.id}/v${row.version}`;
  const refs: AdFileRef[] = [];
  for (const g of got) {
    const p = `${folder}/${g.o.name}`;
    let up: { ok: boolean };
    try {
      up = await deps.storage.put(p, g.bytes, g.o.contentType);
    } catch {
      throw new RenderFail('upload_failed');
    }
    if (!up.ok) throw new RenderFail('upload_failed');
    refs.push({ name: g.o.name, path: p, width: g.o.width, height: g.o.height, contentType: g.o.contentType, bytes: g.bytes.byteLength });
  }
  const poster = refs.pop();
  if (!poster) throw new RenderFail('render_failed');
  return {
    ready: { status: 'ready', videos: refs, poster, durationSeconds: Math.round(script.duration * 10) / 10, voice: row.voiceKey, ...(spend.firstFrame ? { firstFrame: spend.firstFrame } : {}) },
    ad,
  };
}

/** The video check of this video merged into the pack's checks, then the picture measure when all three ads have a first frame. */
async function applyChecks(deps: RenderDeps, pack: PackRow, version: number, kind: 'phone' | 'loupe', videos: CheckVideo[], ready: AdVideoReady): Promise<void> {
  const fresh = await deps.packs.getPack(pack.ownerId);
  if (!fresh || fresh.id !== pack.id || fresh.version !== version || fresh.status !== 'preview') throw new RenderFail('superseded');
  let checks = mergeVideoChecks(fresh.checks, videos, { prefix: kind, angle: kind === 'phone' ? '5b' : '17' });
  const ads = (await deps.packs.listAds(pack.ownerId, pack.id)).filter((a) => a.version === version);
  const other = ads.find((a) => a.angle === (kind === 'phone' ? '17' : '5b'))?.files.video;
  const otherFrame = other && other.status === 'ready' ? other.firstFrame : undefined;
  const carousel = deps.example?.measurePng ? await firstCardStats(deps, ads) : null;
  if (ready.firstFrame && otherFrame && carousel) {
    const pics = [
      { angle: '5b' as const, picture: kind === 'phone' ? ready.firstFrame : otherFrame },
      { angle: '3a' as const, picture: carousel },
      { angle: '17' as const, picture: kind === 'loupe' ? ready.firstFrame : otherFrame },
    ];
    checks = mergeLdPictureChecks(checks, pics);
  }
  const updated = await deps.packs.updatePack(pack.ownerId, pack.id, checks.ok ? { checks } : { checks, status: 'checks_failed' }, { from: ['preview'] });
  if (!updated) throw new RenderFail('superseded');
}

async function firstCardStats(deps: RenderDeps, ads: PackAdRow[]): Promise<PictureStats | null> {
  const ad = ads.find((a) => a.angle === '3a');
  const first = ad?.files.images.find((f) => f.height === 1920) ?? ad?.files.images[0];
  if (!first || !deps.example?.measurePng) return null;
  try {
    const bytes = await deps.storage.get(first.path);
    return bytes ? await deps.example.measurePng(bytes) : null;
  } catch {
    return null;
  }
}

/** One claimed phone or loupe row, start to finish. Never throws. */
export async function runVideoV2Row(deps: RenderDeps, row: RenderRow, settings: RenderSettings): Promise<RenderLine> {
  const log = deps.log ?? (() => {});
  const kind = kindOf(row) === 'loupe' ? 'loupe' : 'phone';
  const angle = kind === 'phone' ? '5b' : '17';
  const spend: Spend = { voicePence: 0, sandboxSeconds: 0, sandboxId: null, videos: [], startedMs: deps.now().getTime(), firstFrame: null };
  let pack: PackRow | null = null;
  let ready: AdVideoReady | null = null;
  let code = 'render_failed';
  const slot = async (video: Parameters<RenderDeps['packs']['setAdVideo']>[2] | null) => {
    if (!pack) return;
    try {
      const ad = (await deps.packs.listAds(pack.ownerId, pack.id)).find((a) => a.angle === angle && a.version === row.version);
      if (ad && video) await deps.packs.setAdVideo(pack.ownerId, ad.id, video);
      else if (ad && !video) await deps.renders.setAdFiles(pack.ownerId, ad.id, { images: ad.files.images, video: null });
    } catch {
      log('render_slot_failed', { packId: pack.id, code: 'store_failed' });
    }
  };
  try {
    pack = await deps.renders.getPack(row.packId);
    if (!pack || pack.version !== row.version || pack.route !== 'leaddb' || (pack.status !== 'preview' && pack.status !== 'approved')) throw new RenderFail('superseded');
    await slot({ status: 'making' });
    const made = await makeVideo(deps, row, pack, kind, settings, spend);
    await applyChecks(deps, pack, row.version, kind, spend.videos, made.ready);
    if (!(await deps.renders.setAdFiles(pack.ownerId, made.ad.id, { images: made.ad.files.images, video: made.ready }))) throw new RenderFail('store_failed');
    ready = made.ready;
  } catch (e) {
    code = e instanceof RenderFail ? e.code : e instanceof StoreError ? 'store_failed' : 'render_failed';
  }

  let cpuSecondPence = 0;
  try {
    cpuSecondPence = await deps.sandboxCpuSecondPence();
  } catch {
    cpuSecondPence = 0;
  }
  const attemptCost = wholePence(attemptPence({ vcpus: settings.vcpus, seconds: spend.sandboxSeconds, cpuSecondPence, voicePence: spend.voicePence }));
  const total = row.costPence + attemptCost;
  const finishedAt = deps.now().toISOString();
  const line = (outcome: RenderLine['outcome'], c?: string): RenderLine => ({ renderId: row.id, packId: row.packId, version: row.version, outcome, ...(c ? { code: c } : {}), seconds: Math.round(spend.sandboxSeconds), costPence: attemptCost });
  let result: RenderLine;
  try {
    if (ready && pack) {
      const ok = await deps.renders.complete(row.id, row.attempts, { costPence: total, sandboxId: spend.sandboxId, files: ready, finishedAt });
      result = ok ? line('done') : line('lost');
      log(ok ? 'render_done' : 'render_lost', { packId: row.packId, code: kind });
    } else {
      const retry = !NO_RETRY.has(code) && row.attempts < settings.maxAttempts;
      const ok = await deps.renders.release(row.id, row.attempts, { state: retry ? 'queued' : 'failed', errorCode: code, costPence: total, sandboxId: spend.sandboxId, finishedAt: retry ? null : finishedAt });
      result = ok ? line(retry ? 'queued' : 'failed', code) : line('lost', code);
      log(retry ? 'render_retry' : 'render_failed', { packId: row.packId, code });
      if (ok && pack && code !== 'superseded') {
        if (retry) await slot({ status: 'queued' });
        else await fallBack(deps, pack, row, kind);
      }
    }
  } catch {
    result = line('lost', 'store_failed');
  }
  if (attemptCost > 0 && pack) await settle(deps, pack, attemptCost, ready !== null, ready ? undefined : code, row.version, spend.sandboxSeconds, kind);
  return result;
}

/** A video that failed for good: the phone falls back to the notice video; the loupe leaves 17 on its type-only cards. Never throws. */
async function fallBack(deps: RenderDeps, pack: PackRow, row: RenderRow, kind: 'phone' | 'loupe'): Promise<void> {
  const log = deps.log ?? (() => {});
  try {
    const ads = (await deps.packs.listAds(pack.ownerId, pack.id)).filter((a) => a.version === row.version);
    const ad = ads.find((a) => a.angle === (kind === 'phone' ? '5b' : '17'));
    if (!ad) return;
    if (deps.packs.setAdFormat) await deps.packs.setAdFormat(pack.ownerId, ad.id, FALLBACK_FORMAT[ad.angle]);
    if (kind === 'phone') {
      await deps.renders.enqueue(pack.id, row.version, row.voiceKey);
      await deps.packs.setAdVideo(pack.ownerId, ad.id, { status: 'queued' });
    } else {
      await deps.renders.setAdFiles(pack.ownerId, ad.id, { images: ad.files.images, video: null });
    }
    log('video_fallback', { packId: pack.id, code: kind });
  } catch {
    log('video_fallback_failed', { packId: pack.id, code: kind });
  }
}

/** The lines the 17 voiceover will say (for the tests that render it). */
/** Phase 3: `coverage` (coverage.ts) says where; absent, the one `area` as before. */
export const loupeLinesFor = (company: string, area: string, feePct: number | null, coverage?: Coverage) =>
  renderLdTexts({ angle: '17', brand: { company, area, feePct, ...(coverage ? { coverage } : {}) }, figure: null }).script ?? [];
