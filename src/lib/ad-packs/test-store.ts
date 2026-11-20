/**
 * Batch 36: an in-memory AdPackStore, renderer, uploader and area source for
 * the tests. It mirrors what the SQL does: one pack per owner, unique operator
 * code, unique ad code, every read and write filtered by the owner id. Nothing
 * in the app imports it.
 */
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
import { PackConflict, StoreError, type AdPackStore, type NewAd, type NewPack, type NewRun, type PackAdRow, type PackPatch, type PackRow, type PackStatus, type RunRow } from './store-types.ts';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryAdPackStore implements AdPackStore {
  readonly packs = new Map<string, PackRow>();
  readonly ads = new Map<string, PackAdRow>();
  readonly runs: (RunRow & { ownerId: string })[] = [];
  settings: AdPackSettings = { ...DEFAULT_AD_PACK_SETTINGS };
  /** Every write, by name, so a dry run can be shown to have made none. */
  readonly writes: string[] = [];
  /** Make the next read of this kind throw (to test a failing database). */
  failNext: Partial<Record<'getPack' | 'insertAds' | 'updatePack' | 'monthSpend', boolean>> = {};
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

  async monthSpendPence(sinceIso: string) {
    if (this.spendUnreadable) return null;
    return this.runs.filter((r) => !r.dry && r.createdAt >= sinceIso).reduce((n, r) => n + r.costPence, 0);
  }

  async readSettings() {
    return { ...this.settings };
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

export interface Harness {
  store: MemoryAdPackStore;
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
    log: (event, fields) => h.logs.push({ event, fields }),
  };
  h.engine = createAdPackEngine(h.deps);
  return h;
}
