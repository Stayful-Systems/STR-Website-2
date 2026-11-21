'use server';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin';
import { ownerIdOrNull } from '@/lib/leads/scope';
import { isAdminEmail } from '@/lib/admin';
import { recordActivity } from '@/lib/activity/log';
import { readAdPacksEnabled } from '@/lib/ad-packs/eligibility-server';
import { listPackForOwner } from '@/lib/ad-packs/generate-server';
import { createGoogleSheets } from '@/lib/ad-sheets/google';
import { runAdSheetImport } from '@/lib/ad-sheets/import-server';
import { checkSheetOp, connectSheetOp, disconnectSheetOp, readNowOp, type ConnectDeps, type ConnectStore, type SheetLinkRecord, type SheetState, type SheetStatus } from '@/lib/ad-sheets/connect';
import { sheetShotFile } from '@/lib/ad-sheets/messages';
import { SHEET_SETTING_KEYS, parseSheetSettings } from '@/lib/ad-sheets/settings';
import { ADS_PATH } from './view';

/**
 * Batch 35 (Phase 7): the "Switch to lead forms" card's server actions. Each is
 * a few lines over src/lib/ad-sheets/connect.ts, which holds (and tests) the
 * rules: owner only, both switches on (an admin previewing skips them), an
 * approved pack, one sheet per account, nothing about a sheet sent back.
 *
 * The real store reads and writes `ad_sheet_links` with the service role (RLS
 * on, no policy). It writes only that table: never `leads`, never
 * `ad_sheet_rows`. A failed query logs the table and the database's error code
 * and nothing else.
 */

const db = () => createAdminClient();
const LINK_COLUMNS = 'id, owner_id, spreadsheet_id, tab_gid, tab_title, state, activated_at, last_error_code';
const GUIDE_DIR = 'public/ad-packs/guide';

type LinkRow = { id: string; owner_id: string; spreadsheet_id: string; tab_gid: string | null; tab_title: string | null; state: SheetLinkRecord['state']; activated_at: string | null; last_error_code: string | null };

const toRecord = (r: LinkRow): SheetLinkRecord => ({
  id: r.id,
  ownerId: r.owner_id,
  spreadsheetId: r.spreadsheet_id,
  tabGid: r.tab_gid,
  tabTitle: r.tab_title,
  state: r.state,
  activatedAt: r.activated_at,
  lastErrorCode: r.last_error_code,
});

function logFail(table: string, code: string | undefined): void {
  console.error(`[ad-sheets] ${table} failed:`, code ?? 'error');
}

function liveStore(): ConnectStore {
  return {
    async getByOwner(ownerId) {
      if (!hasServiceRole()) return null;
      const { data, error } = await db().from('ad_sheet_links').select(LINK_COLUMNS).eq('owner_id', ownerId).maybeSingle();
      if (error) {
        logFail('ad_sheet_links', error.code);
        return null;
      }
      return data ? toRecord(data as LinkRow) : null;
    },

    async ownerOfSpreadsheet(spreadsheetId) {
      if (!hasServiceRole()) return null;
      const { data, error } = await db().from('ad_sheet_links').select('owner_id').eq('spreadsheet_id', spreadsheetId).maybeSingle();
      if (error) {
        logFail('ad_sheet_links', error.code);
        return null;
      }
      return (data as { owner_id: string } | null)?.owner_id ?? null;
    },

    async save(ownerId, row) {
      if (!hasServiceRole()) return { ok: false, code: 'db' };
      // One row per owner (owner_id is unique): a reconnect starts the import's progress again (rows already read are
      // skipped by their key) and keeps the lifetime counts. The sheet's own unique constraint is the second guard.
      const { data, error } = await db()
        .from('ad_sheet_links')
        .upsert(
          {
            owner_id: ownerId,
            spreadsheet_id: row.spreadsheetId,
            tab_gid: row.tabGid,
            tab_title: row.tabTitle,
            state: 'waiting_test_row',
            header_hash: row.headerHash,
            header_map: row.headerMap,
            columns_changed_at: null,
            last_row_read: 0,
            last_row_at: null,
            last_import_at: null,
            last_error_code: null,
            quiet_email_sent_at: null,
            connected_at: row.connectedAt,
            activated_at: null,
            updated_at: row.connectedAt,
          },
          { onConflict: 'owner_id' },
        )
        .select(LINK_COLUMNS)
        .single();
      if (error || !data) {
        logFail('ad_sheet_links', error?.code);
        return { ok: false, code: error?.code === '23505' ? 'taken' : 'db' };
      }
      return { ok: true, link: toRecord(data as LinkRow) };
    },

    async disconnect(ownerId) {
      if (!hasServiceRole()) return false;
      const { error } = await db().from('ad_sheet_links').update({ state: 'disconnected', updated_at: new Date().toISOString() }).eq('owner_id', ownerId);
      if (error) {
        logFail('ad_sheet_links', error.code);
        return false;
      }
      return true;
    },
  };
}

async function liveDeps(): Promise<ConnectDeps> {
  const google = createGoogleSheets();
  return {
    async session() {
      const supabase = await createSupabaseServerClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { ok: false, reason: 'signed_out' };
      const ownerId = await ownerIdOrNull(user);
      if (!ownerId) return { ok: false, reason: 'member' };
      return { ok: true, ownerId, email: user.email ?? null, admin: isAdminEmail(user.email) };
    },
    async switches() {
      const adPacksEnabled = await readAdPacksEnabled();
      if (!hasServiceRole()) return { adPacksEnabled, sheetsEnabled: false };
      const { data, error } = await db().from('billing_settings').select('key, value').in('key', Object.values(SHEET_SETTING_KEYS));
      if (error) {
        logFail('billing_settings', error.code);
        return { adPacksEnabled, sheetsEnabled: false };
      }
      return { adPacksEnabled, sheetsEnabled: parseSheetSettings((data ?? []) as { key: string; value: unknown }[]).enabled };
    },
    async packApproved(ownerId) {
      const view = await listPackForOwner(ownerId);
      return view?.pack.status === 'approved';
    },
    store: liveStore(),
    google: { sheetMeta: google.sheetMeta, readRange: google.readRange, serviceAccountEmail: google.serviceAccountEmail },
    async importNow(linkId) {
      await runAdSheetImport({ linkId }); // never throws; the link is the owner's own (it came from their own row)
    },
    record: (ownerId, kind, opts) => recordActivity(ownerId, kind, { extras: opts.extras, dedupeKey: opts.dedupeKey }),
    now: () => new Date(),
  };
}

/** Which of the six step screenshots exist (public/ad-packs/guide/sheet-<n>.png); a missing one shows a plain box. */
function availableSheetShots(root: string = process.cwd()): number[] {
  try {
    return [1, 2, 3, 4, 5, 6].filter((n) => existsSync(join(root, GUIDE_DIR, sheetShotFile(n))));
  } catch {
    return [];
  }
}

const text = (v: FormDataEntryValue | null): string | null => (typeof v === 'string' ? v : null);

/** The card's first look: the owner's link as it stands, and which screenshots exist. Read only. */
export async function loadSheetCardAction(): Promise<{ status: SheetStatus; shots: number[] }> {
  const status = await checkSheetOp(await liveDeps());
  return { status, shots: status.available ? availableSheetShots() : [] };
}

/** Asked every few seconds while step 5 waits. Read only; safe fields only. Logs `ad_sheet_connected` once when it sees the link active. */
export async function pollSheetAction(): Promise<SheetStatus> {
  return checkSheetOp(await liveDeps(), { watching: true });
}

/** Step 4: the pasted link is checked, then the owner's link is saved as waiting for a test row. */
export async function connectSheetAction(_prev: SheetState, formData: FormData): Promise<SheetState> {
  const out = await connectSheetOp(await liveDeps(), { link: text(formData.get('link')) });
  revalidatePath(ADS_PATH);
  return out;
}

/** Step 5: "Check now": reads the owner's own sheet straight away instead of waiting for the hourly read. */
export async function readSheetNowAction(): Promise<SheetState> {
  const out = await readNowOp(await liveDeps());
  revalidatePath(ADS_PATH);
  return out;
}

/** Back to website mode. The rows already read, and the leads they made, stay. */
export async function disconnectSheetAction(): Promise<SheetState> {
  const out = await disconnectSheetOp(await liveDeps());
  revalidatePath(ADS_PATH);
  return out;
}
