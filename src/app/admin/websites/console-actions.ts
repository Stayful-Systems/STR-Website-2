'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { updateBillingSetting } from '@/lib/credit/unit-costs';
import { liveRequestsEngine } from '@/lib/websites/edit-requests-store';
import { isRequestStatus } from '@/lib/websites/edit-requests';
import { consoleRunner, isConsoleKind, loadConsole, realConsoleSource, type ConsoleDeps, type ConsoleResult } from '@/lib/websites/grace-admin';
import { GRACE_KEYS, checkGraceSetting } from '@/lib/websites/grace-settings';
import { deleteSiteData, exportSiteData, graceForSite, readGraceSettings, switchOffSite, switchOnSite } from '@/lib/websites/grace-server';
import { setStatus } from '@/lib/websites/store-server';
import { ukDayOf } from '@/lib/websites/grace-rules';

/**
 * Batch 36 (Phase 8): /admin/websites' actions.
 *
 *   dryRunConsoleAction / runConsoleAction      pause · resume · switch_off · switch_on · export · delete
 *   dryRunGraceSettingAction / saveGraceSettingAction   the three grace settings
 *   setRequestStatusAction / requestScreenshotAction    change requests
 *
 * Every action checks the admin FIRST (requireAdmin), before it reads any
 * argument. A dry run only reads: the planner (grace-admin.ts) and the engines'
 * own dry-run flags make no write, send no email and claim no slot
 * (grace-admin.test.ts pins it with a spy). Run refuses whatever the plan
 * refuses, so Delete on a site that is not switched off is refused here and
 * not only hidden in the screen. The site's owner is read from the site on the
 * server: no action takes a user id from the form.
 *
 * The console's audit trail is one line per run: the admin's id, the action,
 * a short site id and a code. Never an address, an email body or a request text.
 */

async function requireAdmin(): Promise<{ id: string }> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user || !isAdminEmail(data.user.email)) throw new Error('Not allowed');
  return { id: data.user.id };
}

const FAIL: ConsoleResult = { ok: false, message: 'Not allowed, or something went wrong. Please try again.', lines: [], emails: [], canRun: false };
const refresh = () => revalidatePath('/admin/websites');

function runner(adminId: string) {
  const source = realConsoleSource();
  const deps: ConsoleDeps = {
    loadSite: async (id) => (await loadConsole(source, async (w) => graceForSite(w), { ids: [id] }))[0] ?? null,
    settings: readGraceSettings,
    today: () => ukDayOf(new Date()),
    setStatus: async (ownerId, to) => {
      const r = await setStatus(ownerId, to);
      return { ok: r.ok, conflict: !r.ok && r.reason === 'conflict' };
    },
    switchOff: async (id, o) => {
      const r = await switchOffSite(id, { by: 'admin', dryRun: o.dryRun });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },
    switchOn: async (ownerId) => {
      const r = await switchOnSite(ownerId);
      return r.ok ? { ok: true } : { ok: false, messages: r.messages };
    },
    deleteData: async (id, o) => {
      const r = await deleteSiteData(id, { dryRun: o.dryRun });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },
    exportData: (id) => exportSiteData(id),
    audit: (line) => console.info(`[admin] website console: ${adminId} ${line}`),
  };
  return consoleRunner(deps);
}

export async function dryRunConsoleAction(kind: string, websiteId: string): Promise<ConsoleResult> {
  try {
    const admin = await requireAdmin();
    if (!isConsoleKind(kind)) return { ...FAIL, message: 'Unknown action.' };
    return await runner(admin.id).dryRun(kind, String(websiteId ?? ''));
  } catch {
    return FAIL;
  }
}

export async function runConsoleAction(kind: string, websiteId: string): Promise<ConsoleResult> {
  try {
    const admin = await requireAdmin();
    if (!isConsoleKind(kind)) return { ...FAIL, message: 'Unknown action.' };
    const result = await runner(admin.id).run(kind, String(websiteId ?? ''));
    refresh();
    return result;
  } catch {
    return FAIL;
  }
}

// ── The three grace settings ──

export interface SettingResult {
  ok: boolean;
  message: string;
  canRun: boolean;
}

/** The field names the screen may send, mapped to their keys here; any other is refused. */
function settingKey(field: unknown): string | null {
  return typeof field === 'string' && Object.prototype.hasOwnProperty.call(GRACE_KEYS, field) ? GRACE_KEYS[field as keyof typeof GRACE_KEYS] : null;
}

const SETTING_FAIL: SettingResult = { ok: false, message: 'Not allowed, or something went wrong. Please try again.', canRun: false };

const SETTING_HELP: Record<string, string> = {
  website_abandon_days: 'Enter a whole number of days from 1 to 3650.',
  website_warning_days: 'Enter up to five different whole numbers of days from 1 to 365, like 30,14,3.',
  website_delete_after_days: 'Enter a whole number of days from 1 to 3650.',
};

export async function dryRunGraceSettingAction(field: string, value: string): Promise<SettingResult> {
  try {
    await requireAdmin();
    const key = settingKey(field);
    if (!key) return { ...SETTING_FAIL, message: 'Unknown setting.' };
    const checked = checkGraceSetting(key, value);
    if (!checked) return { ok: false, canRun: false, message: `Not allowed. ${SETTING_HELP[key]}` };
    return { ok: true, canRun: true, message: `Dry run: ${key} would be set to ${String(checked.value)}. Nothing was changed.` };
  } catch {
    return SETTING_FAIL;
  }
}

export async function saveGraceSettingAction(field: string, value: string): Promise<SettingResult> {
  try {
    const admin = await requireAdmin();
    const key = settingKey(field);
    if (!key) return { ...SETTING_FAIL, message: 'Unknown setting.' };
    const checked = checkGraceSetting(key, value);
    if (!checked) return { ok: false, canRun: false, message: `Not saved. ${SETTING_HELP[key]}` };
    await updateBillingSetting(checked.key, checked.value);
    console.info(`[admin] website console: ${admin.id} set ${checked.key}`);
    refresh();
    return { ok: true, canRun: false, message: `Saved. ${checked.key} is now ${String(checked.value)}.` };
  } catch {
    return SETTING_FAIL;
  }
}

// ── Change requests ──

export interface RequestActionResult {
  ok: boolean;
  message: string;
  /** The operator's done / declined email: sent, already sent, failed or none. */
  email?: string;
}

const UUID = /^[0-9a-f-]{36}$/i;
const REQUEST_FAIL: RequestActionResult = { ok: false, message: 'Not allowed, or something went wrong. Please try again.' };

/** Move a request on and keep the admin's note; the engine sends the operator's closed email once. */
export async function setRequestStatusAction(requestId: string, status: string, notes: string): Promise<RequestActionResult> {
  try {
    const admin = await requireAdmin();
    const id = String(requestId ?? '');
    if (!UUID.test(id) || !isRequestStatus(status)) return { ok: false, message: 'That request could not be updated.' };
    const r = await liveRequestsEngine().adminSetStatus({ id, status, notes: typeof notes === 'string' ? notes : undefined });
    if (!r.ok) return { ok: false, message: r.message };
    console.info(`[admin] website console: ${admin.id} request ${id.slice(0, 8)} ${status}`);
    refresh();
    return { ok: true, message: 'Saved.', email: r.email };
  } catch {
    return REQUEST_FAIL;
  }
}

/** A ten-minute link to a request's screenshot. Never stored, never logged. */
export async function requestScreenshotAction(requestId: string): Promise<{ ok: boolean; url?: string; message?: string }> {
  try {
    await requireAdmin();
    const id = String(requestId ?? '');
    if (!UUID.test(id)) return { ok: false, message: 'That screenshot could not be found.' };
    const url = await liveRequestsEngine().adminScreenshotUrl(id);
    return url ? { ok: true, url } : { ok: false, message: 'There is no screenshot to show.' };
  } catch {
    return { ok: false, message: 'Not allowed, or something went wrong.' };
  }
}
