'use server';

import { revalidatePath } from 'next/cache';
import { liveAdSheetAdminRunner } from '@/lib/ad-sheets/admin-server';
import { NOT_ALLOWED, type AdSheetAdminResult } from '@/lib/ad-sheets/admin-run';

/**
 * Batch 35 (Phase 10): /admin/ad-sheets' actions. Each is a thin hand-over to
 * the runner (src/lib/ad-sheets/admin-run.ts), which checks the admin FIRST,
 * from the verified session user's email and never from an argument, then
 * validates its arguments. The dry flag is fixed HERE, on the server, per
 * action: a Dry run writes and sends nothing (admin.test.ts pins it). Nothing
 * returned carries a cell, a name, an email, a phone, a postcode or an answer:
 * counts and codes only.
 *
 * (A 'use server' module may only export async functions, so the types and
 * the constants live in admin-run.ts.)
 */

const FAIL: AdSheetAdminResult = { ok: false, message: NOT_ALLOWED, lines: [] };
const refresh = () => revalidatePath('/admin/ad-sheets');

export async function dryRunImportAction(linkId?: string): Promise<AdSheetAdminResult> {
  try {
    return await liveAdSheetAdminRunner().importRun({ dry: true, linkId });
  } catch {
    return FAIL;
  }
}

export async function runImportAction(linkId?: string): Promise<AdSheetAdminResult> {
  try {
    const result = await liveAdSheetAdminRunner().importRun({ dry: false, linkId });
    refresh();
    return result;
  } catch {
    return FAIL;
  }
}

export async function dryRunDisconnectAction(linkId: string): Promise<AdSheetAdminResult> {
  try {
    return await liveAdSheetAdminRunner().disconnect({ linkId, dry: true });
  } catch {
    return FAIL;
  }
}

export async function runDisconnectAction(linkId: string): Promise<AdSheetAdminResult> {
  try {
    const result = await liveAdSheetAdminRunner().disconnect({ linkId, dry: false });
    refresh();
    return result;
  } catch {
    return FAIL;
  }
}

export async function markGuideCheckedAction(): Promise<AdSheetAdminResult> {
  try {
    const result = await liveAdSheetAdminRunner().markGuideChecked({ dry: false });
    refresh();
    return result;
  } catch {
    return FAIL;
  }
}
