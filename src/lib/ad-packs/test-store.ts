/**
 * Batch 38: an in-memory AdPackStore, renderer, uploader and area source for
 * the tests. It mirrors what the SQL does: one pack per owner, unique operator
 * code, unique ad code, every read and write filtered by the owner id. Nothing
 * in the app imports it.
 */
import type { Look } from './ld-angles.ts';
import { DEFAULT_AD_PACK_SETTINGS, type AdPackSettings } from './settings.ts';
import { sortAds } from './rows.ts';
import {
  createAdPackEngine,
  type AreaSourceResult,
  type FileUploader,
  type GenerateDeps,
  type ImageRenderer,
  type Pricing,
  type RenderedImage,
} from './generate-core.ts';
import type { AdVideo, AdVideoReady } from './render-store.ts';
import { enqueueRender } from './render-core.ts';
import { mergeVideoChecks, VIDEO_SIZES } from './checks.ts';
import { MemoryRenderStore } from './render-test-store.ts';
import { PackConflict, StoreError, type AdPackStore, type NewAd, type NewPack, type NewRun, type PackAdRow, type PackPatch, type PackRow, type PackStatus, type RoundGrantRow, type RunRow } from './store-types.ts';
import type { AdRoute } from './eligibility.ts';
import { sumRunSpend } from './round-limit.ts';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryAdPackStore implements AdPackStore {
  readonly packs = new Map<string, PackRow>();
  readonly ads = new Map<string, PackAdRow>();
  readonly runs: (RunRow & { ownerId: string })[] = [];
  /** Batch 55 (A8): ad_pack_round_grants (the reason is never kept here, as nothing reads it back). */
  readonly grants: RoundGrantRow[] = [];
  settings: AdPackSettings = { ...DEFAULT_AD_PACK_SETTINGS };
  /** Every write, by name, so a dry run can be shown to have made none. */
  readonly writes: string[] = [];
  /** Make the next read of this kind throw (to test a failing database). */
  failNext: Partial<Record<'getPack' | 'insertAds' | 'updatePack' | 'monthSpend' | 'grants', boolean>> = {};
  /** Make monthSpendPence return null (unreadable). */
  spendUnreadable = false;
  clock: () => Date = () => new Date();
  private seq = 0;
  private tick = 0;

  private stamp(): string {
    return new Date(this.clock().getTime() + ++this.tick).toISOString();
  }

  async getPack(ownerId: string) {
    if (this.failNext.getPack) {
      this.failNext.getPack = false;
      throw new StoreError('read');
    }
    const p = [...this.packs.values()].find((x) => x.ownerId === ownerId);
    return p ? clone(p) : null;
  }

  async listAds(ownerId: string, packId: string) {
    return sortAds([...this.ads.values()].filter((a) => a.ownerId === ownerId && a.packId === packId)).map(clone);
  }

  async getPackAd(ownerId: string, packAdId: string) {
    const a = this.ads.get(packAdId);
    return a && a.ownerId === ownerId ? clone(a) : null;
  }

  async takenOperatorCodes() {
    return new Set([...this.packs.values()].map((p) => p.operatorCode));
  }

  async insertPack(r: NewPack) {
    this.writes.push('insertPack');
    if ([...this.packs.values()].some((p) => p.ownerId === r.ownerId)) throw new PackConflict('owner');
    if ([...this.packs.values()].some((p) => p.operatorCode === r.operatorCode)) throw new PackConflict('operator_code');
    const now = this.stamp();
    const row: PackRow = {
      id: `pack-${++this.seq}`,
      ownerId: r.ownerId,
      websiteId: r.websiteId,
      status: r.status,
      route: r.route ?? 'academy',
      operatorCode: r.operatorCode,
      version: 1,
      voiceKey: null,
      voiceChanges: 0,
      regenCount: 0,
      brandHash: null,
      areaKey: null,
      areaLabel: null,
      bedrooms: null,
      figures: null,
      photos: null,
      checks: null,
      errorCode: null,
      costPence: 0,
      generatedAt: null,
      approvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.packs.set(row.id, row);
    return clone(row);
  }

  async beginGenerating(ownerId: string, packId: string, staleBeforeIso: string) {
    const p = this.packs.get(packId);
    if (!p || p.ownerId !== ownerId) return null;
    if (p.status === 'generating' && p.updatedAt >= staleBeforeIso) return null;
    this.writes.push('beginGenerating');
    p.status = 'generating';
    p.errorCode = null;
    p.updatedAt = this.stamp();
    return clone(p);
  }

  async updatePack(ownerId: string, packId: string, patch: PackPatch, guard?: { from?: readonly PackStatus[] }) {
    if (this.failNext.updatePack) {
      this.failNext.updatePack = false;
      throw new StoreError('write');
    }
    const p = this.packs.get(packId);
    if (!p || p.ownerId !== ownerId) return null;
    if (guard?.from && !guard.from.includes(p.status)) return null;
    this.writes.push(`updatePack:${Object.keys(patch).join(',')}`);
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (p as Record<string, unknown>)[k] = clone(v);
    p.updatedAt = this.stamp();
    return clone(p);
  }

  async insertAds(ownerId: string, ads: NewAd[]) {
    if (this.failNext.insertAds) {
      this.failNext.insertAds = false;
      throw new StoreError('write');
    }
    this.writes.push('insertAds');
    const taken = new Set([...this.ads.values()].map((a) => a.code));
    for (const a of ads) if (taken.has(a.code)) throw new PackConflict('code');
    const out: PackAdRow[] = [];
    for (const a of ads) {
      const pack = this.packs.get(a.packId);
      if (!pack || pack.ownerId !== ownerId || a.ownerId !== ownerId) throw new StoreError('owner');
      const row: PackAdRow = { ...clone(a), id: `ad-${++this.seq}`, supersededAt: null, createdAt: this.stamp() };
      this.ads.set(row.id, row);
      out.push(clone(row));
    }
    return out;
  }

  async setAdVideo(ownerId: string, packAdId: string, video: AdVideo) {
    const ad = this.ads.get(packAdId);
    if (!ad || ad.ownerId !== ownerId) return false;
    this.writes.push('setAdVideo');
    ad.files = { images: ad.files.images, video: clone(video) };
    return true;
  }

  async clearAdsOfVersion(ownerId: string, packId: string, version: number) {
    const doomed = [...this.ads.values()].filter((a) => a.ownerId === ownerId && a.packId === packId && a.version === version);
    if (doomed.length > 0) this.writes.push('clearAdsOfVersion');
    for (const a of doomed) this.ads.delete(a.id);
    return doomed.length;
  }

  async supersedeAds(ownerId: string, packId: string, belowVersion: number, atIso: string) {
    let n = 0;
    for (const a of this.ads.values()) {
      if (a.ownerId === ownerId && a.packId === packId && a.version < belowVersion && a.supersededAt === null) {
        a.supersededAt = atIso;
        n++;
      }
    }
    if (n > 0) this.writes.push('supersedeAds');
    return n;
  }

  async insertRun(ownerId: string, run: NewRun) {
    const pack = this.packs.get(run.packId);
    if (!pack || pack.ownerId !== ownerId) return null;
    this.writes.push('insertRun');
    const row = { id: `run-${++this.seq}`, packId: run.packId, version: run.version, by: run.by, dry: false, costPence: run.costPence, result: clone(run.result), createdAt: this.clock().toISOString(), ownerId };
    this.runs.push(row);
    return clone(row);
  }

  async listRuns(ownerId: string, packId: string, limit = 50) {
    return this.runs
      .filter((r) => r.ownerId === ownerId && r.packId === packId)
      .slice()
      .reverse()
      .slice(0, limit)
      .map(clone);
  }

  async monthSpendPence(sinceIso: string, route?: AdRoute) {
    if (this.spendUnreadable) return null;
    // A run's route is its pack's (the real store joins on ad_pack_runs.pack_id).
    const spend = this.runs.map((r) => ({ route: this.packs.get(r.packId)?.route ?? 'academy', dry: r.dry, costPence: r.costPence, createdAt: r.createdAt }));
    return sumRunSpend(spend, route, sinceIso);
  }

  async listOperatorRunsSince(ownerId: string, packId: string, sinceIso: string) {
    return this.runs
      .filter((r) => r.ownerId === ownerId && r.packId === packId && r.by === 'operator' && !r.dry && r.createdAt >= sinceIso)
      .slice()
      .reverse()
      .map(clone);
  }

  async listUnusedRoundGrants(ownerId: string) {
    if (this.failNext.grants) {
      this.failNext.grants = false;
      throw new StoreError('read');
    }
    return this.grants.filter((g) => g.ownerId === ownerId && g.usedAt === null).map(clone);
  }

  async useRoundGrant(ownerId: string, grantId: string, atIso: string) {
    const g = this.grants.find((x) => x.id === grantId && x.ownerId === ownerId);
    if (!g || g.usedAt !== null) return false;
    this.writes.push('useRoundGrant');
    g.usedAt = atIso;
    return true;
  }

  /** A test's way to give an owner an admin grant of one more round (the admin screen does this through insertRoundGrant). */
  addGrant(ownerId: string, createdAt = this.clock().toISOString()): RoundGrantRow {
    const g: RoundGrantRow = { id: `grant-${++this.seq}`, ownerId, createdAt, usedAt: null };
    this.grants.push(g);
    return g;
  }

  async readSettings() {
    return { ...this.settings };
  }

  /** Batch 55 step 5: the looks of other owners' latest lead database packs in the area (the 5b ad of their current version). */
  async otherLooksInArea(ownerId: string, areaKey: string) {
    const out: Look[] = [];
    for (const p of this.packs.values()) {
      if (p.ownerId === ownerId || p.route !== 'leaddb' || p.areaKey !== areaKey) continue;
      const ad = [...this.ads.values()].find((a) => a.packId === p.id && a.version === p.version && a.angle === '5b');
      if (ad?.texts.ld?.look) out.push({ ...ad.texts.ld.look });
    }
    return out;
  }
}

// ── Fakes ──

/** A renderer that returns tiny fake PNGs named and sized like the real one, and counts its calls. */
export class FakeRenderer {
  calls: { angle: string; cards: number }[] = [];
  fail = false;
  /** Called with the images before they are returned (lets a test break a size). */
  tweak: ((images: RenderedImage[]) => RenderedImage[]) | null = null;
  readonly render: ImageRenderer = async (a) => {
    this.calls.push({ angle: a.angle, cards: a.cards.length });
    if (this.fail) throw new Error('boom: an address and a body that must never be stored');
    const out: RenderedImage[] = [];
    a.cards.forEach((_, i) => {
      for (const [key, w, h] of [['1x1', 1080, 1080], ['4x5', 1080, 1350], ['9x16', 1080, 1920]] as const) {
        out.push({ name: `${a.angle}-card${i + 1}-${key}.png`, width: w, height: h, png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, i, w & 255]) });
      }
    });
    return this.tweak ? this.tweak(out) : out;
  };
}

export class FakeUploader {
  files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  calls = 0;
  fail = false;
  readonly upload: FileUploader = async (path, bytes, contentType) => {
    this.calls++;
    if (this.fail) return { ok: false };
    this.files.set(path, { bytes, contentType });
    return { ok: true };
  };
}

export const GOOD_AGG = { bedrooms: 3, sample_count: 14, avg_gross_revenue: 48_200, avg_net_revenue: 31_000, avg_occupancy: 71.4 };

export type FakeArea = { result: AreaSourceResult; calls: number };

export function goodArea(areaKey = 'NG7'): AreaSourceResult {
  return { areaKey, areaLabel: 'Lenton, Nottingham', level: 'district', fellBack: false, bedrooms: 3, agg: { ...GOOD_AGG }, samples: 14 };
}

/** The 5b video as the worker leaves it when a render is done (names and sizes like the real ones). */
export function readyVideo(ownerId: string, packId: string, version: number, voice = 'jane'): AdVideoReady {
  const folder = `${ownerId}/${packId}/v${version}`;
  const f = (name: string, width: number, height: number, contentType: string) => ({ name, path: `${folder}/${name}`, width, height, contentType, bytes: 1234 });
  return {
    status: 'ready',
    videos: [f('notice-9x16.mp4', 1080, 1920, 'video/mp4'), f('notice-4x5.mp4', 1080, 1350, 'video/mp4'), f('notice-1x1.mp4', 1080, 1080, 'video/mp4')],
    poster: f('notice-poster.png', 1080, 1920, 'image/png'),
    durationSeconds: 38,
    voice,
  };
}

export interface Harness {
  store: MemoryAdPackStore;
  /** The render queue the generator enqueues into (a render worker test builds its own MemoryRenderStore). */
  renders: MemoryRenderStore;
  /** Every enqueue the generator asked for. */
  enqueues: { packId: string; version: number; voiceKey: string }[];
  /** 'code': the enqueue answers {ok:false, code:'store_failed'}; 'throw': it throws. */
  enqueueFails: 'code' | 'throw' | null;
  /** Every path the generator asked to delete, and whether the delete should fail. */
  deleted: string[];
  deleteFails: boolean;
  /** Make the current version's render done and the 5b slot ready (what the worker does), for the owner's pack. */
  finishVideo(ownerId: string, opts?: { version?: number }): Promise<void>;
  /** Put the current version's render in a state the worker would (queued rows exist after a generate). */
  setRender(ownerId: string, patch: { state?: 'queued' | 'running' | 'done' | 'failed'; errorCode?: string | null }, opts?: { version?: number }): Promise<void>;
  renderer: FakeRenderer;
  uploader: FakeUploader;
  area: FakeArea;
  logs: { event: string; fields: Record<string, unknown> }[];
  deps: GenerateDeps;
  engine: ReturnType<typeof createAdPackEngine>;
  /** The clock the engine and store read. */
  now: Date;
}

export function harness(opts: { pricing?: Pricing; now?: Date } = {}): Harness {
  const h = {} as Harness;
  h.now = opts.now ?? new Date('2026-11-20T10:00:00Z');
  h.store = new MemoryAdPackStore();
  h.store.clock = () => h.now;
  h.renders = new MemoryRenderStore(h.store);
  h.renders.clock = () => h.now;
  h.enqueues = [];
  h.enqueueFails = null;
  h.deleted = [];
  h.deleteFails = false;
  h.renderer = new FakeRenderer();
  h.uploader = new FakeUploader();
  h.area = { result: goodArea(), calls: 0 };
  h.logs = [];
  h.deps = {
    store: h.store,
    now: () => h.now,
    renderImages: h.renderer.render,
    upload: h.uploader.upload,
    areaFigureSource: async () => {
      h.area.calls++;
      return h.area.result;
    },
    pricing: opts.pricing,
    renders: {
      enqueue: async (i) => {
        h.enqueues.push({ ...i });
        if (h.enqueueFails === 'throw') throw new Error('boom: a url that must never be stored');
        if (h.enqueueFails === 'code') return { ok: false, code: 'store_failed' };
        return enqueueRender(h.renders, i);
      },
      get: (packId, version) => h.renders.getRender(packId, version),
      requeue: (i) => h.renders.requeueRender(i),
    },
    deleteFiles: async (paths) => {
      h.deleted.push(...paths);
      return { ok: !h.deleteFails };
    },
    log: (event, fields) => h.logs.push({ event, fields }),
  };
  h.finishVideo = async (ownerId, o = {}) => {
    const pack = await h.store.getPack(ownerId);
    if (!pack) throw new Error('no pack');
    const version = o.version ?? pack.version;
    const row = await h.renders.getRender(pack.id, version);
    if (!row) throw new Error('no render row');
    const ready = readyVideo(ownerId, pack.id, version, row.voiceKey);
    const live = [...h.renders.rows.values()].find((r) => r.id === row.id)!;
    live.state = 'done';
    live.errorCode = null;
    live.files = ready;
    const ad = (await h.store.listAds(ownerId, pack.id)).find((a) => a.angle === '5b' && a.version === version);
    if (ad) await h.store.setAdVideo(ownerId, ad.id, ready);
    // What the worker records with the render: the video check, run and passed (approve needs it).
    if (version === pack.version && pack.status === 'preview') {
      const videos = Object.entries(VIDEO_SIZES).map(([name, size]) => ({ name, ...size, durationSeconds: 38, hasAudio: true, captionCount: 17 }));
      await h.store.updatePack(ownerId, pack.id, { checks: mergeVideoChecks(pack.checks, videos) });
    }
  };
  h.setRender = async (ownerId, patch, o = {}) => {
    const pack = await h.store.getPack(ownerId);
    if (!pack) throw new Error('no pack');
    const row = await h.renders.getRender(pack.id, o.version ?? pack.version);
    if (!row) throw new Error('no render row');
    const live = [...h.renders.rows.values()].find((r) => r.id === row.id)!;
    if (patch.state) live.state = patch.state;
    if (patch.errorCode !== undefined) live.errorCode = patch.errorCode;
  };
  h.engine = createAdPackEngine(h.deps);
  return h;
}
