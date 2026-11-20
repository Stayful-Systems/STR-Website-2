/**
 * Batch 36: database rows to the typed rows of store-types.ts, and back (the
 * column lists and patch maps the live store uses). Defensive about jsonb: a
 * value that is not the shape written reads as empty, never as a crash.
 *
 * Pure: no network, no database, no server-only.
 */
import { isAngle } from './codes.ts';
import type { AdFileRef, AdFiles, AdTexts, NewAd, PackAdRow, PackPatch, PackRow, PackStatus, RunBy, RunResult, RunRow } from './store-types.ts';
import { PACK_STATUSES } from './store-types.ts';
import type { LeadFormQuestion } from './angles.ts';
import type { ChecksOutput } from './checks.ts';

export const PACK_COLUMNS =
  'id, owner_id, website_id, status, operator_code, version, voice_key, voice_changes, regen_count, brand_hash, area_key, area_label, bedrooms, figures, photos, checks, error_code, cost_pence, generated_at, approved_at, created_at, updated_at';
export const AD_COLUMNS = 'id, pack_id, owner_id, version, angle, n, code, ad_name, link, texts, lead_form, files, superseded_at, created_at';
export const RUN_COLUMNS = 'id, pack_id, version, by, dry, cost_pence, result, created_at';

/** PackPatch field -> ad_packs column. */
export const PACK_COLUMN_OF: Record<keyof PackPatch, string> = {
  websiteId: 'website_id',
  status: 'status',
  version: 'version',
  voiceKey: 'voice_key',
  voiceChanges: 'voice_changes',
  regenCount: 'regen_count',
  brandHash: 'brand_hash',
  areaKey: 'area_key',
  areaLabel: 'area_label',
  bedrooms: 'bedrooms',
  figures: 'figures',
  photos: 'photos',
  checks: 'checks',
  errorCode: 'error_code',
  costPence: 'cost_pence',
  generatedAt: 'generated_at',
  approvedAt: 'approved_at',
};

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback;
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function toPackRow(r: Record<string, unknown>): PackRow {
  const status = (PACK_STATUSES as readonly string[]).includes(r.status as string) ? (r.status as PackStatus) : 'failed';
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    websiteId: str(r.website_id),
    status,
    operatorCode: String(r.operator_code),
    version: int(r.version, 1),
    voiceKey: str(r.voice_key),
    voiceChanges: int(r.voice_changes),
    regenCount: int(r.regen_count),
    brandHash: str(r.brand_hash),
    areaKey: str(r.area_key),
    areaLabel: str(r.area_label),
    bedrooms: r.bedrooms === null || r.bedrooms === undefined ? null : int(r.bedrooms),
    figures: Array.isArray(r.figures) ? (r.figures as unknown[]) : null,
    photos: Array.isArray(r.photos) ? strings(r.photos) : null,
    checks: r.checks && typeof r.checks === 'object' ? (r.checks as ChecksOutput) : null,
    errorCode: str(r.error_code),
    costPence: int(r.cost_pence),
    generatedAt: str(r.generated_at),
    approvedAt: str(r.approved_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function parseTexts(raw: unknown): AdTexts {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: AdTexts = { primary: strings(o.primary), headlines: strings(o.headlines), descriptions: strings(o.descriptions) };
  if (typeof o.script === 'string') out.script = o.script;
  if (Array.isArray(o.cardsText)) out.cardsText = strings(o.cardsText);
  return out;
}

export function parseFiles(raw: unknown): AdFiles {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const images: AdFileRef[] = [];
  if (Array.isArray(o.images)) {
    for (const f of o.images) {
      if (!f || typeof f !== 'object') continue;
      const x = f as Record<string, unknown>;
      if (typeof x.name !== 'string' || typeof x.path !== 'string') continue;
      images.push({ name: x.name, path: x.path, width: int(x.width), height: int(x.height), contentType: str(x.contentType) ?? 'image/png', bytes: int(x.bytes) });
    }
  }
  const v = o.video;
  const video = v && typeof v === 'object' && (v as { status?: unknown }).status === 'coming' ? { status: 'coming' as const } : null;
  return { images, video };
}

export function toAdRow(r: Record<string, unknown>): PackAdRow {
  return {
    id: String(r.id),
    packId: String(r.pack_id),
    ownerId: String(r.owner_id),
    version: int(r.version, 1),
    angle: isAngle(r.angle) ? r.angle : '5b',
    n: int(r.n, 1),
    code: String(r.code),
    adName: String(r.ad_name ?? ''),
    link: String(r.link ?? ''),
    texts: parseTexts(r.texts),
    leadForm: Array.isArray(r.lead_form) ? (r.lead_form as LeadFormQuestion[]) : [],
    files: parseFiles(r.files),
    supersededAt: str(r.superseded_at),
    createdAt: String(r.created_at),
  };
}

export function adInsertRow(a: NewAd): Record<string, unknown> {
  return {
    pack_id: a.packId,
    owner_id: a.ownerId,
    version: a.version,
    angle: a.angle,
    n: a.n,
    code: a.code,
    ad_name: a.adName,
    link: a.link,
    texts: a.texts,
    lead_form: a.leadForm,
    files: a.files,
  };
}

export function toRunRow(r: Record<string, unknown>): RunRow {
  return {
    id: String(r.id),
    packId: String(r.pack_id),
    version: int(r.version, 1),
    by: (r.by === 'admin' ? 'admin' : 'operator') as RunBy,
    dry: r.dry === true,
    costPence: int(r.cost_pence),
    result: r.result && typeof r.result === 'object' ? (r.result as RunResult) : null,
    createdAt: String(r.created_at),
  };
}

/** The angle order the screen lists ads in. */
export const ANGLE_SORT: Record<string, number> = { '5b': 0, '3a': 1, '17': 2 };

/** Newest version first, then 5b, 3a, 17. */
export function sortAds<T extends { version: number; angle: string }>(ads: T[]): T[] {
  return [...ads].sort((a, b) => b.version - a.version || (ANGLE_SORT[a.angle] ?? 9) - (ANGLE_SORT[b.angle] ?? 9));
}
