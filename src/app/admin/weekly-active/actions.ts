'use server';

import { redirect, notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { runBackfill, runRetention, setMetricsExclusion, type BackfillResult, type RetentionResult, type RunOutcome } from '@/lib/activity/admin-server';
import { previewDueGrants } from '@/lib/credit/ledger';
import { packExpirySummary, type PackExpirySummary } from '@/lib/credit/pack-expiry-preview';

const PAGE = '/admin/weekly-active';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireAdmin() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?redirect=${PAGE}`);
  if (!isAdminEmail(user.email)) notFound();
  return user;
}

/** The "Exclude from metrics" switch: one account out of (or back into) every figure. */
export async function setExclusionAction(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  const exclude = formData.get('exclude') === '1';
  const all = formData.get('all') === '1' ? '&all=1' : '';
  if (!UUID.test(id)) redirect(`${PAGE}?msg=failed${all}`);
  const ok = await setMetricsExclusion({ userId: id, exclude, by: user.email ?? user.id });
  revalidatePath(PAGE);
  redirect(`${PAGE}?msg=${ok ? (exclude ? 'excluded' : 'included') : 'failed'}${all}`);
}

export type BackfillState = { at: string; outcome: RunOutcome<BackfillResult> } | null;

/** The backfill: `apply` 0 is the dry run (counts only), 1 copies. Safe to repeat. */
export async function backfillAction(_prev: BackfillState, formData: FormData): Promise<BackfillState> {
  await requireAdmin();
  const apply = formData.get('apply') === '1';
  return { at: new Date().toISOString(), outcome: await runBackfill(apply) };
}

export type RetentionState = { at: string; outcome: RunOutcome<RetentionResult> } | null;

/** Counts what the nightly retention would delete. Never deletes. */
export async function retentionCheckAction(): Promise<RetentionState> {
  await requireAdmin();
  return { at: new Date().toISOString(), outcome: await runRetention({ apply: false }) };
}

export type PackExpiryState = { at: string; ok: true; summary: PackExpirySummary } | { at: string; ok: false; message: string } | null;

/**
 * Review R4 (R4-31): the credit sweep's dry run (/api/internal/credit-sweep?dry=1) for the admin who is logged in: what
 * would expire and which starter-pack bonuses would be lifted, as totals. A preview only: it never expires, lifts or
 * grants anything (the nightly sweep at 03:00 UTC does). Kept off /admin/billing (Batch 31a's page).
 */
export async function packExpiryPreviewAction(): Promise<PackExpiryState> {
  await requireAdmin();
  const at = new Date().toISOString();
  try {
    return { at, ok: true, summary: packExpirySummary(await previewDueGrants()) };
  } catch (err) {
    return { at, ok: false, message: (err as Error)?.message ?? 'failed' };
  }
}
