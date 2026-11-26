import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { DEFAULT_AD_PACK_SETTINGS, AD_PACK_KEYS, parseAdPackSettings, type AdPackSettings } from './settings.ts';
import { AD_COLUMNS, adInsertRow, PACK_COLUMN_OF, PACK_COLUMNS, parseFiles, RUN_COLUMNS, sortAds, toAdRow, toPackRow, toRunRow } from './rows.ts';
import { signedDownloadUrlWith } from './download.ts';
import {
  PackConflict,
  StoreError,
  type AdPackStore,
  type NewAd,
  type NewPack,
  type NewRun,
  type PackPatch,
  type PackStatus,
} from './store-types.ts';

export { parseAdPackSettings, type AdPackSettings } from './settings.ts';
export type { AdPackStore } from './store-types.ts';

/**
 * Batch 38: the ad pack's rows (ad_packs, ad_pack_ads, ad_pack_runs) and its
 * private storage bucket, service role only (RLS on, no policy).
 *
 *   createLiveStore()              the AdPackStore the generator runs on, over Supabase
 *   readAdPackSettings()           the five billing_settings values (defaults when unreadable)
 *   uploadFile(path, bytes, type)  one file into the private `ad-packs` bucket (upsert)
 *   signedDownloadUrl(owner, packAdId, fileName)
 *                                  a short signed link, ONLY after the pack ad is
 *                                  confirmed to be the owner's and to have that file
 *
 * Every owner-scoped call filters by owner_id. A read that fails THROWS
 * (StoreError with the database's error code): "no row" must never be
 * confused with "could not look". Nothing here logs an address, a text or a
 * body: a failure logs the table and the error code.
 */

const BUCKET = 'ad-packs';
const UUID = /^[0-9a-f-]{36}$/i;

type Admin = ReturnType<typeof createAdminClient>;
const admin = (): Admin => createAdminClient();

function isUnique(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

function conflictOf(error: { code?: string; message?: string; details?: string } | null): PackConflict {
  const text = `${error?.message ?? ''} ${error?.details ?? ''}`;
  if (/operator_code/.test(text)) return new PackConflict('operator_code');
  if (/ad_pack_ads_code_key|\(code\)/.test(text)) return new PackConflict('code');
  return new PackConflict('owner');
}

function fail(table: string, error: { code?: string } | null): never {
  const code = error?.code ?? 'error';
  console.error(`[ad-packs] ${table} failed:`, code);
  throw new StoreError(code);
}

// ── Settings ──

export async function readAdPackSettings(): Promise<AdPackSettings> {
  if (!hasServiceRole()) return { ...DEFAULT_AD_PACK_SETTINGS };
  const { data, error } = await admin().from('billing_settings').select('key, value').in('key', Object.values(AD_PACK_KEYS));
  if (error) console.error('[ad-packs] settings read failed, using defaults:', error.code ?? 'error');
  return parseAdPackSettings((data ?? []) as { key: string; value: unknown }[]);
}

// ── The store ──

export function createLiveStore(): AdPackStore {
  return {
    async getPack(ownerId) {
      if (!UUID.test(ownerId)) return null;
      const { data, error } = await admin().from('ad_packs').select(PACK_COLUMNS).eq('owner_id', ownerId).maybeSingle();
      if (error) fail('ad_packs read', error);
      return data ? toPackRow(data as Record<string, unknown>) : null;
    },

    async listAds(ownerId, packId) {
      if (!UUID.test(ownerId) || !UUID.test(packId)) return [];
      const { data, error } = await admin().from('ad_pack_ads').select(AD_COLUMNS).eq('owner_id', ownerId).eq('pack_id', packId);
      if (error) fail('ad_pack_ads read', error);
      return sortAds(((data ?? []) as Record<string, unknown>[]).map(toAdRow));
    },

    async getPackAd(ownerId, packAdId) {
      if (!UUID.test(ownerId) || !UUID.test(packAdId)) return null;
      const { data, error } = await admin().from('ad_pack_ads').select(AD_COLUMNS).eq('id', packAdId).eq('owner_id', ownerId).maybeSingle();
      if (error) fail('ad_pack_ads read', error);
      return data ? toAdRow(data as Record<string, unknown>) : null;
    },

    async takenOperatorCodes() {
      const { data, error } = await admin().from('ad_packs').select('operator_code');
      if (error) fail('ad_packs codes read', error);
      return new Set(((data ?? []) as { operator_code: string }[]).map((r) => String(r.operator_code).toUpperCase()));
    },

    async insertPack(r: NewPack) {
      const { data, error } = await admin()
        .from('ad_packs')
        .insert({ owner_id: r.ownerId, website_id: r.websiteId, operator_code: r.operatorCode, status: r.status, route: r.route ?? 'academy' })
        .select(PACK_COLUMNS)
        .single();
      if (isUnique(error)) throw conflictOf(error);
      if (error || !data) fail('ad_packs insert', error);
      return toPackRow(data as Record<string, unknown>);
    },

    async beginGenerating(ownerId, packId, staleBeforeIso) {
      if (!UUID.test(ownerId) || !UUID.test(packId)) return null;
      const { data, error } = await admin()
        .from('ad_packs')
        .update({ status: 'generating', error_code: null, updated_at: new Date().toISOString() })
        .eq('id', packId)
        .eq('owner_id', ownerId)
        .or(`status.neq.generating,updated_at.lt.${staleBeforeIso}`)
        .select(PACK_COLUMNS)
        .maybeSingle();
      if (error) fail('ad_packs claim', error);
      return data ? toPackRow(data as Record<string, unknown>) : null;
    },

    async updatePack(ownerId, packId, patch: PackPatch, guard?: { from?: readonly PackStatus[] }) {
      if (!UUID.test(ownerId) || !UUID.test(packId)) return null;
      const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const [k, v] of Object.entries(patch) as Array<[keyof PackPatch, unknown]>) if (v !== undefined) set[PACK_COLUMN_OF[k]] = v;
      let q = admin().from('ad_packs').update(set).eq('id', packId).eq('owner_id', ownerId);
      if (guard?.from) q = q.in('status', [...guard.from]);
      const { data, error } = await q.select(PACK_COLUMNS);
      if (error) fail('ad_packs update', error);
      const row = (data ?? [])[0];
      return row ? toPackRow(row as Record<string, unknown>) : null;
    },

    async insertAds(ownerId, ads: NewAd[]) {
      if (ads.length === 0) return [];
      if (ads.some((a) => a.ownerId !== ownerId)) throw new StoreError('owner');
      const { data, error } = await admin().from('ad_pack_ads').insert(ads.map(adInsertRow)).select(AD_COLUMNS);
      if (isUnique(error)) throw conflictOf(error);
      if (error) fail('ad_pack_ads insert', error);
      return sortAds(((data ?? []) as Record<string, unknown>[]).map(toAdRow));
    },

    async setAdVideo(ownerId, packAdId, video) {
      if (!UUID.test(ownerId) || !UUID.test(packAdId)) return false;
      const { data: cur, error: readError } = await admin().from('ad_pack_ads').select('files').eq('id', packAdId).eq('owner_id', ownerId).maybeSingle();
      if (readError) fail('ad_pack_ads files read', readError);
      if (!cur) return false;
      const files = parseFiles((cur as { files: unknown }).files);
      const { data, error } = await admin().from('ad_pack_ads').update({ files: { images: files.images, video } }).eq('id', packAdId).eq('owner_id', ownerId).select('id');
      if (error) fail('ad_pack_ads files', error);
      return (data ?? []).length > 0;
    },

    async clearAdsOfVersion(ownerId, packId, version) {
      const { data, error } = await admin().from('ad_pack_ads').delete().eq('owner_id', ownerId).eq('pack_id', packId).eq('version', version).select('id');
      if (error) fail('ad_pack_ads clear', error);
      return (data ?? []).length;
    },

    async supersedeAds(ownerId, packId, belowVersion, atIso) {
      const { data, error } = await admin()
        .from('ad_pack_ads')
        .update({ superseded_at: atIso })
        .eq('owner_id', ownerId)
        .eq('pack_id', packId)
        .lt('version', belowVersion)
        .is('superseded_at', null)
        .select('id');
      if (error) fail('ad_pack_ads supersede', error);
      return (data ?? []).length;
    },

    async insertRun(ownerId, run: NewRun) {
      // ad_pack_runs has no owner column: confirm the pack is the owner's first.
      const { data: own, error: ownError } = await admin().from('ad_packs').select('id').eq('id', run.packId).eq('owner_id', ownerId).maybeSingle();
      if (ownError) fail('ad_packs owner check', ownError);
      if (!own) return null;
      const { data, error } = await admin()
        .from('ad_pack_runs')
        .insert({ pack_id: run.packId, version: run.version, by: run.by, dry: false, cost_pence: run.costPence, result: run.result })
        .select(RUN_COLUMNS)
        .single();
      if (error || !data) fail('ad_pack_runs insert', error);
      return toRunRow(data as Record<string, unknown>);
    },

    async listRuns(ownerId, packId, limit = 50) {
      const { data: own, error: ownError } = await admin().from('ad_packs').select('id').eq('id', packId).eq('owner_id', ownerId).maybeSingle();
      if (ownError) fail('ad_packs owner check', ownError);
      if (!own) return [];
      const { data, error } = await admin().from('ad_pack_runs').select(RUN_COLUMNS).eq('pack_id', packId).order('created_at', { ascending: false }).limit(limit);
      if (error) fail('ad_pack_runs read', error);
      return ((data ?? []) as Record<string, unknown>[]).map(toRunRow);
    },

    async monthSpendPence(sinceIso) {
      const { data, error } = await admin().from('ad_pack_runs').select('cost_pence').eq('dry', false).gte('created_at', sinceIso);
      if (error) {
        console.error('[ad-packs] month spend read failed:', error.code ?? 'error');
        return null;
      }
      return ((data ?? []) as { cost_pence: number | string }[]).reduce((n, r) => n + (Number(r.cost_pence) || 0), 0);
    },

    readSettings: readAdPackSettings,
  };
}

// ── Storage ──

/** One file into the private bucket. Overwrites (a retry writes the same path). Never throws. */
export async function uploadFile(path: string, bytes: Uint8Array, contentType: string): Promise<{ ok: boolean }> {
  try {
    const { error } = await admin().storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true, cacheControl: '3600' });
    if (!error) return { ok: true };
    console.error('[ad-packs] upload failed:', /bucket not found|does not exist/i.test(error.message ?? '') ? 'bucket_missing' : 'error');
    return { ok: false };
  } catch {
    console.error('[ad-packs] upload failed: error');
    return { ok: false };
  }
}

/**
 * Remove stored files (paths as made by the generator or the worker: `<owner>/<pack>/v<n>/<file>`). Used by a voice
 * change to drop the cached voice.mp3 and script.json of a version. A path that is not that shape is skipped.
 * Never throws; `ok` is false when the storage call failed (a file that was already gone is not a failure).
 */
export async function deleteFiles(paths: readonly string[]): Promise<{ ok: boolean }> {
  const safe = paths.filter((p) => /^[0-9a-f-]{36}\/[0-9a-z-]{1,40}\/v\d{1,4}\/[0-9a-z._-]{1,80}$/i.test(p) && !p.includes('..'));
  if (safe.length === 0) return { ok: paths.length === 0 };
  try {
    const { error } = await admin().storage.from(BUCKET).remove(safe);
    if (!error) return { ok: safe.length === paths.length };
    console.error('[ad-packs] delete failed: error');
    return { ok: false };
  } catch {
    console.error('[ad-packs] delete failed: error');
    return { ok: false };
  }
}

/**
 * A short-lived (5 minutes) signed link to one file of one pack ad, or null.
 * Null when the pack ad is not the owner's, has no file by that name, or the
 * link cannot be made. The owner is checked BEFORE anything is signed.
 */
export async function signedDownloadUrl(ownerId: string, packAdId: string, fileName: string): Promise<string | null> {
  try {
    return await signedDownloadUrlWith(
      createLiveStore(),
      async (path, seconds, downloadName) => {
        const { data, error } = await admin().storage.from(BUCKET).createSignedUrl(path, seconds, { download: downloadName });
        if (error || !data?.signedUrl) {
          console.error('[ad-packs] could not sign a download link');
          return null;
        }
        return data.signedUrl;
      },
      ownerId,
      packAdId,
      fileName,
    );
  } catch {
    return null;
  }
}
