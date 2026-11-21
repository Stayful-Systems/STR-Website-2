import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { createSupabaseServerClient } from '../supabase/server';
import { parseSiteSettings } from '../websites/store-server';
import { adSheetAdminRunner, type AdSheetAdminRunner } from './admin-run.ts';
import { buildAdSheetsAdminView, type AdSheetLinkInput, type AdSheetOwnerInput, type AdSheetsAdminView } from './admin-view.ts';
import { runAdSheetImport } from './import-server';
import { parseSheetSettings, SHEET_SETTING_KEYS } from './settings.ts';

/**
 * Batch 35 (Phase 10): what /admin/ad-sheets shows and does. Service role only.
 *
 * Reads: ad_sheet_links (state, counts, dates and the short error code ONLY:
 * never the sheet's id or title), profiles (the owner's sign-in email),
 * websites.settings (the owner's company name) and billing_settings (the
 * switch and the guide date). It never reads the rows table at all and never
 * reads a lead: no cell, name, email of a landlord, phone, postcode or
 * response text can reach this page.
 *
 * Writes: ad_sheet_links.state (Disconnect, by link id) and the one
 * billing_settings key ad_sheet_guide_checked_at. The import itself is
 * runAdSheetImport. Logs carry a table name and an error code, never a lead.
 */

export type AdSheetsAdminData = { available: boolean; readError: string | null; view: AdSheetsAdminView };

const MAX_LINKS = 500;
const LINK_COLUMNS = 'id, owner_id, state, last_row_read, last_import_at, last_error_code, untagged_count, rows_imported, columns_changed_at';

function emptyView(now: Date): AdSheetsAdminView {
  return buildAdSheetsAdminView({ links: [], owners: new Map(), switchOn: false, guideCheckedAt: null, now });
}

export async function loadAdSheetsAdmin(now: Date = new Date()): Promise<AdSheetsAdminData> {
  if (!hasServiceRole()) return { available: false, readError: null, view: emptyView(now) };
  const db = createAdminClient();
  const keys = Object.values(SHEET_SETTING_KEYS);
  const [linksRes, settingsRes] = await Promise.all([
    db.from('ad_sheet_links').select(LINK_COLUMNS).order('connected_at', { ascending: false }).limit(MAX_LINKS),
    db.from('billing_settings').select('key, value').in('key', keys),
  ]);
  if (linksRes.error) {
    console.error('[ad-sheets] admin links read failed:', linksRes.error.code ?? 'error');
    return { available: true, readError: 'Could not read the sheets just now.', view: emptyView(now) };
  }
  let readError: string | null = null;
  if (settingsRes.error) {
    console.error('[ad-sheets] admin settings read failed:', settingsRes.error.code ?? 'error');
    readError = 'Some details could not be read just now.';
  }
  const settings = parseSheetSettings((settingsRes.data ?? []) as { key: string; value: unknown }[]);

  const links = ((linksRes.data ?? []) as unknown as {
    id: string; owner_id: string; state: string; last_row_read: number; last_import_at: string | null; last_error_code: string | null;
    untagged_count: number; rows_imported: number; columns_changed_at: string | null;
  }[]).map(
    (r): AdSheetLinkInput => ({
      id: r.id,
      ownerId: r.owner_id,
      state: r.state,
      lastRowRead: r.last_row_read,
      lastImportAt: r.last_import_at,
      lastErrorCode: r.last_error_code,
      untaggedCount: r.untagged_count,
      rowsImported: r.rows_imported,
      columnsChangedAt: r.columns_changed_at,
    }),
  );

  const owners = new Map<string, AdSheetOwnerInput>();
  const ownerIds = [...new Set(links.map((l) => l.ownerId))];
  for (const id of ownerIds) owners.set(id, { company: null, email: null });
  if (ownerIds.length > 0) {
    const [profiles, sites] = await Promise.all([
      db.from('profiles').select('id, email').in('id', ownerIds),
      db.from('websites').select('user_id, settings').in('user_id', ownerIds),
    ]);
    for (const [name, res] of [['profiles', profiles], ['websites', sites]] as const) {
      if (res.error) {
        console.error(`[ad-sheets] admin ${name} read failed:`, res.error.code ?? 'error');
        readError = 'Some details could not be read just now.';
      }
    }
    for (const r of (profiles.data ?? []) as { id: string; email: string | null }[]) {
      const o = owners.get(r.id);
      if (o) o.email = r.email ?? null;
    }
    for (const r of (sites.data ?? []) as { user_id: string; settings: unknown }[]) {
      const o = owners.get(r.user_id);
      if (o) o.company = parseSiteSettings(r.settings).companyName || null;
    }
  }

  return { available: true, readError, view: buildAdSheetsAdminView({ links, owners, switchOn: settings.enabled, guideCheckedAt: settings.guideCheckedAt, now }) };
}

export function liveAdSheetAdminRunner(): AdSheetAdminRunner {
  return adSheetAdminRunner({
    currentUser: async () => {
      const supabase = await createSupabaseServerClient();
      const { data } = await supabase.auth.getUser();
      return data.user ?? null;
    },
    runImport: (opts) => runAdSheetImport(opts),
    async readLink(linkId) {
      if (!hasServiceRole()) return null;
      const { data, error } = await createAdminClient().from('ad_sheet_links').select('id, state').eq('id', linkId).maybeSingle();
      if (error) {
        console.error('[ad-sheets] admin link read failed:', error.code ?? 'error');
        return null;
      }
      return (data as { id: string; state: string } | null) ?? null;
    },
    async disconnect(linkId) {
      if (!hasServiceRole()) return false;
      const { data, error } = await createAdminClient()
        .from('ad_sheet_links')
        .update({ state: 'disconnected', updated_at: new Date().toISOString() })
        .eq('id', linkId)
        .neq('state', 'disconnected')
        .select('id');
      if (error) {
        console.error('[ad-sheets] admin disconnect failed:', error.code ?? 'error');
        return false;
      }
      return (data ?? []).length > 0;
    },
    async markGuideChecked(iso) {
      const { error } = await createAdminClient()
        .from('billing_settings')
        .upsert({ key: SHEET_SETTING_KEYS.guideCheckedAt, value: iso, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw new Error('db');
    },
    audit: (line) => console.info(`[admin] ${line}`),
  });
}
