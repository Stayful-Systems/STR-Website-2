import 'server-only';

import { createAdminClient } from '../supabase/admin';
import { getUnitCostTable } from '../credit/unit-costs';
import { priceFor } from '../credit/pricing';
import { UNIT_COST_SEED } from '../credit/costs';
import { PACK_COLUMNS, toPackRow } from './rows.ts';
import { parseRenderSettings, RENDER_COLUMNS, RENDER_SETTING_KEYS, RENDER_STATES, toRenderRow, type RenderCounts, type RenderSettings, type RenderStore } from './render-store.ts';
import type { StorageLike } from './render-core.ts';
import { StoreError } from './store-types.ts';
import { uploadFile } from './store-server.ts';

/**
 * Batch 38b: the render queue (ad_pack_renders) and the pack bucket's reads
 * for the render worker, service role only (RLS on, no policy).
 *
 * A read that fails THROWS (StoreError with the database's error code): "no
 * row" must never be confused with "could not look". Nothing here logs an
 * address, a text or a body: a failure logs the table and the error code.
 * Never writes leads.status or leads.crm_pushed_at.
 */

const BUCKET = 'ad-packs';
const UUID = /^[0-9a-f-]{36}$/i;
/** `<owner uuid>/<pack uuid>/v<n>/<file>` or `<owner uuid>/uploads/...`: nothing else is read. */
const OWN_PATH = /^[0-9a-f-]{36}\/[0-9a-z-]{1,40}\/[0-9a-z._-]{1,80}(\/[0-9a-z._-]{1,80})?$/i;

type Admin = ReturnType<typeof createAdminClient>;
const admin = (): Admin => createAdminClient();

function fail(table: string, error: { code?: string } | null): never {
  const code = error?.code ?? 'error';
  console.error(`[ad-packs] ${table} failed:`, code);
  throw new StoreError(code);
}

export async function readRenderSettings(): Promise<RenderSettings> {
  try {
    const { data, error } = await admin().from('billing_settings').select('key, value').in('key', Object.values(RENDER_SETTING_KEYS));
    if (error) console.error('[ad-packs] render settings read failed, using defaults:', error.code ?? 'error');
    return parseRenderSettings((data ?? []) as { key: string; value: unknown }[]);
  } catch {
    return parseRenderSettings([]);
  }
}

/** Raw pence per sandbox CPU-second: the unit_costs row, or its seed when the table cannot be read. */
export async function readSandboxCpuSecondPence(): Promise<number> {
  try {
    const priced = priceFor(await getUnitCostTable(), 'vercel', 'sandbox_cpu_second', 1);
    if (priced.found && Number.isFinite(priced.unitCostPence) && priced.unitCostPence > 0) return priced.unitCostPence;
  } catch {
    // the seed stands
  }
  return UNIT_COST_SEED.find((r) => r.provider === 'vercel' && r.unit === 'sandbox_cpu_second')?.unitCostPence ?? 0.00280889;
}

export function createLiveRenderStore(): RenderStore {
  return {
    async enqueue(packId, version, voiceKey) {
      if (!UUID.test(packId)) throw new StoreError('invalid_pack');
      const { data, error } = await admin()
        .from('ad_pack_renders')
        .upsert({ pack_id: packId, version, voice_key: voiceKey }, { onConflict: 'pack_id,version', ignoreDuplicates: true })
        .select(RENDER_COLUMNS);
      if (error) fail('ad_pack_renders enqueue', error);
      const inserted = (data ?? [])[0];
      if (inserted) return { inserted: true, row: toRenderRow(inserted as Record<string, unknown>) };
      const { data: existing, error: readError } = await admin().from('ad_pack_renders').select(RENDER_COLUMNS).eq('pack_id', packId).eq('version', version).maybeSingle();
      if (readError) fail('ad_pack_renders read', readError);
      if (!existing) throw new StoreError('enqueue_lost');
      return { inserted: false, row: toRenderRow(existing as Record<string, unknown>) };
    },

    async listQueued(limit) {
      const { data, error } = await admin().from('ad_pack_renders').select(RENDER_COLUMNS).eq('state', 'queued').order('created_at', { ascending: true }).limit(limit);
      if (error) fail('ad_pack_renders read', error);
      return ((data ?? []) as Record<string, unknown>[]).map(toRenderRow);
    },

    async listExpired(nowIso, limit) {
      const { data, error } = await admin().from('ad_pack_renders').select(RENDER_COLUMNS).eq('state', 'running').lt('lease_until', nowIso).order('created_at', { ascending: true }).limit(limit);
      if (error) fail('ad_pack_renders read', error);
      return ((data ?? []) as Record<string, unknown>[]).map(toRenderRow);
    },

    async counts() {
      const out = Object.fromEntries(RENDER_STATES.map((s) => [s, 0])) as RenderCounts;
      for (const state of RENDER_STATES) {
        const { count, error } = await admin().from('ad_pack_renders').select('id', { count: 'exact', head: true }).eq('state', state);
        if (error) fail('ad_pack_renders count', error);
        out[state] = count ?? 0;
      }
      return out;
    },

    async claim(id, nowIso, leaseUntilIso) {
      if (!UUID.test(id)) return null;
      // attempts + 1 cannot be written in one statement, so the update is conditional on the attempts just read.
      const { data: cur, error: readError } = await admin().from('ad_pack_renders').select('attempts').eq('id', id).eq('state', 'queued').maybeSingle();
      if (readError) fail('ad_pack_renders claim', readError);
      if (!cur) return null;
      const { data, error } = await admin()
        .from('ad_pack_renders')
        .update({ state: 'running', lease_until: leaseUntilIso, attempts: Number((cur as { attempts: number }).attempts) + 1, started_at: nowIso, error_code: null, updated_at: nowIso })
        .eq('id', id)
        .eq('state', 'queued')
        .eq('attempts', Number((cur as { attempts: number }).attempts))
        .select(RENDER_COLUMNS)
        .maybeSingle();
      if (error) fail('ad_pack_renders claim', error);
      return data ? toRenderRow(data as Record<string, unknown>) : null;
    },

    async release(id, claimedAttempts, patch) {
      const { data, error } = await admin()
        .from('ad_pack_renders')
        .update({
          state: patch.state,
          error_code: patch.errorCode.slice(0, 60),
          cost_pence: patch.costPence,
          ...(patch.sandboxId ? { sandbox_id: patch.sandboxId } : {}),
          finished_at: patch.finishedAt,
          lease_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('state', 'running')
        .eq('attempts', claimedAttempts)
        .select('id');
      if (error) fail('ad_pack_renders release', error);
      return (data ?? []).length > 0;
    },

    async complete(id, claimedAttempts, patch) {
      const { data, error } = await admin()
        .from('ad_pack_renders')
        .update({
          state: 'done',
          error_code: null,
          cost_pence: patch.costPence,
          ...(patch.sandboxId ? { sandbox_id: patch.sandboxId } : {}),
          files: patch.files,
          finished_at: patch.finishedAt,
          lease_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('state', 'running')
        .eq('attempts', claimedAttempts)
        .select('id');
      if (error) fail('ad_pack_renders complete', error);
      return (data ?? []).length > 0;
    },

    async expire(id, attempts, nowIso, maxAttempts) {
      const exhausted = attempts >= maxAttempts;
      const { data, error } = await admin()
        .from('ad_pack_renders')
        .update({
          state: exhausted ? 'failed' : 'queued',
          error_code: 'timeout',
          lease_until: null,
          finished_at: exhausted ? nowIso : null,
          updated_at: nowIso,
        })
        .eq('id', id)
        .eq('state', 'running')
        .eq('attempts', attempts)
        .lt('lease_until', nowIso)
        .select('id');
      if (error) fail('ad_pack_renders expire', error);
      if ((data ?? []).length === 0) return null;
      return exhausted ? 'failed' : 'requeued';
    },

    async getPack(packId) {
      if (!UUID.test(packId)) return null;
      const { data, error } = await admin().from('ad_packs').select(PACK_COLUMNS).eq('id', packId).maybeSingle();
      if (error) fail('ad_packs read', error);
      return data ? toPackRow(data as Record<string, unknown>) : null;
    },

    async getRender(packId, version) {
      if (!UUID.test(packId)) return null;
      const { data, error } = await admin().from('ad_pack_renders').select(RENDER_COLUMNS).eq('pack_id', packId).eq('version', version).maybeSingle();
      if (error) fail('ad_pack_renders read', error);
      return data ? toRenderRow(data as Record<string, unknown>) : null;
    },

    async requeueRender({ packId, version, voiceKey }) {
      if (!UUID.test(packId)) throw new StoreError('invalid_pack');
      const nowIso = new Date().toISOString();
      // An existing row is reset in place, but only while no worker has it (conditional on state <> running).
      const { data, error } = await admin()
        .from('ad_pack_renders')
        .update({ state: 'queued', attempts: 0, error_code: null, files: null, voice_key: voiceKey, lease_until: null, started_at: null, finished_at: null, updated_at: nowIso })
        .eq('pack_id', packId)
        .eq('version', version)
        .neq('state', 'running')
        .select(RENDER_COLUMNS);
      if (error) fail('ad_pack_renders requeue', error);
      const updated = (data ?? [])[0];
      if (updated) return toRenderRow(updated as Record<string, unknown>);
      const { data: existing, error: readError } = await admin().from('ad_pack_renders').select('id').eq('pack_id', packId).eq('version', version).maybeSingle();
      if (readError) fail('ad_pack_renders read', readError);
      if (existing) return null; // running: left alone
      const { data: inserted, error: insertError } = await admin().from('ad_pack_renders').insert({ pack_id: packId, version, voice_key: voiceKey }).select(RENDER_COLUMNS).maybeSingle();
      if (insertError) fail('ad_pack_renders insert', insertError);
      return inserted ? toRenderRow(inserted as Record<string, unknown>) : null;
    },

    async setAdFiles(ownerId, packAdId, files) {
      if (!UUID.test(ownerId) || !UUID.test(packAdId)) return false;
      const { data, error } = await admin().from('ad_pack_ads').update({ files }).eq('id', packAdId).eq('owner_id', ownerId).select('id');
      if (error) fail('ad_pack_ads files', error);
      return (data ?? []).length > 0;
    },
  };
}

/** The private bucket as the worker uses it: read one stored file (null when absent) and write one (never throws). */
export function createLiveStorage(): StorageLike {
  return {
    async get(path) {
      if (!OWN_PATH.test(path) || path.includes('..')) return null;
      try {
        const { data, error } = await admin().storage.from(BUCKET).download(path);
        if (error || !data) return null;
        return new Uint8Array(await data.arrayBuffer());
      } catch {
        return null;
      }
    },
    put: uploadFile,
  };
}
