'use server';

import { revalidatePath } from 'next/cache';
import { liveAdPackAdminRunner } from '@/lib/ad-packs/admin-server';
import { NOT_ALLOWED, type LinkMissingAdminResult, type RegenerateResult } from '@/lib/ad-packs/admin-run';

/**
 * Batch 38: /admin/ad-packs' actions. Each one is a thin hand-over to the
 * runner (src/lib/ad-packs/admin-run.ts), which checks the admin FIRST, from
 * the verified session user's email and never from an argument, then
 * validates its arguments. A Dry run writes nothing (admin-run.test.ts pins
 * it); the regenerate Run needs the token its Dry run returned and re-plans
 * from the database as it is now. Nothing here returns a lead's details.
 *
 * (A 'use server' module may only export async functions, so the types and
 * the constants live in admin-run.ts.)
 */

const FAIL_REGEN: RegenerateResult = { ok: false, message: NOT_ALLOWED, lines: [], canRun: false, token: null };
const FAIL_LINK: LinkMissingAdminResult = { ok: false, message: NOT_ALLOWED, lines: [], canRun: false, count: 0, linked: 0, untagged: 0, skipped: 0, failed: 0 };
const refresh = () => revalidatePath('/admin/ad-packs');

export async function dryRunRegenerateAction(packId: string): Promise<RegenerateResult> {
  try {
    return await liveAdPackAdminRunner().dryRegenerate(packId);
  } catch {
    return FAIL_REGEN;
  }
}

export async function runRegenerateAction(packId: string, token: string): Promise<RegenerateResult> {
  try {
    const result = await liveAdPackAdminRunner().runRegenerate(packId, token);
    refresh();
    return result;
  } catch {
    return FAIL_REGEN;
  }
}

export async function dryRunLinkMissingAction(ownerId?: string): Promise<LinkMissingAdminResult> {
  try {
    return await liveAdPackAdminRunner().dryLinkMissing(ownerId);
  } catch {
    return FAIL_LINK;
  }
}

export async function runLinkMissingAction(ownerId?: string): Promise<LinkMissingAdminResult> {
  try {
    const result = await liveAdPackAdminRunner().runLinkMissing(ownerId);
    refresh();
    return result;
  } catch {
    return FAIL_LINK;
  }
}
