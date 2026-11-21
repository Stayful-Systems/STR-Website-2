'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { cancelLive, endOverlapNowLive, markMovedLive, markTagChangedLive, retryExportLive, sendCodeLive, startNewSetupLive } from '@/lib/websites/transfer-server';
import type { StepResult } from '@/lib/websites/transfer-run';

/**
 * Batch 37 (Phase 9): the admin transfers panel's actions (/admin/websites).
 *
 *   dryRunTransferAction / runTransferAction   retry_export · tag_changed · send_code · mark_moved · cancel · end_overlap · new_setup
 *
 * Every action checks the admin FIRST (requireAdmin), before it reads any
 * argument. A dry run goes through the engine's own dryRun flag: no write, no
 * email, no registrar call. Run refuses whatever the engine refuses, so Cancel
 * after the domain has moved is refused here and not only hidden in the screen.
 * Only the transfer id and the action kind come from the screen; the typed
 * transfer code comes only for send_code, goes to the engine and no further: it
 * is emailed to the account owner and is never stored, shown, returned or logged.
 * The owner is read from the transfer on the server.
 *
 * The audit trail is one line per run: `[admin] transfers: <admin> <kind> <id8>: ok|refused <code>`.
 * Ids and codes only: never the transfer code, an address or an email body.
 */

export type TransferKind = 'retry_export' | 'tag_changed' | 'send_code' | 'mark_moved' | 'cancel' | 'end_overlap' | 'new_setup';

export interface TransferActionResult {
  ok: boolean;
  /** One plain sentence for the screen. */
  message: string;
  /** What a dry run would do, in words (the engine's plan: no address, no code). */
  lines: string[];
  /** True only after a dry run that found the action would go ahead. */
  canRun: boolean;
}

const KINDS: readonly string[] = ['retry_export', 'tag_changed', 'send_code', 'mark_moved', 'cancel', 'end_overlap', 'new_setup'];
const UUID = /^[0-9a-f-]{36}$/i;

async function requireAdmin(): Promise<{ id: string }> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user || !isAdminEmail(data.user.email)) throw new Error('Not allowed');
  return { id: data.user.id };
}

const FAIL: TransferActionResult = { ok: false, message: 'Not allowed, or something went wrong. Please try again.', lines: [], canRun: false };
const refresh = () => revalidatePath('/admin/websites');

/** Refusal codes in plain words. A refusal the engine words itself uses its own message. */
const REFUSED: Record<string, string> = {
  not_found: 'That transfer could not be found.',
  cancelled: 'This transfer was cancelled.',
  ended: 'The overlap has already ended for this transfer.',
  not_failed: 'The files did not fail, so there is nothing to retry.',
  not_tag_method: 'This transfer does not use a tag change.',
  no_domain: 'This transfer has no domain to move.',
  not_manual: 'The domain move is not waiting for a manual step.',
  moved: 'The domain has already moved.',
  bad_code: 'That does not look like a transfer code.',
  no_recipient: 'The account owner has no email address on file.',
  not_ended: 'The overlap has not ended yet.',
  no_site: 'The website could not be found.',
  not_due: 'The overlap is not due to end yet.',
  claimed_elsewhere: 'Another run has just done this. Reload the page.',
  conflict: 'The website changed while this ran. Reload the page and try again.',
  renewal_failed: 'The domain could not be allowed to renew again, so nothing was cancelled.',
  pause_failed: 'The website could not be paused, so the overlap was not ended.',
  release_failed: 'The domain could not be taken off the website, so the overlap was not ended.',
  unavailable: 'Not available right now. Please try again.',
};

/** A short, safe code for a screen or a log line: letters, digits, underscore. */
const safeCode = (c: unknown): string => String(c ?? '').replace(/[^a-z0-9_]/gi, '').slice(0, 30) || 'error';

function toResult(r: StepResult, dry: boolean): TransferActionResult {
  const lines = Array.isArray(r.plan) ? r.plan.map(String) : [];
  const outcome = safeCode(r.code);
  if (!r.ok) return { ok: false, message: r.message ?? REFUSED[outcome] ?? `Refused (${outcome}).`, lines, canRun: false };
  const message = dry ? 'Dry run: this is what would happen. Nothing was changed.' : 'Done.';
  // Run is offered only when this dry run found the action would go ahead.
  return { ok: true, message, lines, canRun: dry && outcome.startsWith('would_') };
}

async function perform(adminId: string, kind: TransferKind, id: string, code: unknown, dry: boolean): Promise<StepResult> {
  switch (kind) {
    case 'retry_export':
      return retryExportLive(id, { dryRun: dry });
    case 'tag_changed':
      return markTagChangedLive(id, { dryRun: dry });
    case 'send_code':
      // The typed code is passed here and nowhere else.
      return sendCodeLive(id, typeof code === 'string' ? code : '', { dryRun: dry });
    case 'mark_moved':
      return markMovedLive(id, { dryRun: dry });
    case 'cancel':
      return cancelLive(id, { dryRun: dry, by: adminId });
    case 'end_overlap':
      return endOverlapNowLive(id, { dryRun: dry });
    case 'new_setup':
      return startNewSetupLive(id, { dryRun: dry });
  }
}

export async function dryRunTransferAction(kind: string, transferId: string, code?: string): Promise<TransferActionResult> {
  try {
    const admin = await requireAdmin();
    if (!KINDS.includes(kind)) return { ...FAIL, message: 'Unknown action.' };
    const id = String(transferId ?? '');
    if (!UUID.test(id)) return { ...FAIL, message: REFUSED.not_found };
    return toResult(await perform(admin.id, kind as TransferKind, id, code, true), true);
  } catch {
    return FAIL;
  }
}

export async function runTransferAction(kind: string, transferId: string, code?: string): Promise<TransferActionResult> {
  try {
    const admin = await requireAdmin();
    if (!KINDS.includes(kind)) return { ...FAIL, message: 'Unknown action.' };
    const id = String(transferId ?? '');
    if (!UUID.test(id)) return { ...FAIL, message: REFUSED.not_found };
    const r = await perform(admin.id, kind as TransferKind, id, code, false);
    console.info(`[admin] transfers: ${admin.id} ${kind} ${id.slice(0, 8)}: ${r.ok ? 'ok' : `refused ${safeCode(r.code)}`}`);
    refresh();
    return toResult(r, false);
  } catch {
    return FAIL;
  }
}
