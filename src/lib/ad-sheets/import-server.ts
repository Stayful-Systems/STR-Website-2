import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { supabaseAttributionStore } from '../ad-packs/attribution-server';
import { enqueueLeadDbPush } from '../leaddb/deliver.ts';
import { captureLead, findSameLandlordLead } from '../leads/store';
import { createGoogleSheets } from './google.ts';
import { runImport } from './import.ts';
import type { ImportLink, ImportResult, ImportStore, LinkPatch, SheetClient } from './import.ts';
import { notifySheetLead } from './notify-server';

/**
 * Batch 35: the real database behind the sheet import. Service role only:
 * `ad_sheet_links` and `ad_sheet_rows` have RLS on with no policy.
 *
 * Reads: ad_sheet_links, ad_packs, ad_pack_ads (the owner's, and the OWNER ID
 * ONLY of another operator's code), ad_pack_lead_links, websites, funnels,
 * leads, billing_settings. Writes: ad_sheet_rows (insert first, on conflict do
 * nothing; the owner is always the link's), ad_sheet_links (progress), leads
 * (only through `captureLead`: a new lead is `new`), ad_pack_lead_links.
 * Nothing here writes `leads.status` or `leads.crm_pushed_at` (they mean "went
 * to your CRM"). Neither new table is in ACCESS_COLUMNS.
 *
 * Nothing here logs a lead: a failure logs a table name and the database's
 * error code at most.
 */

const db = () => createAdminClient();

function fail(table: string, code: string | undefined): never {
  console.error(`[ad-sheets] ${table} failed:`, code ?? 'error');
  throw new Error('db');
}

const LINK_COLUMNS = 'id, owner_id, spreadsheet_id, tab_gid, tab_title, state, header_hash, last_row_read, rows_imported, untagged_count';
const MAX_LINKS = 100;
const KEY_CHUNK = 150;

const PATCH_COLUMNS: Record<keyof LinkPatch, string> = {
  state: 'state',
  headerHash: 'header_hash',
  headerMap: 'header_map',
  columnsChangedAt: 'columns_changed_at',
  lastRowRead: 'last_row_read',
  rowsImported: 'rows_imported',
  untaggedCount: 'untagged_count',
  lastRowAt: 'last_row_at',
  lastImportAt: 'last_import_at',
  lastErrorCode: 'last_error_code',
};

/** The sends that follow a new lead run beside the import; the caller waits for them at the very end. */
export function supabaseImportStore(pending: Promise<unknown>[] = []): ImportStore {
  const attribution = supabaseAttributionStore();
  return {
    async links({ linkId }) {
      let q = db().from('ad_sheet_links').select(LINK_COLUMNS).in('state', ['active', 'waiting_test_row']).order('last_import_at', { ascending: true, nullsFirst: true }).limit(MAX_LINKS);
      if (linkId) q = q.eq('id', linkId);
      const { data, error } = await q;
      if (error) fail('ad_sheet_links', error.code);
      return ((data ?? []) as {
        id: string; owner_id: string; spreadsheet_id: string; tab_gid: string | null; tab_title: string | null; state: ImportLink['state'];
        header_hash: string | null; last_row_read: number; rows_imported: number; untagged_count: number;
      }[]).map((r) => ({
        id: r.id,
        ownerId: r.owner_id,
        spreadsheetId: r.spreadsheet_id,
        tabGid: r.tab_gid,
        tabTitle: r.tab_title,
        state: r.state,
        headerHash: r.header_hash,
        lastRowRead: r.last_row_read,
        rowsImported: r.rows_imported,
        untaggedCount: r.untagged_count,
      }));
    },

    async packContext(ownerId) {
      const [pack, packAds, knownMetaAdIds] = await Promise.all([attribution.pack(ownerId), attribution.packAds(ownerId, null), attribution.knownMetaAdIds(ownerId)]);
      return { operatorCode: pack?.operatorCode ?? null, packAds, knownMetaAdIds };
    },

    async ownerOfCode(code) {
      // The owner id only: nothing else of another operator's ad leaves this function.
      const { data, error } = await db().from('ad_pack_ads').select('owner_id').eq('code', code).limit(1).maybeSingle();
      if (error) fail('ad_pack_ads', error.code);
      return (data as { owner_id: string } | null)?.owner_id ?? null;
    },

    async dedupeDays() {
      const { data, error } = await db().from('billing_settings').select('value').eq('key', 'ad_sheet_dedupe_days').maybeSingle();
      if (error) fail('billing_settings', error.code);
      const n = Number((data as { value: unknown } | null)?.value);
      return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.floor(n) : 30;
    },

    async websiteFunnelId(ownerId) {
      const { data, error } = await db().from('websites').select('funnel_id').eq('user_id', ownerId).maybeSingle();
      if (error) fail('websites', error.code);
      return (data as { funnel_id: string } | null)?.funnel_id ?? null;
    },

    async insertRow(row) {
      const { data, error } = await db()
        .from('ad_sheet_rows')
        .upsert(
          { link_id: row.linkId, owner_id: row.ownerId, row_key: row.rowKey, row_number: row.rowNumber, state: row.state, missing: row.missing, answers: row.answers },
          { onConflict: 'link_id,row_key', ignoreDuplicates: true },
        )
        .select('id');
      if (error) fail('ad_sheet_rows', error.code);
      const rows = (data ?? []) as { id: string }[];
      return rows.length > 0 ? rows[0].id : null;
    },

    async existingRowKeys(linkId, keys) {
      const found = new Set<string>();
      for (let i = 0; i < keys.length; i += KEY_CHUNK) {
        const { data, error } = await db().from('ad_sheet_rows').select('row_key').eq('link_id', linkId).in('row_key', keys.slice(i, i + KEY_CHUNK));
        if (error) fail('ad_sheet_rows', error.code);
        for (const r of (data ?? []) as { row_key: string }[]) found.add(r.row_key);
      }
      return found;
    },

    async updateRow(rowId, patch) {
      const { error } = await db().from('ad_sheet_rows').update({ state: patch.state, lead_id: patch.leadId }).eq('id', rowId);
      if (error) fail('ad_sheet_rows', error.code);
    },

    async deleteRow(rowId) {
      const { error } = await db().from('ad_sheet_rows').delete().eq('id', rowId);
      if (error) fail('ad_sheet_rows', error.code);
    },

    async findSameLandlord(ownerId, cand, days) {
      return findSameLandlordLead(ownerId, cand, days);
    },

    async captureLead(input) {
      const r = await captureLead({
        userId: input.ownerId,
        funnelId: input.funnelId,
        contact: { name: input.name, email: input.email, phone: input.phone, consentAt: null },
        property: { address: null, postcode: input.postcode, bedrooms: null },
        status: 'new',
      });
      return r ? { id: r.id, reused: r.reused } : null;
    },

    async hasPackLink(leadId) {
      const { data, error } = await db().from('ad_pack_lead_links').select('lead_id').eq('lead_id', leadId).maybeSingle();
      if (error) fail('ad_pack_lead_links', error.code);
      return Boolean(data);
    },

    async upsertPackLink(row) {
      await attribution.upsertLink(row);
    },

    async activateLink(linkId, atIso) {
      const { error } = await db()
        .from('ad_sheet_links')
        .update({ state: 'active', activated_at: atIso, updated_at: atIso })
        .eq('id', linkId)
        .eq('state', 'waiting_test_row');
      if (error) fail('ad_sheet_links', error.code);
    },

    async saveLink(linkId, patch) {
      const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const k of Object.keys(patch) as (keyof LinkPatch)[]) {
        if (patch[k] !== undefined) row[PATCH_COLUMNS[k]] = patch[k];
      }
      // Batch 35 phase 6: a new row ends the quiet spell, so the quiet email may go again after another quiet period.
      if (patch.lastRowAt !== undefined) row.quiet_email_sent_at = null;
      // A link disconnected while the run was going stays disconnected.
      const { error } = await db().from('ad_sheet_links').update(row).eq('id', linkId).neq('state', 'disconnected');
      if (error) fail('ad_sheet_links', error.code);
    },

    pushToLeadDb(leadId) {
      const p = enqueueLeadDbPush(leadId).catch(() => {});
      pending.push(p);
      return p;
    },

    notifyNewLead(leadId) {
      const p = notifySheetLead(leadId).catch(() => {});
      pending.push(p);
      return p;
    },
  };
}

/** The read-only Google client (the service account's key and email come from the environment). */
export function googleImportClient(): SheetClient {
  const g = createGoogleSheets();
  return { sheetMeta: g.sheetMeta, readRange: g.readRange };
}

/**
 * Runs the import with the real store and the real Google client. Used by the
 * cron route (phase 6) and the admin buttons (phase 10). `dry` lists per-link
 * counts and writes and sends nothing. Never throws: returns a result with a code.
 */
export async function runAdSheetImport(opts: { dry?: boolean; linkId?: string } = {}): Promise<ImportResult> {
  const dry = opts.dry === true;
  if (!hasServiceRole()) return { ok: false, code: 'error', dry, links: [] };
  const pending: Promise<unknown>[] = [];
  try {
    const result = await runImport(opts, { store: supabaseImportStore(pending), client: googleImportClient() });
    // The lead database pushes and the new-lead emails ran beside the import; let them land before the request ends.
    await Promise.allSettled(pending);
    return result;
  } catch {
    console.error('[ad-sheets] import failed');
    await Promise.allSettled(pending);
    return { ok: false, code: 'error', dry, links: [] };
  }
}
