'use server';

import { revalidatePath } from 'next/cache';
import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin';
import { liveTransferDeps, startTransferLive } from '@/lib/websites/transfer-server';
import { transferCodeEmail } from '@/lib/websites/transfer-emails';
import { methodFor, type TransferMethod, type TransferDomainState } from '@/lib/websites/transfer-rules';
import { websiteActor } from '../../setup/website/context';

/**
 * Batch 37 (Phase 8): the operator's "Take my website" screen.
 *
 * Every action starts with websiteActor(): the signed-in account OWNER's own website. A team member,
 * a member with no site and a signed-out visitor are refused before anything is read. The only things
 * read from the form are `providerKey` and `tag`. The transfer is never named by the caller: it is the
 * latest one for the signed-in owner (ownerId comes from the actor, never from input). A transfer code
 * is never shown, stored or logged: "Email me the code again" fetches it, emails it, and forgets it.
 *
 * Nothing here writes leads, leads.status or leads.crm_pushed_at. Log lines carry a code at most.
 */

export interface TransferFormState {
  error?: string;
  /** The Check (a dry run) passed: what Confirm would do, in plain words. */
  plan?: string[];
  /** The transfer has started. */
  started?: boolean;
}

export interface LinkState {
  error?: string;
  /** A signed address, valid for ten minutes. */
  url?: string;
}

export interface CodeState {
  error?: string;
  sent?: boolean;
}

/** What the owner may see of a transfer: no id, no reference, no path. */
export interface TransferView {
  providerName: string;
  method: TransferMethod;
  /** The owner's own domain, when the transfer is for one. */
  domainName: string | null;
  files: 'building' | 'ready' | 'failed';
  domain: TransferDomainState;
  overlapEndsAt: string | null;
  overlapEnded: boolean;
  cancelled: boolean;
}

export type TransferScreen =
  | { kind: 'denied' }
  | { kind: 'unavailable' }
  | { kind: 'start'; hasDomain: boolean; domainName: string | null; method: TransferMethod; overlapDays: number; previouslyCancelled: boolean }
  | { kind: 'status'; view: TransferView; overlapDays: number };

const NOT_SIGNED_IN = 'Please sign in again.';
const TRY_AGAIN = 'We could not do that just now. Please try again.';
const denial = (reason: string): string => (reason === 'signed_out' ? NOT_SIGNED_IN : TRY_AGAIN);

const COLUMNS = 'id, method, provider_name, domain_name, domain_state, export_state, export_path, overlap_ends_at, overlap_ended_at, cancelled_at, snapshot';

interface OwnRow {
  id: string;
  method: TransferMethod;
  providerName: string;
  domainName: string | null;
  domainState: TransferDomainState;
  exportState: 'pending' | 'ready' | 'failed';
  exportPath: string | null;
  overlapEndsAt: string | null;
  overlapEndedAt: string | null;
  cancelledAt: string | null;
  companyName: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The signed-in owner's latest transfer (the owner id is the actor's, never input), or null. */
async function ownTransfer(ownerId: string): Promise<OwnRow | null | 'unavailable'> {
  if (!hasServiceRole()) return 'unavailable';
  const { data, error } = await createAdminClient().from('website_transfers').select(COLUMNS).eq('owner_id', ownerId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) {
    console.error('[website-transfer] screen read failed:', String((error as { code?: string }).code ?? 'error').slice(0, 20));
    return 'unavailable';
  }
  if (!data) return null;
  const r = data as Record<string, unknown>;
  const ds = String(r.domain_state);
  const snap = r.snapshot && typeof r.snapshot === 'object' ? (r.snapshot as Record<string, unknown>) : {};
  return {
    id: String(r.id),
    method: r.method === 'tag' || r.method === 'code' ? r.method : 'none',
    providerName: String(r.provider_name ?? ''),
    domainName: str(r.domain_name),
    domainState: ds === 'pending' || ds === 'manual' || ds === 'requested' || ds === 'moved' ? ds : 'none',
    exportState: r.export_state === 'ready' || r.export_state === 'failed' ? r.export_state : 'pending',
    exportPath: str(r.export_path),
    overlapEndsAt: str(r.overlap_ends_at),
    overlapEndedAt: str(r.overlap_ended_at),
    cancelledAt: str(r.cancelled_at),
    companyName: typeof snap.companyName === 'string' ? snap.companyName : '',
  };
}

/** What the screen shows: the start form, or the status of the transfer that is under way. */
export async function transferScreenAction(): Promise<TransferScreen> {
  const r = await websiteActor();
  if (!r.ok) return { kind: 'denied' };
  const deps = liveTransferDeps();
  let own: OwnRow | null | 'unavailable';
  let settings;
  try {
    [own, settings] = await Promise.all([ownTransfer(r.actor.userId), deps.settings()]);
  } catch {
    return { kind: 'unavailable' };
  }
  if (own === 'unavailable') return { kind: 'unavailable' };

  if (own && !own.cancelledAt) {
    return {
      kind: 'status',
      overlapDays: settings.overlapDays,
      view: {
        providerName: own.providerName,
        method: own.method,
        domainName: own.domainName,
        files: own.exportState === 'ready' ? 'ready' : own.exportState === 'failed' ? 'failed' : 'building',
        domain: own.domainState,
        overlapEndsAt: own.overlapEndsAt,
        overlapEnded: Boolean(own.overlapEndedAt),
        cancelled: false,
      },
    };
  }

  let domainName: string | null = null;
  try {
    domainName = (await deps.startFacts(r.actor.userId))?.domain?.name ?? null;
  } catch {
    return { kind: 'unavailable' };
  }
  const hasDomain = domainName !== null;
  return { kind: 'start', hasDomain, domainName, method: methodFor(deps.now(), settings.codeFrom, hasDomain), overlapDays: settings.overlapDays, previouslyCancelled: Boolean(own?.cancelledAt) };
}

/** The Check: every rule, as a dry run. Nothing is written, sent or asked of the registrar. */
export async function checkTransferAction(_prev: TransferFormState, formData: FormData): Promise<TransferFormState> {
  const r = await websiteActor();
  if (!r.ok) return { error: denial(r.reason) };
  const result = await startTransferLive(r.actor.userId, { providerKey: formData.get('providerKey'), tag: formData.get('tag'), dryRun: true });
  if (!result.ok) return { error: result.message ?? TRY_AGAIN };
  return { plan: result.plan ?? [] };
}

/** Confirm: start the transfer for the signed-in owner's own website. */
export async function startTransferAction(_prev: TransferFormState, formData: FormData): Promise<TransferFormState> {
  const r = await websiteActor();
  if (!r.ok) return { error: denial(r.reason) };
  const result = await startTransferLive(r.actor.userId, { providerKey: formData.get('providerKey'), tag: formData.get('tag') });
  if (!result.ok) return { error: result.message ?? TRY_AGAIN };
  revalidatePath('/leads/website/transfer');
  return { started: true };
}

const LINK_SECONDS = 600;

/** A fresh download address for the files, valid for ten minutes. Only for the owner's own ready, open transfer. */
export async function downloadLinkAction(): Promise<LinkState> {
  const r = await websiteActor();
  if (!r.ok) return { error: denial(r.reason) };
  const own = await ownTransfer(r.actor.userId);
  if (own === 'unavailable') return { error: TRY_AGAIN };
  if (!own || own.cancelledAt || own.overlapEndedAt) return { error: 'There are no files to download.' };
  if (own.exportState !== 'ready' || !own.exportPath) return { error: 'Your files are not ready yet. We email them as soon as they are.' };
  let url: string | null = null;
  try {
    url = await liveTransferDeps().storage.signedUrl(own.exportPath, LINK_SECONDS);
  } catch {
    url = null;
  }
  return url ? { url } : { error: TRY_AGAIN };
}

/** One email a ten-minute window at most: a double click, or a second tab, sends one. */
const WINDOW_MS = 10 * 60 * 1000;

/** "Email me the code again": fetched from the registrar, emailed to the owner, never shown, stored or logged. */
export async function resendCodeAction(): Promise<CodeState> {
  const r = await websiteActor();
  if (!r.ok) return { error: denial(r.reason) };
  const own = await ownTransfer(r.actor.userId);
  if (own === 'unavailable') return { error: TRY_AGAIN };
  if (!own || own.cancelledAt || own.overlapEndedAt || own.method !== 'code' || !own.domainName) return { error: 'There is no transfer code to send.' };
  if (own.domainState === 'moved') return { error: 'Your domain has already moved, so you will not need the code.' };
  if (own.domainState !== 'requested') return { error: 'We have not sent your transfer code yet. We will email it as soon as it is ready.' };

  const deps = liveTransferDeps();
  try {
    const to = await deps.ownerEmail(r.actor.userId);
    if (!to) return { error: TRY_AGAIN };
    const code = await deps.registrar().transferCode(own.domainName);
    const bucket = Math.floor(deps.now().getTime() / WINDOW_MS);
    const out = await deps.sendOwner(to, transferCodeEmail({ siteName: own.companyName, domain: own.domainName, code, providerName: own.providerName }), { idempotencyKey: `website-transfer-code-again:${own.id}:${bucket}` });
    if (!out.sent) return { error: TRY_AGAIN };
  } catch {
    // Nothing about the failure is logged or shown: it may hold the code or an address. Our team sees stuck moves.
    return { error: 'We could not send the code just now. Please try again in a few minutes, or ask the team.' };
  }
  return { sent: true };
}
