/**
 * Batch 38b: the notice video's render worker, as a pure engine. Everything
 * outside it is injected (the queue store, the pack store, the sandbox, the
 * voice, the file storage, the image fetch, the clock, the settings), so it is
 * tested with fakes and no network, database or server-only. render-server.ts
 * wires the real ones.
 *
 *   runRenderQueue(deps, {dry, limit = 1})   one pass of the cron worker
 *   enqueueRender(store, {packId, version, voiceKey})   Phase B5 calls this after a pack is stored
 *
 * ORDER of a pass (a dry run lists what a real one would do and writes, claims
 * and calls nothing):
 *   a  sweep     running rows whose lease ended: back to queued (attempts stay counted),
 *                or failed with `timeout` once attempts has reached the limit
 *   b  claim     queued rows, oldest first, one conditional update each
 *                (state running, lease_until = now + max_seconds + 60 s, attempts + 1)
 *   per claimed row:
 *   c  cap       this UK month's spend (ad_pack_runs, non-dry, which includes every
 *                render's cost: see settle()) plus this render's worst case over
 *                ad_pack_monthly_cap_pence: failed `monthly_cap`, no retry
 *   d  voice     the version's voice.mp3 + script.json already in the private bucket are
 *                reused (a retry never pays twice); otherwise B3 `synthesise`
 *   e  brief     brief.json from the pack's stored ad script, figure, area and the
 *                operator's brand, photos fetched into the sandbox folder
 *   f  sandbox   create (vcpus, timeout, NO secrets in the env, network allow-all because
 *                apt and pip need the internet), upload ad-render/**, the brief, the assets
 *                and the voice, run the commands, read the outputs back, ALWAYS stop
 *   f2 measure   still in the sandbox: `ffprobe` (args array, JSON on stdout) on each MP4 for its size,
 *                length and whether it has an audio track, and the renderer's `render-info.json`
 *                (caption count, scene ids, duration) read back
 *   g  files     the three MP4s and the poster go to the private bucket; the 5b ad's
 *                `files.video` becomes the ready shape; the render row is done
 *   g2 checks    the video check (checks.ts videoChecks: exact sizes, 0 < length <= 60 s, audio, captions)
 *                is merged into the pack's stored `checks`; a failure puts the pack in 'checks_failed'
 *                (the render row stays 'done'; approve is refused). Only for the pack's CURRENT version
 *                while it is in 'preview'.
 *   h  failure   a code only (never stderr, a brief text, a url or an address): back to
 *                queued while attempts < max, else failed; voice_unavailable, bad_brief and
 *                monthly_cap are never retried
 *
 * THE VIDEO SLOT. The 5b ad's `files.video` follows the row: 'making' when the worker takes it, 'ready'
 * (the files) when done, 'queued' when it goes back for a retry, {status:'failed', code} when it is left failed.
 * (The generator writes 'queued' when it enqueues; a voice change and a retry write 'queued' again.)
 *
 * COST. cost = ceil(vcpus x wall seconds x unit_costs 'vercel'/'sandbox_cpu_second' pence + the
 * voice's raw cost). Wall seconds run from creating the sandbox to its stop (an upper bound of
 * the Active CPU the price is quoted on). The cost goes on the render row (cumulative over
 * attempts), on ad_packs.cost_pence, and on ONE non-dry ad_pack_runs row per attempt that cost
 * anything (by 'admin' = the system, result.kind 'render'). monthSpendPence in the pack store
 * sums non-dry runs, so the generator's monthly cap already includes render cost with no change.
 *
 * Never logs a lead, an address or a body: log lines carry a pack id, a code and seconds.
 *
 * Pure apart from reading the renderer's own files from disk (loadRendererFiles).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { feeSentence } from './angles.ts';
import { cleanLines, validateBriefScript, type BriefScript } from './captions.ts';
import { mergeVideoChecks, type CheckVideo } from './checks.ts';
import { monthStartIso } from './month.ts';
import { PHOTO_MAX_BYTES, sniffPhoto } from './photos.ts';
import { fitsCap } from './settings.ts';
import { isVoiceKey, type VoiceKey } from './voices.ts';
import { estimateVoicePence, type SynthesiseResult, type VoiceCode } from './voice-core.ts';
import { StoreError, type AdFileRef, type AdPackStore, type PackAdRow, type PackRow, type RunResult } from './store-types.ts';
import type { AdVideo, AdVideoReady, RenderRow, RenderSettings, RenderStore } from './render-store.ts';

// ── Interfaces ──

/** `stdout` is only read for ffprobe's JSON (the real sandbox truncates it); every other command may leave it out. */
export type SandboxRun = { exitCode: number; stderr: string; timedOut: boolean; stdout?: string };

export interface SandboxLike {
  id: string;
  /** Paths are relative to the sandbox's working folder. */
  writeFiles(files: { path: string; content: Uint8Array }[]): Promise<void>;
  /** Commands are an executable and an args ARRAY, never a shell string. */
  run(cmd: { cmd: string; args: string[]; sudo?: boolean; env?: Record<string, string>; timeoutMs: number }): Promise<SandboxRun>;
  readFile(path: string): Promise<Uint8Array | null>;
  stop(): Promise<void>;
}
export type SandboxFactory = (o: { vcpus: number; timeoutMs: number }) => Promise<SandboxLike>;

export interface StorageLike {
  get(path: string): Promise<Uint8Array | null>;
  put(path: string, bytes: Uint8Array, contentType: string): Promise<{ ok: boolean }>;
}

export type FetchedImage = { bytes: Uint8Array; contentType?: string | null };

/** What the video's look rests on, read from the operator's website at render time. */
export type RenderBrand = {
  company: string;
  colour: string | null;
  /** The logo's address (https) or a stored upload reference; null for a name in type only. */
  logoRef: string | null;
  /** The website's own photo: used when the pack has no photo of its own. */
  sitePhotoRef: string | null;
  /** The operator's own management fee percent (the only source of any fee line). */
  feePct: number | null;
};

export type RendererFile = { path: string; content: Uint8Array };

export type RenderDeps = {
  /** The pack store: listAds, getPack, updatePack, insertRun, monthSpendPence, readSettings. */
  packs: AdPackStore;
  renders: RenderStore;
  sandbox: SandboxFactory;
  synth: (i: { voiceKey: VoiceKey; lines: readonly string[]; packId: string }) => Promise<SynthesiseResult>;
  storage: StorageLike;
  fetchImage: (ref: string) => Promise<FetchedImage>;
  loadBrand: (ownerId: string, websiteId: string | null) => Promise<RenderBrand | null>;
  /** The files of ad-render/ that go into the sandbox (explicit list). */
  rendererFiles: () => Promise<RendererFile[]>;
  /** Raw pence per sandbox CPU-second (the unit_costs row; the seed when unreadable). */
  sandboxCpuSecondPence: () => Promise<number>;
  renderSettings: () => Promise<RenderSettings>;
  now: () => Date;
  log?: (event: string, fields: { packId?: string; code?: string; seconds?: number }) => void;
};

// ── Constants ──

/** The route's maxDuration, and how much of it is kept back for the voice, the uploads and the bookkeeping. */
export const ROUTE_MAX_SECONDS = 300;
export const ROUTE_RESERVE_SECONDS = 30;
/** The lease on a claimed row is max_seconds + this. */
export const LEASE_EXTRA_SECONDS = 60;

export const VENV = '/tmp/venv';
export const BRIEF_PATH = 'brief.json';
export const AUDIO_PATH = 'voice.mp3';
export const OUT_DIR = 'out';
/** Written by notice.py into OUT_DIR: {"captions": N, "scenes": [ids], "duration": seconds}. */
export const RENDER_INFO_PATH = 'out/render-info.json';
export const DEFAULT_BRAND_COLOUR = '#1F3A5F'; // mirrors images.tsx (a test cannot import JSX)
export const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
export const MAX_POSTER_BYTES = 10 * 1024 * 1024;
export const MAX_RENDER_PHOTOS = 4;

/** The renderer's own files, exactly (no sample folder, no caches). */
export const RENDERER_FILES = [
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

/** The outputs of notice.py and the names they are stored under (hyphens, like the 38a image names). */
export const OUTPUTS = [
  { src: 'notice_9x16.mp4', name: 'notice-9x16.mp4', width: 1080, height: 1920, contentType: 'video/mp4' },
  { src: 'notice_4x5.mp4', name: 'notice-4x5.mp4', width: 1080, height: 1350, contentType: 'video/mp4' },
  { src: 'notice_1x1.mp4', name: 'notice-1x1.mp4', width: 1080, height: 1080, contentType: 'video/mp4' },
] as const;
export const POSTER = { src: 'poster.png', name: 'notice-poster.png', width: 1080, height: 1920, contentType: 'image/png' } as const;

/** Codes a retry cannot fix. */
const NO_RETRY = new Set(['voice_unavailable', 'monthly_cap', 'bad_brief']);

const VOICE_CODE_OF: Record<VoiceCode, string> = {
  voice_unavailable: 'voice_unavailable',
  no_key: 'voice_no_key',
  rate_limited: 'voice_rate_limited',
  quota: 'voice_quota',
  timeout: 'voice_timeout',
  bad_response: 'voice_bad_response',
  failed: 'voice_failed',
};

class RenderFail extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'RenderFail';
    this.code = code;
  }
}

// ── Pure helpers ──

/** Whether a path may go in a brief: relative, inside the folder, no drive, no backslash. */
export function isSafeRelative(p: unknown): p is string {
  if (typeof p !== 'string' || p === '' || p.length > 400) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes(':') || p.includes('\0')) return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '' || seg === '.');
}

export function normaliseColour(raw: string | null | undefined): string {
  const c = String(raw ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : DEFAULT_BRAND_COLOUR;
}

export type BriefFigure = {
  label: string;
  sentence: string;
  gross: number | null;
  net: number | null;
  takeHome: number | null;
  occupancyPct: number | null;
  basis: 'take-home' | 'net' | 'gross';
};

/**
 * The brief's figure from the pack's stored figure entry (generate-core's
 * figureEntry: label, sentence, basis, amount). `undefined` means the entry is
 * there but unusable (a bad brief); null means the pack has no figure.
 */
export function figureForBrief(entries: readonly unknown[] | null): BriefFigure | null | undefined {
  if (!entries || entries.length === 0) return null;
  const e = entries[0] as Record<string, unknown> | null;
  if (!e || typeof e !== 'object') return undefined;
  const basis = e.basis;
  const amount = Number(e.amount);
  if ((basis !== 'take-home' && basis !== 'net' && basis !== 'gross') || !Number.isFinite(amount) || amount <= 0) return undefined;
  if (typeof e.label !== 'string' || e.label.trim() === '') return undefined;
  const n = Math.round(amount);
  return {
    label: e.label,
    sentence: typeof e.sentence === 'string' ? e.sentence : '',
    gross: basis === 'gross' ? n : null,
    net: basis === 'net' ? n : null,
    takeHome: basis === 'take-home' ? n : null,
    occupancyPct: null,
    basis,
  };
}

export type Brief = {
  version: 1;
  brand: { company: string; colour: string; logo: string | null };
  photos: string[];
  area: string;
  bedrooms: number | null;
  figure: BriefFigure | null;
  fee_sentence: string | null;
  script: BriefScript;
  audio: string;
  out_dir: string;
};

/** brief.json exactly as the contract in CONTEXT-38b.md (and ad-render/README.md) says. */
export function buildBrief(i: {
  company: string;
  colour: string | null;
  logo: string | null;
  photos: readonly string[];
  area: string;
  bedrooms: number | null;
  figure: BriefFigure | null;
  feeSentence: string | null;
  script: BriefScript;
}): Brief {
  return {
    version: 1,
    brand: { company: i.company, colour: normaliseColour(i.colour), logo: i.logo },
    photos: [...i.photos],
    area: i.area,
    bedrooms: i.bedrooms,
    figure: i.figure,
    fee_sentence: i.feeSentence,
    script: i.script,
    audio: AUDIO_PATH,
    out_dir: OUT_DIR,
  };
}

/** Why a brief cannot be used (codes of the problem, never the text), or [] when it is fine. */
export function briefProblems(b: Brief): string[] {
  const problems: string[] = [];
  if (b.version !== 1) problems.push('version');
  if (!b.brand.company.trim()) problems.push('company');
  if (!/^#[0-9A-F]{6}$/.test(b.brand.colour)) problems.push('colour');
  if (b.brand.logo !== null && !isSafeRelative(b.brand.logo)) problems.push('logo path');
  if (b.photos.length > MAX_RENDER_PHOTOS) problems.push('photo count');
  for (const p of b.photos) if (!isSafeRelative(p)) problems.push('photo path');
  if (!isSafeRelative(b.audio)) problems.push('audio path');
  if (!isSafeRelative(b.out_dir)) problems.push('out dir');
  if (!validateBriefScript(b.script).ok) problems.push('script');
  else if (b.script.lines.length < 3) problems.push('script lines');
  return problems;
}

/** The code notice.py printed (`ERR <code>`), or null. Nothing else of stderr is read. */
export function renderErrCode(stderr: string): 'bad_brief' | 'missing_asset' | 'render_failed' | 'ffmpeg_failed' | null {
  const m = /^ERR (bad_brief|missing_asset|render_failed|ffmpeg_failed)\s*$/m.exec(stderr ?? '');
  return m ? (m[1] as 'bad_brief' | 'missing_asset' | 'render_failed' | 'ffmpeg_failed') : null;
}

/** Raw pence of one attempt (not yet rounded up). */
export function attemptPence(a: { vcpus: number; seconds: number; cpuSecondPence: number; voicePence: number }): number {
  return Math.max(0, a.vcpus) * Math.max(0, a.seconds) * Math.max(0, a.cpuSecondPence) + Math.max(0, a.voicePence);
}

/** Whole pence, rounded up; 0 only when nothing was spent. */
export function wholePence(raw: number): number {
  return raw > 0 ? Math.ceil(raw - 1e-9) : 0;
}

export type Probe = { width: number; height: number; durationSeconds: number; hasAudio: boolean };

/**
 * What ffprobe (-print_format json -show_format -show_streams) said about one MP4: the first video stream's
 * size, the length (the container's, else the video stream's) and whether any audio stream exists. Null when
 * the text is not that JSON or has no video stream.
 */
export function parseProbe(stdout: string | undefined): Probe | null {
  let j: unknown;
  try {
    j = JSON.parse(String(stdout ?? ''));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const o = j as { streams?: unknown; format?: unknown };
  const streams = Array.isArray(o.streams) ? (o.streams as Record<string, unknown>[]) : [];
  const video = streams.find((s) => s && s.codec_type === 'video');
  if (!video) return null;
  const num = (v: unknown) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  };
  const fmt = o.format && typeof o.format === 'object' ? (o.format as Record<string, unknown>) : {};
  const duration = num(fmt.duration) || num(video.duration);
  return { width: Math.trunc(num(video.width)), height: Math.trunc(num(video.height)), durationSeconds: Math.round(duration * 100) / 100, hasAudio: streams.some((s) => s && s.codec_type === 'audio') };
}

export type RenderInfo = { captions: number; scenes: string[]; duration: number };

/** render-info.json as written by ad-render/notice.py. Null when absent or not that shape. */
export function parseRenderInfo(bytes: Uint8Array | null): RenderInfo | null {
  if (!bytes) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const captions = Number(j.captions);
    if (!Number.isFinite(captions) || captions < 0) return null;
    return { captions: Math.trunc(captions), scenes: Array.isArray(j.scenes) ? j.scenes.filter((x): x is string => typeof x === 'string') : [], duration: Number(j.duration) || 0 };
  } catch {
    return null;
  }
}

export function voicePaths(ownerId: string, packId: string, version: number): { audio: string; script: string; folder: string } {
  const folder = `${ownerId}/${packId}/v${version}`;
  return { folder, audio: `${folder}/voice.mp3`, script: `${folder}/script.json` };
}

/** The script lines the operator sees (the 5b ad's `texts.script`, one paragraph per line). */
export function scriptLinesOf(ad: Pick<PackAdRow, 'texts'>): string[] {
  return cleanLines(String(ad.texts.script ?? '').split(/\n\s*\n/));
}

/** Read ad-render/ files from disk (explicit list), relative to the process's working folder. */
export async function loadRendererFiles(root: string = path.join(/*turbopackIgnore: true*/ process.cwd(), 'ad-render')): Promise<RendererFile[]> {
  const out: RendererFile[] = [];
  for (const rel of RENDERER_FILES) {
    try {
      out.push({ path: `ad-render/${rel}`, content: new Uint8Array(await readFile(path.join(/*turbopackIgnore: true*/ root, rel))) });
    } catch {
      throw new RenderFail('missing_asset');
    }
  }
  return out;
}

export type EnqueueResult =
  | { ok: true; inserted: boolean; renderId: string; state: RenderRow['state'] }
  | { ok: false; code: 'invalid_input' | 'store_failed' };

/** Queue the render of a stored pack version (insert-if-missing; never throws). */
export async function enqueueRender(store: Pick<RenderStore, 'enqueue'>, input: { packId: string; version: number; voiceKey: string }): Promise<EnqueueResult> {
  if (!input || typeof input.packId !== 'string' || input.packId === '' || !Number.isInteger(input.version) || input.version < 1 || !isVoiceKey(input.voiceKey)) {
    return { ok: false, code: 'invalid_input' };
  }
  try {
    const { inserted, row } = await store.enqueue(input.packId, input.version, input.voiceKey);
    return { ok: true, inserted, renderId: row.id, state: row.state };
  } catch {
    return { ok: false, code: 'store_failed' };
  }
}

// ── The report ──

export type RenderLine = {
  renderId: string;
  packId: string;
  version: number;
  outcome: 'done' | 'queued' | 'failed' | 'lost';
  code?: string;
  seconds: number;
  costPence: number;
};

export type RenderReport = {
  dry: boolean;
  swept: { requeued: number; failed: number };
  /** Dry run only: rows in each state, and what a real pass would sweep and claim (ids and counts, nothing else). */
  counts?: Record<string, number>;
  wouldSweep?: { packId: string; version: number; attempts: number }[];
  wouldRun?: { packId: string; version: number; attempts: number }[];
  claimed: number;
  results: RenderLine[];
};

// ── The worker ──

type Spend = { voicePence: number; sandboxSeconds: number; sandboxId: string | null; videos: CheckVideo[] };

export async function runRenderQueue(deps: RenderDeps, opts: { dry?: boolean; limit?: number } = {}): Promise<RenderReport> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const limit = Math.max(1, Math.min(5, Math.trunc(opts.limit ?? 1)));
  const log = deps.log ?? (() => {});
  const report: RenderReport = { dry: opts.dry === true, swept: { requeued: 0, failed: 0 }, claimed: 0, results: [] };

  if (opts.dry === true) {
    const [counts, expired, queued] = await Promise.all([deps.renders.counts(), deps.renders.listExpired(nowIso, 50), deps.renders.listQueued(limit)]);
    report.counts = { ...counts };
    report.wouldSweep = expired.map((r) => ({ packId: r.packId, version: r.version, attempts: r.attempts }));
    report.wouldRun = queued.map((r) => ({ packId: r.packId, version: r.version, attempts: r.attempts }));
    return report;
  }

  const settings = await deps.renderSettings();

  // a: the sweep.
  for (const r of await deps.renders.listExpired(nowIso, 50)) {
    const res = await deps.renders.expire(r.id, r.attempts, nowIso, settings.maxAttempts);
    if (res === 'requeued') report.swept.requeued++;
    else if (res === 'failed') report.swept.failed++;
    if (res) log('render_swept', { packId: r.packId, code: res === 'failed' ? 'timeout' : 'requeued' });
  }

  // b: claim and run, oldest first.
  const leaseUntil = new Date(now.getTime() + (settings.maxSeconds + LEASE_EXTRA_SECONDS) * 1000).toISOString();
  const candidates = await deps.renders.listQueued(limit * 2 + 2);
  for (const c of candidates) {
    if (report.claimed >= limit) break;
    const row = await deps.renders.claim(c.id, nowIso, leaseUntil);
    if (!row) continue;
    report.claimed++;
    report.results.push(await runOne(deps, row, settings));
  }
  return report;
}

/** One claimed row, start to finish. Never throws. */
async function runOne(deps: RenderDeps, row: RenderRow, settings: RenderSettings): Promise<RenderLine> {
  const log = deps.log ?? (() => {});
  const spend: Spend = { voicePence: 0, sandboxSeconds: 0, sandboxId: null, videos: [] };
  let pack: PackRow | null = null;
  let files: AdVideoReady | null = null;
  let code = 'render_failed';
  try {
    pack = await deps.renders.getPack(row.packId);
    if (!pack) throw new RenderFail('bad_brief');
    await setVideoSlot(deps, pack, row.version, { status: 'making' });
    files = await renderPack(deps, row, pack, settings, spend);
  } catch (e) {
    code = e instanceof RenderFail ? e.code : e instanceof StoreError ? 'store_failed' : 'render_failed';
  }

  // Cost: ceil(vcpus x seconds x unit cost + voice), added to this row, the pack and the month's runs.
  let cpuSecondPence = 0;
  try {
    cpuSecondPence = await deps.sandboxCpuSecondPence();
  } catch {
    cpuSecondPence = 0;
  }
  const attemptCost = wholePence(attemptPence({ vcpus: settings.vcpus, seconds: spend.sandboxSeconds, cpuSecondPence, voicePence: spend.voicePence }));
  const total = row.costPence + attemptCost;
  const finishedAt = deps.now().toISOString();
  const line = (outcome: RenderLine['outcome'], c?: string): RenderLine => ({
    renderId: row.id,
    packId: row.packId,
    version: row.version,
    outcome,
    ...(c ? { code: c } : {}),
    seconds: Math.round(spend.sandboxSeconds),
    costPence: attemptCost,
  });

  let result: RenderLine;
  try {
    if (files && pack) {
      const ok = await deps.renders.complete(row.id, row.attempts, { costPence: total, sandboxId: spend.sandboxId, files, finishedAt });
      result = ok ? line('done') : line('lost');
      log(ok ? 'render_done' : 'render_lost', { packId: row.packId, code: ok ? 'done' : 'lost', seconds: Math.round(spend.sandboxSeconds) });
      if (ok) await applyVideoChecks(deps, pack, row.version, spend.videos);
    } else {
      const retry = !NO_RETRY.has(code) && row.attempts < settings.maxAttempts;
      const ok = await deps.renders.release(row.id, row.attempts, {
        state: retry ? 'queued' : 'failed',
        errorCode: code,
        costPence: total,
        sandboxId: spend.sandboxId,
        finishedAt: retry ? null : finishedAt,
      });
      result = ok ? line(retry ? 'queued' : 'failed', code) : line('lost', code);
      log(retry ? 'render_retry' : 'render_failed', { packId: row.packId, code, seconds: Math.round(spend.sandboxSeconds) });
      if (ok && pack) await setVideoSlot(deps, pack, row.version, retry ? { status: 'queued' } : { status: 'failed', code: code.slice(0, 60) });
    }
  } catch {
    // The lease runs out and the sweep puts the row back; the cost below is still recorded.
    result = line('lost', 'store_failed');
    log('render_finish_failed', { packId: row.packId, code: 'store_failed' });
  }

  if (attemptCost > 0 && pack) await settle(deps, pack, attemptCost, files !== null, files ? undefined : code, row.version, spend.sandboxSeconds);
  return result;
}

/** The 5b ad's video slot of one version (keeps its images). Best effort: a failure is logged and nothing more. */
async function setVideoSlot(deps: RenderDeps, pack: PackRow, version: number, video: AdVideo): Promise<void> {
  try {
    const ads = await deps.packs.listAds(pack.ownerId, pack.id);
    const ad = ads.find((a) => a.angle === '5b' && a.version === version);
    if (ad) await deps.packs.setAdVideo(pack.ownerId, ad.id, video);
  } catch {
    (deps.log ?? (() => {}))('render_slot_failed', { packId: pack.id, code: 'store_failed' });
  }
}

/**
 * g2: the video check on a finished render, merged into the pack's stored checks. Only the pack's current version
 * while it is in 'preview' is touched (a newer version, an approved or regenerating pack is left alone). Never throws.
 */
async function applyVideoChecks(deps: RenderDeps, pack: PackRow, version: number, videos: CheckVideo[]): Promise<void> {
  const log = deps.log ?? (() => {});
  try {
    const fresh = await deps.packs.getPack(pack.ownerId);
    if (!fresh || fresh.id !== pack.id || fresh.version !== version || fresh.status !== 'preview') return;
    const checks = mergeVideoChecks(fresh.checks, videos);
    await deps.packs.updatePack(pack.ownerId, pack.id, checks.ok ? { checks } : { checks, status: 'checks_failed' }, { from: ['preview'] });
    if (!checks.ok) log('render_checks_failed', { packId: pack.id, code: 'video_checks' });
  } catch {
    log('render_checks_store_failed', { packId: pack.id, code: 'store_failed' });
  }
}

/** The cost on the pack and in the month's runs (the generator's cap reads ad_pack_runs). Never throws. */
async function settle(deps: RenderDeps, pack: PackRow, cost: number, ok: boolean, errorCode: string | undefined, version: number, seconds: number): Promise<void> {
  const log = deps.log ?? (() => {});
  try {
    const fresh = await deps.packs.getPack(pack.ownerId);
    if (fresh) await deps.packs.updatePack(pack.ownerId, pack.id, { costPence: fresh.costPence + cost });
  } catch {
    log('render_pack_cost_failed', { packId: pack.id, code: 'store_failed' });
  }
  try {
    const result: RunResult & { kind: 'render'; renderSeconds: number } = {
      outcome: ok ? 'preview' : 'failed',
      ...(errorCode ? { errorCode } : {}),
      version,
      regenerate: false,
      areaKey: null,
      adCodes: [],
      imageCount: 0,
      checkFailures: 0,
      checkWarnings: 0,
      kind: 'render',
      renderSeconds: Math.round(seconds),
    };
    await deps.packs.insertRun(pack.ownerId, { packId: pack.id, version, by: 'admin', costPence: cost, result });
  } catch {
    log('render_run_row_failed', { packId: pack.id, code: 'store_failed' });
  }
}

type Asset = { path: string; content: Uint8Array };

async function fetchAsset(deps: RenderDeps, ref: string, base: string): Promise<Asset | null> {
  try {
    const got = await deps.fetchImage(ref);
    const bytes = got.bytes;
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > PHOTO_MAX_BYTES) return null;
    const kind = sniffPhoto(bytes);
    if (!kind) return null; // jpg and png only
    return { path: `${base}.${kind === 'png' ? 'png' : 'jpg'}`, content: bytes };
  } catch {
    return null;
  }
}

const isMp4 = (b: Uint8Array) => b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;
const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** The voiceover: the version's stored files when they match the script, else a fresh (paid) one. */
async function voiceFor(deps: RenderDeps, ownerId: string, pack: PackRow, row: RenderRow, lines: string[], spend: Spend, capCheck: (voiceWorstPence: number) => Promise<void>): Promise<{ audio: Uint8Array; script: BriefScript }> {
  const paths = voicePaths(ownerId, pack.id, row.version);
  const [audio, scriptBytes] = [await deps.storage.get(paths.audio), await deps.storage.get(paths.script)];
  if (audio && audio.byteLength > 0 && scriptBytes) {
    try {
      const script = JSON.parse(new TextDecoder().decode(scriptBytes)) as BriefScript;
      const same = validateBriefScript(script).ok && script.lines.length === lines.length && script.lines.every((l, i) => l.text === lines[i]);
      if (same) {
        await capCheck(0);
        return { audio, script };
      }
    } catch {
      // unreadable: made again below
    }
  }
  if (!isVoiceKey(row.voiceKey)) throw new RenderFail('voice_unavailable');
  await capCheck(estimateVoicePence(lines, row.voiceKey));
  const res = await deps.synth({ voiceKey: row.voiceKey, lines, packId: pack.id });
  if (!res.ok) throw new RenderFail(VOICE_CODE_OF[res.code] ?? 'voice_failed');
  spend.voicePence += res.costPence;
  const a = await deps.storage.put(paths.audio, res.audio, 'audio/mpeg');
  const s = a.ok ? await deps.storage.put(paths.script, new TextEncoder().encode(JSON.stringify(res.script)), 'application/json') : { ok: false };
  if (!a.ok || !s.ok) throw new RenderFail('upload_failed');
  return { audio: res.audio, script: res.script };
}

/** Everything for one claimed row. Throws RenderFail with a code; fills `spend`. */
async function renderPack(deps: RenderDeps, row: RenderRow, pack: PackRow, settings: RenderSettings, spend: Spend): Promise<AdVideoReady> {
  const ownerId = pack.ownerId;
  const log = deps.log ?? (() => {});

  const ads = await deps.packs.listAds(ownerId, pack.id);
  const ad = ads.find((a) => a.angle === '5b' && a.version === row.version);
  if (!ad) throw new RenderFail('bad_brief');
  const lines = scriptLinesOf(ad);
  if (lines.length < 3) throw new RenderFail('bad_brief');
  const figure = figureForBrief(pack.figures);
  if (figure === undefined) throw new RenderFail('bad_brief');

  const brand = await deps.loadBrand(ownerId, pack.websiteId);
  if (!brand) throw new RenderFail('store_failed');
  const company = brand.company.replace(/\s+/g, ' ').trim();
  if (!company) throw new RenderFail('bad_brief');

  // c: the cap, before any paid call. d: the voice.
  const effectiveMax = Math.min(settings.maxSeconds, ROUTE_MAX_SECONDS - ROUTE_RESERVE_SECONDS);
  const cpuSecondPence = await deps.sandboxCpuSecondPence();
  const capCheck = async (voiceWorstPence: number) => {
    const cap = (await deps.packs.readSettings()).monthlyCapPence;
    const spent = await deps.packs.monthSpendPence(monthStartIso(deps.now()));
    if (spent === null) throw new RenderFail('spend_unknown');
    const worst = wholePence(attemptPence({ vcpus: settings.vcpus, seconds: effectiveMax, cpuSecondPence, voicePence: voiceWorstPence }));
    if (!fitsCap(spent, worst, cap)) throw new RenderFail('monthly_cap');
  };
  const { audio, script } = await voiceFor(deps, ownerId, pack, row, lines, spend, capCheck);

  // e: the brief and the assets.
  const assets: Asset[] = [];
  let logo: string | null = null;
  if (brand.logoRef) {
    const a = await fetchAsset(deps, brand.logoRef, 'assets/logo');
    if (a) {
      assets.push(a);
      logo = a.path;
    }
  }
  const photoRefs = (pack.photos ?? []).slice(0, MAX_RENDER_PHOTOS);
  if (photoRefs.length === 0 && brand.sitePhotoRef) photoRefs.push(brand.sitePhotoRef);
  const photos: string[] = [];
  for (const ref of photoRefs) {
    const a = await fetchAsset(deps, ref, `assets/photo${photos.length + 1}`);
    if (a) {
      assets.push(a);
      photos.push(a.path);
    }
  }
  // A fee line only when the voice says it too, and only from the operator's own fee.
  const spokenFee = /management fee/i.test(lines.join(' '));
  const brief = buildBrief({
    company,
    colour: brand.colour,
    logo,
    photos,
    area: pack.areaLabel ?? '',
    bedrooms: pack.bedrooms,
    figure,
    feeSentence: spokenFee ? feeSentence(brand.feePct) || null : null,
    script,
  });
  if (briefProblems(brief).length > 0) throw new RenderFail('bad_brief');
  const rendererFiles = await deps.rendererFiles();

  // f: the sandbox. Stopped in a finally, always.
  const startMs = deps.now().getTime();
  const deadline = startMs + effectiveMax * 1000;
  const left = () => deadline - deps.now().getTime();
  let outputs: { src: (typeof OUTPUTS)[number] | typeof POSTER; bytes: Uint8Array }[] = [];
  let sandbox: SandboxLike | null = null;
  try {
    try {
      sandbox = await deps.sandbox({ vcpus: settings.vcpus, timeoutMs: effectiveMax * 1000 });
    } catch {
      throw new RenderFail('sandbox_failed');
    }
    spend.sandboxId = sandbox.id;
    try {
      await sandbox.writeFiles([
        ...rendererFiles,
        { path: BRIEF_PATH, content: new TextEncoder().encode(JSON.stringify(brief)) },
        { path: AUDIO_PATH, content: audio },
        ...assets,
      ]);
    } catch {
      throw new RenderFail('sandbox_failed');
    }

    const steps: { cmd: string; args: string[]; sudo?: boolean; env?: Record<string, string>; capMs: number; fail: string }[] = [
      { cmd: 'apt-get', args: ['update', '-qq'], sudo: true, capMs: 90_000, fail: 'sandbox_failed' },
      { cmd: 'apt-get', args: ['install', '-y', '-qq', '--no-install-recommends', 'ffmpeg'], sudo: true, env: { DEBIAN_FRONTEND: 'noninteractive' }, capMs: 150_000, fail: 'ffmpeg_failed' },
      { cmd: 'python3', args: ['-m', 'venv', VENV], capMs: 60_000, fail: 'sandbox_failed' },
      { cmd: `${VENV}/bin/pip`, args: ['install', '--quiet', '--disable-pip-version-check', '-r', 'ad-render/requirements.txt'], capMs: 120_000, fail: 'sandbox_failed' },
      { cmd: `${VENV}/bin/python`, args: ['ad-render/notice.py', '--brief', BRIEF_PATH], capMs: Number.POSITIVE_INFINITY, fail: 'render_failed' },
    ];
    for (const [i, step] of steps.entries()) {
      const remaining = left();
      if (remaining < 5_000) throw new RenderFail('timeout');
      const isRender = i === steps.length - 1;
      let res: SandboxRun;
      try {
        res = await sandbox.run({ cmd: step.cmd, args: step.args, ...(step.sudo ? { sudo: true } : {}), ...(step.env ? { env: step.env } : {}), timeoutMs: Math.floor(Math.min(step.capMs, remaining)) });
      } catch {
        throw new RenderFail('sandbox_failed');
      }
      if (res.timedOut) throw new RenderFail('timeout');
      if (res.exitCode !== 0) throw new RenderFail(isRender ? (renderErrCode(res.stderr) ?? step.fail) : step.fail);
    }

    // f2: measure what was made, still in the sandbox (the checks need the size, length, audio track and captions).
    spend.videos = [];
    const info = parseRenderInfo(await sandbox.readFile(RENDER_INFO_PATH).catch(() => null));
    for (const o of OUTPUTS) {
      const remaining = left();
      if (remaining < 2_000) throw new RenderFail('timeout');
      let res: SandboxRun;
      try {
        res = await sandbox.run({ cmd: 'ffprobe', args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', `${OUT_DIR}/${o.src}`], timeoutMs: Math.floor(Math.min(30_000, remaining)) });
      } catch {
        throw new RenderFail('sandbox_failed');
      }
      if (res.timedOut) throw new RenderFail('timeout');
      // A file ffprobe cannot read is measured as nothing: the video check then fails it in plain words.
      const probe = res.exitCode === 0 ? parseProbe(res.stdout) : null;
      spend.videos.push({ name: o.name, width: probe?.width ?? 0, height: probe?.height ?? 0, durationSeconds: probe?.durationSeconds ?? 0, hasAudio: probe?.hasAudio ?? false, captionCount: info?.captions ?? 0 });
    }

    outputs = [];
    for (const o of [...OUTPUTS, POSTER]) {
      let bytes: Uint8Array | null;
      try {
        bytes = await sandbox.readFile(`${OUT_DIR}/${o.src}`);
      } catch {
        throw new RenderFail('sandbox_failed');
      }
      const max = o.contentType === 'video/mp4' ? MAX_VIDEO_BYTES : MAX_POSTER_BYTES;
      const valid = bytes !== null && bytes.byteLength > 0 && bytes.byteLength <= max && (o.contentType === 'video/mp4' ? isMp4(bytes) : isPng(bytes));
      if (!valid || !bytes) throw new RenderFail('render_failed');
      outputs.push({ src: o, bytes });
    }
  } finally {
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch {
        log('sandbox_stop_failed', { packId: pack.id, code: 'sandbox_failed' });
      }
      spend.sandboxSeconds = Math.max(0, (deps.now().getTime() - startMs) / 1000);
    }
  }

  // g: the files.
  const folder = voicePaths(ownerId, pack.id, row.version).folder;
  const refs: AdFileRef[] = [];
  for (const o of outputs) {
    const p = `${folder}/${o.src.name}`;
    let up: { ok: boolean };
    try {
      up = await deps.storage.put(p, o.bytes, o.src.contentType);
    } catch {
      throw new RenderFail('upload_failed');
    }
    if (!up.ok) throw new RenderFail('upload_failed');
    refs.push({ name: o.src.name, path: p, width: o.src.width, height: o.src.height, contentType: o.src.contentType, bytes: o.bytes.byteLength });
  }
  const poster = refs.pop();
  if (!poster) throw new RenderFail('render_failed');
  const ready: AdVideoReady = { status: 'ready', videos: refs, poster, durationSeconds: Math.round(script.duration * 10) / 10, voice: row.voiceKey };

  const okSet = await deps.renders.setAdFiles(ownerId, ad.id, { images: ad.files.images, video: ready });
  if (!okSet) throw new RenderFail('store_failed');
  return ready;
}
