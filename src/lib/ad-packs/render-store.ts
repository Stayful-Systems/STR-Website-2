/**
 * Batch 38b: the notice video's render queue, as types and pure helpers. The
 * real store (render-store-server.ts) is over Supabase; render-test-store.ts is
 * an in-memory copy for the tests.
 *
 * Column mapping (supabase/schema.sql, "Batch 38b: notice video renders"):
 *   ad_pack_renders -> RenderRow   one row per (pack, version): the queue the
 *                                  cron worker drains, with its lease, attempts,
 *                                  cost and the files it made
 *
 * States: queued -> running (claimed, lease_until set, attempts + 1)
 *                   -> done | queued (retry) | failed
 * A running row whose lease passed was cut off: the sweep puts it back to
 * queued (attempts stay counted) or fails it with `timeout` once attempts has
 * reached the limit.
 *
 * A voice change does NOT make a new pack version: the same version's row is reset in place
 * (requeueRender: queued again, new voice, error and files cleared, cost kept, attempts back to 0). An operator's
 * retry resets it the same way but keeps `attempts`, so the tries add up. A row never outlives its version: the worker
 * fails a row whose version is no longer the pack's current one with `superseded`.
 *
 * Codes only: nothing here carries a text, an address, stderr or a body.
 *
 * Pure: no network, no database, no server-only.
 */
import type { AdFileRef } from './store-types.ts';
import type { PackRow } from './store-types.ts';

export const RENDER_STATES = ['queued', 'running', 'done', 'failed'] as const;

/**
 * Batch 55 step 5 (Phase 2): what a render row makes (ad_pack_renders.kind; (pack_id, version, kind) is unique).
 *   notice          the batch 38 notice video of the 5b ad (the Academy's only kind; the lead database's fallback)
 *   example_report  the example report a lead database pack is built from, and its masked page pictures
 *   phone           the lead database 5b video: the calculator on a phone, then the report (report_walk.py)
 *   loupe           the lead database 17 video: a report page under a moving magnifier (loupe.py)
 * A row without a kind is a notice row: RenderRow.kind is left out for it, so every batch 38 row reads as before.
 */
export const RENDER_KINDS = ['notice', 'example_report', 'phone', 'loupe'] as const;
export type RenderKind = (typeof RENDER_KINDS)[number];
export const isRenderKind = (v: unknown): v is RenderKind => typeof v === 'string' && (RENDER_KINDS as readonly string[]).includes(v);
/** The kind of a row (absent is 'notice'). */
export const kindOf = (r: { kind?: RenderKind | null }): RenderKind => r.kind ?? 'notice';
/** The video kinds and the ad whose `files.video` slot they fill. */
export const VIDEO_KIND_ANGLE: Record<Exclude<RenderKind, 'example_report'>, '5b' | '17'> = { notice: '5b', phone: '5b', loupe: '17' };
export type RenderState = (typeof RENDER_STATES)[number];

/**
 * The 5b ad's video slot once the render is done. `files.video` of the ad
 * (ad_pack_ads.files) holds this instead of {status:'coming'}. `videos` are the
 * three sizes (names notice-9x16.mp4, notice-4x5.mp4, notice-1x1.mp4), `poster`
 * is the still (notice-poster.png), all under `<owner>/<pack>/v<n>/` in the
 * private `ad-packs` bucket.
 */
export type AdVideoReady = {
  status: 'ready';
  videos: AdFileRef[];
  poster: AdFileRef;
  /** The length of the voiceover (the video is as long as the audio). */
  durationSeconds: number;
  /** The voice key the video was made with ('jane' | 'olivia' | 'oliver'). */
  voice: string;
  /** Batch 55 step 5: the first frame's picture measure (ld-gate.ts), on the lead database videos only. */
  firstFrame?: { hist: number[]; thumb: number[] };
};

/**
 * Everything the 5b ad's `files.video` slot can hold (ad_pack_ads.files):
 *   coming   a pack from before the video existed (never written by 38b)
 *   queued   the render is waiting for the worker
 *   making   the worker has it
 *   ready    AdVideoReady (the three MP4s and the poster)
 *   failed   the render could not be made; `code` is a short RENDER_CODES / enqueue code, never a message
 */
export type AdVideo = AdVideoReady | { status: 'coming' } | { status: 'queued' } | { status: 'making' } | { status: 'failed'; code: string };
export const AD_VIDEO_STATUSES = ['coming', 'queued', 'making', 'ready', 'failed'] as const;

export type RenderRow = {
  id: string;
  packId: string;
  version: number;
  /** Batch 55 step 5: left out for a notice row (the batch 38 kind), so those rows read exactly as before. */
  kind?: RenderKind;
  voiceKey: string;
  state: RenderState;
  sandboxId: string | null;
  attempts: number;
  leaseUntil: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  costPence: number;
  errorCode: string | null;
  files: AdVideoReady | null;
  /** Batch 55 step 5: an example_report row's pages, once done (left out on every other row). */
  example?: ExampleReady;
  createdAt: string;
  updatedAt: string;
  /**
   * The completion email (notify-core.ts): when it was claimed (and, once sent, sent) and which result it was for.
   * Null until then; a voice change or a retry that re-queues the row resets both so the new result emails again.
   * Optional so a literal row without them (a test's) still types; toRenderRow always sets them.
   */
  notifiedAt?: string | null;
  notifiedOutcome?: NotifyOutcome | null;
};

/** What the completion email was decided to be: the "ready" email, the "could not finish" email, or none ('skipped'). */
export type NotifyOutcome = 'ready' | 'failed' | 'skipped';
export const NOTIFY_OUTCOMES: readonly NotifyOutcome[] = ['ready', 'failed', 'skipped'];

/** The error codes a render row may carry (short codes only; the column allows 60 characters). */
export const RENDER_CODES = [
  'sandbox_failed',
  'ffmpeg_failed',
  'render_failed',
  'missing_asset',
  'bad_brief',
  'timeout',
  'upload_failed',
  'store_failed',
  'superseded',
  'monthly_cap',
  'spend_unknown',
  'voice_unavailable',
  'voice_no_key',
  'voice_rate_limited',
  'voice_quota',
  'voice_timeout',
  'voice_bad_response',
  'voice_failed',
  // Batch 55 step 5 (Phase 2): the example report step (never blocks the pack: the fallback look is used and the code kept).
  'example_failed',
  'example_thin',
  'example_no_figures',
  'pages_failed',
  'no_example',
] as const;
export type RenderCode = (typeof RENDER_CODES)[number];

/** What a render's finish writes. */
export type RenderFinish = {
  state: 'queued' | 'failed';
  errorCode: string;
  costPence: number;
  sandboxId: string | null;
  finishedAt: string | null;
};
export type RenderDone = { costPence: number; sandboxId: string | null; files: AdVideoReady | ExampleReady; finishedAt: string };

/**
 * Batch 55 step 5: what a finished example_report row holds (ad_pack_renders.files): the masked pages in the bucket,
 * the loupe's three stops (fractions of a page), how many £ words were blurred, and whether the figures came from a
 * fresh run or a stripped finished report. Never an address, a title or a figure.
 */
export type ExampleReady = {
  status: 'example';
  pages: AdFileRef[];
  targets: { page: number; x: number; y: number; w: number; h: number }[];
  masked: number;
  source: 'run' | 'snapshot';
};

export function parseExampleReady(raw: unknown): ExampleReady | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.status !== 'example' || !Array.isArray(o.pages)) return null;
  const pages = o.pages.map(fileRef).filter((f): f is AdFileRef => f !== null);
  if (pages.length === 0) return null;
  const targets = Array.isArray(o.targets)
    ? (o.targets as Record<string, unknown>[]).map((t) => ({ page: int(t?.page), x: Number(t?.x), y: Number(t?.y), w: Number(t?.w), h: Number(t?.h) })).filter((t) => [t.x, t.y, t.w, t.h].every(Number.isFinite))
    : [];
  return { status: 'example', pages, targets, masked: int(o.masked), source: o.source === 'snapshot' ? 'snapshot' : 'run' };
}

export type RenderCounts = Record<RenderState, number>;

/**
 * A voice change and a retry write this (a row is reset in place: same pack, same version, no new version).
 * `keepAttempts` (an operator's retry) leaves `attempts` as it is, so the tries of the row add up and
 * retryVideo can stop them; without it (a voice change) attempts start again at 0.
 */
export type RenderRequeue = { packId: string; version: number; voiceKey: string; keepAttempts?: boolean; /** Absent is 'notice'. */ kind?: RenderKind };

/**
 * Codes a retry cannot fix: the voice is not in the account (change the voice instead), a brief the
 * renderer refuses, and a render whose pack moved on (superseded). Every other failure (a sandbox hiccup, a cap, a voice quota) may be tried again.
 */
export const NO_RETRY_RENDER_CODES: ReadonlySet<string> = new Set(['voice_unavailable', 'bad_brief', 'superseded']);
export const isRetryableRenderCode = (code: string | null | undefined): boolean => typeof code === 'string' && code !== '' && !NO_RETRY_RENDER_CODES.has(code);

export interface RenderStore {
  /**
   * Queue the version's render, if it has none yet. Returns the row and whether
   * it was inserted. A failed row is left as it is (a voice change makes a new version).
   */
  enqueue(packId: string, version: number, voiceKey: string, kind?: RenderKind): Promise<{ inserted: boolean; row: RenderRow }>;
  /** Queued rows, oldest first. */
  listQueued(limit: number): Promise<RenderRow[]>;
  /** Running rows whose lease ended before the instant. */
  listExpired(nowIso: string, limit: number): Promise<RenderRow[]>;
  /** How many rows are in each state (for the dry run). */
  counts(): Promise<RenderCounts>;
  /**
   * Take a queued row: state running, lease_until set, attempts + 1, started_at now,
   * error cleared. Conditional (only while it is still queued): null when someone else took it.
   */
  claim(id: string, nowIso: string, leaseUntilIso: string): Promise<RenderRow | null>;
  /**
   * Put a claimed row back to queued or on to failed. Conditional on the row still
   * being running at `claimedAttempts` (so a row the sweep gave to someone else is left alone).
   */
  release(id: string, claimedAttempts: number, patch: RenderFinish): Promise<boolean>;
  /** Mark a claimed row done (same condition as release). */
  complete(id: string, claimedAttempts: number, patch: RenderDone): Promise<boolean>;
  /**
   * Sweep one expired row: back to queued, or failed with `timeout` when attempts
   * has reached maxAttempts. Conditional on it still being running and expired.
   */
  expire(id: string, attempts: number, nowIso: string, maxAttempts: number): Promise<'requeued' | 'failed' | null>;
  /** The pack of a render (by pack id, no owner filter: the worker is the system). */
  getPack(packId: string): Promise<PackRow | null>;
  /** Set the files of one pack ad (only if the ad belongs to the owner). */
  setAdFiles(ownerId: string, packAdId: string, files: Record<string, unknown>): Promise<boolean>;
  /** The version's render row, or null. */
  getRender(packId: string, version: number, kind?: RenderKind): Promise<RenderRow | null>;
  /**
   * Reset the version's render to start again (a voice change, or a retry of a failed render): state queued,
   * attempts 0 (kept when `keepAttempts`), error, files, lease and finish time cleared, voice_key = the given one, cost kept. Creates the row
   * when there is none. Conditional: null when the row is `running` (a worker has it), and nothing is changed.
   */
  requeueRender(i: RenderRequeue): Promise<RenderRow | null>;
  /**
   * Finished renders (done or failed) that nobody has been told about yet and that finished at or after `sinceIso`,
   * oldest first. The window is what bounds the tries of a send that keeps failing.
   */
  listUnnotified(sinceIso: string, limit: number): Promise<RenderRow[]>;
  /**
   * Claim the completion email of a finished render, atomically: one conditional update (notified_at is null AND the
   * row is still in `state`) that sets notified_at = atIso and notified_outcome = outcome. Null when someone else
   * claimed it, or the row was re-queued meanwhile. Returns the row as claimed.
   */
  claimNotify(i: { id: string; state: 'done' | 'failed'; outcome: NotifyOutcome; atIso: string }): Promise<RenderRow | null>;
  /** Give a claim back after a failed send (only the claim made at `atIso`), so the next pass tries again. */
  releaseNotify(id: string, atIso: string): Promise<void>;
}

// ── Settings (billing_settings, seeded by the Batch 38b block) ──

export type RenderSettings = {
  /** Hard time limit for one render (the sandbox timeout), seconds. */
  maxSeconds: number;
  /** Tries before a render is left failed. */
  maxAttempts: number;
  /** vCPUs asked for per sandbox. */
  vcpus: number;
};

export const RENDER_SETTING_KEYS = {
  maxSeconds: 'ad_pack_render_max_seconds',
  maxAttempts: 'ad_pack_render_max_attempts',
  vcpus: 'ad_pack_sandbox_vcpus',
} as const satisfies Record<keyof RenderSettings, string>;

export const DEFAULT_RENDER_SETTINGS: RenderSettings = { maxSeconds: 300, maxAttempts: 3, vcpus: 2 };

function wholeIn(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** The three settings from billing_settings rows (a missing or malformed value falls back to its default). */
export function parseRenderSettings(rows: readonly { key: string; value: unknown }[] | null | undefined): RenderSettings {
  const kv = new Map<string, unknown>();
  for (const r of rows ?? []) if (r && typeof r.key === 'string') kv.set(r.key, r.value);
  const d = DEFAULT_RENDER_SETTINGS;
  return {
    maxSeconds: wholeIn(kv.get(RENDER_SETTING_KEYS.maxSeconds), 60, 900, d.maxSeconds),
    maxAttempts: wholeIn(kv.get(RENDER_SETTING_KEYS.maxAttempts), 1, 10, d.maxAttempts),
    vcpus: wholeIn(kv.get(RENDER_SETTING_KEYS.vcpus), 1, 8, d.vcpus),
  };
}

// ── jsonb readers ──

const int = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback;
};

function fileRef(v: unknown): AdFileRef | null {
  if (!v || typeof v !== 'object') return null;
  const x = v as Record<string, unknown>;
  if (typeof x.name !== 'string' || typeof x.path !== 'string') return null;
  return {
    name: x.name,
    path: x.path,
    width: int(x.width),
    height: int(x.height),
    contentType: typeof x.contentType === 'string' && x.contentType !== '' ? x.contentType : 'application/octet-stream',
    bytes: int(x.bytes),
  };
}

/**
 * The 5b ad's `files.video` value read back (rows.ts parseFiles uses it): the
 * ready shape, one of the other four slots, or null for anything else.
 */
export function parseAdVideo(raw: unknown): AdVideo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.status === 'coming') return { status: 'coming' };
  if (o.status === 'queued') return { status: 'queued' };
  if (o.status === 'making') return { status: 'making' };
  if (o.status === 'failed') return { status: 'failed', code: typeof o.code === 'string' && o.code !== '' ? o.code.slice(0, 60) : 'render_failed' };
  if (o.status !== 'ready') return null;
  const videos = Array.isArray(o.videos) ? o.videos.map(fileRef).filter((f): f is AdFileRef => f !== null) : [];
  const poster = fileRef(o.poster);
  if (videos.length === 0 || !poster) return null;
  const ff = o.firstFrame as { hist?: unknown; thumb?: unknown } | undefined;
  const firstFrame = ff && Array.isArray(ff.hist) && Array.isArray(ff.thumb) && ff.hist.length === 64 && ff.thumb.length === 1024 ? { hist: ff.hist.map(Number), thumb: ff.thumb.map(Number) } : null;
  return { status: 'ready', videos, poster, durationSeconds: Number(o.durationSeconds) || 0, voice: typeof o.voice === 'string' ? o.voice : '', ...(firstFrame ? { firstFrame } : {}) };
}

export function toRenderRow(r: Record<string, unknown>): RenderRow {
  const state = (RENDER_STATES as readonly string[]).includes(r.state as string) ? (r.state as RenderState) : 'failed';
  const video = parseAdVideo(r.files);
  return {
    id: String(r.id),
    packId: String(r.pack_id),
    version: int(r.version, 1),
    ...(isRenderKind(r.kind) && r.kind !== 'notice' ? { kind: r.kind } : {}),
    voiceKey: String(r.voice_key ?? ''),
    state,
    sandboxId: typeof r.sandbox_id === 'string' && r.sandbox_id !== '' ? r.sandbox_id : null,
    attempts: int(r.attempts),
    leaseUntil: typeof r.lease_until === 'string' ? r.lease_until : null,
    startedAt: typeof r.started_at === 'string' ? r.started_at : null,
    finishedAt: typeof r.finished_at === 'string' ? r.finished_at : null,
    costPence: int(r.cost_pence),
    errorCode: typeof r.error_code === 'string' && r.error_code !== '' ? r.error_code : null,
    files: video && video.status === 'ready' ? video : null,
    ...(r.kind === 'example_report' && parseExampleReady(r.files) ? { example: parseExampleReady(r.files) as ExampleReady } : {}),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    notifiedAt: typeof r.notified_at === 'string' ? r.notified_at : null,
    notifiedOutcome: (NOTIFY_OUTCOMES as readonly unknown[]).includes(r.notified_outcome) ? (r.notified_outcome as NotifyOutcome) : null,
  };
}

export const RENDER_COLUMNS =
  'id, pack_id, version, kind, voice_key, state, sandbox_id, attempts, lease_until, started_at, finished_at, cost_pence, error_code, files, created_at, updated_at, notified_at, notified_outcome';
