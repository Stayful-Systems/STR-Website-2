'use server';

import { revalidatePath } from 'next/cache';
import { liveLeadDbAdminRunner } from '@/lib/ad-packs/ld-admin-server';
import { LD_NOT_ALLOWED, type LdAdminResult } from '@/lib/ad-packs/ld-admin-run';

/**
 * Batch 55 (Part A, A8): /admin/ad-packs' two lead database ad route actions. Each is a thin hand-over to the runner
 * (src/lib/ad-packs/ld-admin-run.ts), which checks the admin FIRST, from the verified session user and never from an
 * argument, then validates its arguments (a reason for an extra round is required, checked on the server). Each success
 * writes one `[admin]` audit line with ids only. Nothing returned carries an email, a name or the reason.
 *
 * (A separate file from actions.ts, whose test pins its exports. A 'use server' module exports only async functions.)
 */

const FAIL: LdAdminResult = { ok: false, message: LD_NOT_ALLOWED };

export async function setAdAccountAllowedAction(ownerId: string, allowed: boolean): Promise<LdAdminResult> {
  try {
    const result = await liveLeadDbAdminRunner().setAllowed(ownerId, allowed);
    if (result.ok) revalidatePath('/admin/ad-packs');
    return result;
  } catch {
    return FAIL;
  }
}

export async function grantExtraRoundAction(ownerId: string, reason: string): Promise<LdAdminResult> {
  try {
    const result = await liveLeadDbAdminRunner().grantRound(ownerId, reason);
    if (result.ok) revalidatePath('/admin/ad-packs');
    return result;
  } catch {
    return FAIL;
  }
}
