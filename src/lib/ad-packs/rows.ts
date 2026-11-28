/**
 * Batch 38: database rows to the typed rows of store-types.ts, and back (the
 * column lists and patch maps the live store uses). Defensive about jsonb: a
 * value that is not the shape written reads as empty, never as a crash.
 *
 * Pure: no network, no database, no server-only.
 */
import { isAngle } from './codes.ts';
import { CONCEPT_ID_RE, isAdFormat } from './concepts.ts';
import type { AdFileRef, AdFiles, AdTexts, LdTexts, NewAd, PackAdRow, PackPatch, PackRow, PackStatus, RunBy, RunResult, RunRow, VideoBrand } from './store-types.ts';
import { isLook } from './ld-gate.ts';
import { PACK_STATUSES } from './store-types.ts';
import type { LeadFormQuestion } from './angles.ts';
import type { ChecksOutput } from './checks.ts';
import { parseAdVideo } from './render-store.ts';

export const PACK_COLUMNS =
  'id, owner_id, website_id, status, route, operator_code, version, voice_key, voice_changes, regen_count, brand_hash, area_key, area_label, bedrooms, figures, photos, checks, error_code, cost_pence, generated_at, approved_at, created_at, updated_at';
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
    route: r.route === 'leaddb' ? 'leaddb' : 'academy',
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

function parseVideoBrand(raw: unknown): VideoBrand | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.company !== 'string' || typeof o.areaLabel !== 'string') return null;
  const bedrooms = typeof o.bedrooms === 'number' && Number.isFinite(o.bedrooms) ? Math.trunc(o.bedrooms) : null;
  return {
    company: o.company,
    colour: typeof o.colour === 'string' && o.colour !== '' ? o.colour : null,
    logoRef: typeof o.logoRef === 'string' && o.logoRef !== '' ? o.logoRef : null,
    sitePhotoRef: typeof o.sitePhotoRef === 'string' && o.sitePhotoRef !== '' ? o.sitePhotoRef : null,
    photos: strings(o.photos).slice(0, 4),
    areaLabel: o.areaLabel,
    bedrooms,
    feeSentence: typeof o.feeSentence === 'string' && o.feeSentence !== '' ? o.feeSentence : null,
    figure: o.figure && typeof o.figure === 'object' && !Array.isArray(o.figure) ? (o.figure as Record<string, unknown>) : null,
  };
}

export function parseTexts(raw: unknown): AdTexts {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: AdTexts = { primary: strings(o.primary), headlines: strings(o.headlines), descriptions: strings(o.descriptions) };
  if (typeof o.script === 'string') out.script = o.script;
  if (Array.isArray(o.cardsText)) out.cardsText = strings(o.cardsText);
  const brand = parseVideoBrand(o.brand);
  if (brand) out.brand = brand;
  const ld = parseLdTexts(o.ld);
  if (ld) out.ld = ld;
  return out;
}

/** Batch 55 step 5: the lead database ad's pinned screen lines and look, or null (an Academy ad never has them). */
function parseLdTexts(raw: unknown): LdTexts | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.screenLines) || !isLook(o.look)) return null;
  const out: LdTexts = { screenLines: strings(o.screenLines), look: { base: o.look.base, hook: o.look.hook } };
  if (Array.isArray(o.scriptLines)) out.scriptLines = strings(o.scriptLines);
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
  return { images, video: parseAdVideo(o.video) };
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
    // Batch 55 step 5: read only when the select carried them (AD_COLUMNS does not yet, so an older schema still reads).
    ...(typeof r.concept_id === 'string' && CONCEPT_ID_RE.test(r.concept_id) ? { conceptId: r.concept_id } : {}),
    ...(isAdFormat(r.format) ? { format: r.format } : {}),
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
    // Batch 55 step 5 (55c A6): only when set (the lead database route), so an Academy row is written exactly as before.
    ...(a.conceptId ? { concept_id: a.conceptId } : {}),
    ...(a.format ? { format: a.format } : {}),
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
