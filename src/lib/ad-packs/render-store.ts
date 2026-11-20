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
 * A voice change is a NEW pack version (made by the generator), so it gets its
 * own render row: a row is never reused for another voice.
 *
 * Codes only: nothing here carries a text, an address, stderr or a body.
 *
 * Pure: no network, no database, no server-only.
 */
import type { AdFileRef } from './store-types.ts';
import type { PackRow } from './store-types.ts';

export const RENDER_STATES = ['queued', 'running', 'done', 'failed'] as const;
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
};

export type RenderRow = {
  id: string;
  packId: string;
  version: number;
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
  createdAt: string;
  updatedAt: string;
};

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
  'monthly_cap',
  'spend_unknown',
  'voice_unavailable',
  'voice_no_key',
  'voice_rate_limited',
  'voice_quota',
  'voice_timeout',
  'voice_bad_response',
  'voice_failed',
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
export type RenderDone = { costPence: number; sandboxId: string | null; files: AdVideoReady; finishedAt: string };

export type RenderCounts = Record<RenderState, number>;

export interface RenderStore {
  /**
   * Queue the version's render, if it has none yet. Returns the row and whether
   * it was inserted. A failed row is left as it is (a voice change makes a new version).
   */
  enqueue(packId: string, version: number, voiceKey: string): Promise<{ inserted: boolean; row: RenderRow }>;
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
 * The 5b ad's `files.video` value read back: the ready shape, the coming
 * placeholder, or null. Phase B5 uses this in rows.ts parseFiles (which only
 * knows the placeholder today).
 */
export function parseAdVideo(raw: unknown): AdVideoReady | { status: 'coming' } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.status === 'coming') return { status: 'coming' };
  if (o.status !== 'ready') return null;
  const videos = Array.isArray(o.videos) ? o.videos.map(fileRef).filter((f): f is AdFileRef => f !== null) : [];
  const poster = fileRef(o.poster);
  if (videos.length === 0 || !poster) return null;
  return { status: 'ready', videos, poster, durationSeconds: Number(o.durationSeconds) || 0, voice: typeof o.voice === 'string' ? o.voice : '' };
}

export function toRenderRow(r: Record<string, unknown>): RenderRow {
  const state = (RENDER_STATES as readonly string[]).includes(r.state as string) ? (r.state as RenderState) : 'failed';
  const video = parseAdVideo(r.files);
  return {
    id: String(r.id),
    packId: String(r.pack_id),
    version: int(r.version, 1),
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
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export const RENDER_COLUMNS =
  'id, pack_id, version, voice_key, state, sandbox_id, attempts, lease_until, started_at, finished_at, cost_pence, error_code, files, created_at, updated_at';
