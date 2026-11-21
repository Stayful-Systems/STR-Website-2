import 'server-only';

/**
 * Batch 37 (Phase 5b): the live wiring for the website transfer engine
 * (transfer-run.ts holds every rule and the tests). This file only BINDS: it
 * builds the real TransferDeps and exposes thin entry points. Service role only.
 *
 *   liveTransferDeps()      the engine's deps over Supabase, the registrar factory, Batch 33's
 *                           domain engine, Batch 36's pause step, sendEmail and the activity log
 *   startTransferLive(ownerId, input)   the operator's start. `ownerId` is the signed-in account
 *                           owner (websiteActor -> ownerIdOrNull); the input never names an owner
 *   runExportStep / runEmailStep / runDomainStep / runPollStep / runStuckStep / runOverlapStep
 *                           the cron's steps: the due rows (a per-run limit), each through the engine
 *                           once. { dryRun } lists the due ids and the step name and does NOTHING else
 *   retryExportLive / markTagChangedLive / sendCodeLive / markMovedLive / cancelLive /
 *   endOverlapNowLive / startNewSetupLive
 *                           the admin's actions, each with { dryRun } (the engine's own dry run)
 *
 * Every write is a claim: "update ... set col = at where id = ? and col is null returning id", so two
 * runs never both act. The zip lives in the private bucket website-transfers at <owner>/<id>.zip.
 * Nothing here reads leads or writes leads.status or leads.crm_pushed_at.
 *
 * Logs carry a short transfer id and a code: never an address, an email, a transfer code, a form body
 * or a zip URL (the engine writes the lines; the few here carry a database error code).
 */
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { recordActivity } from '../activity/log';
import { sendEmail } from '../email/send';
import { brandedFrom } from '../email/from.ts';
import { adminEmails } from '../admin';
import { siteUrl } from '../url';
import { liveDomainEngine, readDomainSettings } from '../domains/store-server';
import { getRegistrar } from '../domains/registrar/index.ts';
import { setStatus, siteById } from './store-server';
import { sitePagesOf } from './render';
import { DEFAULT_TRANSFER, parseTransfer, TRANSFER_KEYS, type TransferSettings } from './transfer-settings.ts';
import * as engine from './transfer-run.ts';
import type { ClaimColumn, InsertResult, NewTransfer, SiteState, StartFacts, StartResult, StepResult, TransferDeps, TransferPatch, TransferRow } from './transfer-run.ts';

type Admin = ReturnType<typeof createAdminClient>;
const admin = (): Admin => createAdminClient();

/** The private bucket the zips live in (created by the schema's Batch 37 block). */
const BUCKET = 'website-transfers';
const UUID = /^[0-9a-f-]{36}$/i;
const TABLE = 'website_transfers';
const COLUMNS =
  'id, website_id, owner_id, ref, provider_key, provider_name, ips_tag, method, domain_id, domain_name, snapshot, export_state, export_path, export_attempts, export_error, export_ready_at, export_emailed_at, domain_state, tag_claimed_at, domain_requested_at, code_sent_at, domain_moved_at, stuck_alerted_at, moved_emailed_at, overlap_ends_at, overlap_ended_at, cancelled_at, cancelled_by';

const iso = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const dbCode = (e: { code?: string } | null): string => (e?.code ? String(e.code).slice(0, 20) : 'error');

// ── The row ──

function toRow(r: Record<string, unknown>): TransferRow {
  const method = r.method === 'tag' || r.method === 'code' ? r.method : 'none';
  const exportState = r.export_state === 'ready' || r.export_state === 'failed' ? r.export_state : 'pending';
  const ds = String(r.domain_state);
  const domainState = ds === 'pending' || ds === 'manual' || ds === 'requested' || ds === 'moved' ? ds : 'none';
  return {
    id: String(r.id),
    websiteId: String(r.website_id),
    ownerId: String(r.owner_id),
    ref: String(r.ref),
    providerKey: String(r.provider_key),
    providerName: String(r.provider_name),
    ipsTag: strOrNull(r.ips_tag),
    method,
    domainId: strOrNull(r.domain_id),
    domainName: strOrNull(r.domain_name),
    snapshot: r.snapshot && typeof r.snapshot === 'object' && !Array.isArray(r.snapshot) ? (r.snapshot as Record<string, unknown>) : {},
    exportState,
    exportPath: strOrNull(r.export_path),
    exportAttempts: Number(r.export_attempts) || 0,
    exportError: strOrNull(r.export_error),
    exportReadyAt: iso(r.export_ready_at),
    exportEmailedAt: iso(r.export_emailed_at),
    domainState,
    tagClaimedAt: iso(r.tag_claimed_at),
    domainRequestedAt: iso(r.domain_requested_at),
    codeSentAt: iso(r.code_sent_at),
    domainMovedAt: iso(r.domain_moved_at),
    stuckAlertedAt: iso(r.stuck_alerted_at),
    movedEmailedAt: iso(r.moved_emailed_at),
    overlapEndsAt: iso(r.overlap_ends_at),
    overlapEndedAt: iso(r.overlap_ended_at),
    cancelledAt: iso(r.cancelled_at),
    cancelledBy: strOrNull(r.cancelled_by),
  };
}

const CLAIM_COLUMNS: Record<ClaimColumn, string> = {
  tagClaimedAt: 'tag_claimed_at',
  codeSentAt: 'code_sent_at',
  overlapEndedAt: 'overlap_ended_at',
  movedEmailedAt: 'moved_emailed_at',
  stuckAlertedAt: 'stuck_alerted_at',
  exportEmailedAt: 'export_emailed_at',
  cancelledAt: 'cancelled_at',
};

// ── Settings ──

async function readSettings(): Promise<TransferSettings> {
  if (!hasServiceRole()) return DEFAULT_TRANSFER;
  const { data, error } = await admin().from('billing_settings').select('key, value').in('key', Object.values(TRANSFER_KEYS));
  if (error) console.error('[website-transfer] settings read failed, using defaults:', dbCode(error));
  const kv = new Map<string, unknown>((data ?? []).map((r) => [String((r as { key: unknown }).key), (r as { value: unknown }).value]));
  return parseTransfer((k) => kv.get(k));
}

// ── Our own fetch: the engine passes the timeout; the body is capped here ──

const FETCH_CAP_BYTES = engine.MAX_ASSET_BYTES;

async function cappedFetch(url: string, init: { signal: AbortSignal; redirect: 'manual' }): Promise<Response> {
  const res = await fetch(url, { ...init, cache: 'no-store' });
  if (!res.ok || !res.body) return res;
  const declared = Number(res.headers.get('content-length'));
  const tooBig = () => new Response(null, { status: 413 });
  if (Number.isFinite(declared) && declared > FETCH_CAP_BYTES) {
    await res.body.cancel().catch(() => undefined);
    return tooBig();
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > FETCH_CAP_BYTES) {
      await reader.cancel().catch(() => undefined);
      return tooBig();
    }
    parts.push(value);
  }
  const type = res.headers.get('content-type');
  return new Response(Buffer.concat(parts), { status: res.status, ...(type ? { headers: { 'content-type': type } } : {}) });
}

// ── Mail ──

const fromHeader = (): string | undefined => brandedFrom(process.env.EMAIL_FROM, 'Stayful Intelligence') ?? undefined;

// ── The deps ──

/** The engine's real deps. Every effect it needs is bound below; nothing here decides anything. */
export function liveTransferDeps(): TransferDeps {
  return {
    now: () => new Date(),
    log: (line) => console.log(line),
    settings: () => readSettings(),
    urls: () => ({ fetchBase: siteUrl(), publicBase: siteUrl() }),

    // Reads
    transfer: async (id) => {
      if (!UUID.test(id)) return null;
      const { data, error } = await admin().from(TABLE).select(COLUMNS).eq('id', id).maybeSingle();
      if (error) throw new Error(`${TABLE} read failed: ${dbCode(error)}`);
      return data ? toRow(data as Record<string, unknown>) : null;
    },
    startFacts: async (ownerId): Promise<StartFacts | null> => {
      if (!UUID.test(ownerId)) return null;
      const { data: w, error: we } = await admin().from('websites').select('id, user_id, status').eq('user_id', ownerId).maybeSingle();
      if (we) throw new Error(`websites read failed: ${dbCode(we)}`);
      if (!w) return null;
      const base = w as { id: string; user_id: string; status: string };
      const site = await siteById(base.id);
      if (!site) return null;
      const [open, dom] = await Promise.all([
        admin().from(TABLE).select('id').eq('website_id', base.id).is('cancelled_at', null).is('overlap_ended_at', null).limit(1),
        admin().from('website_domains').select('id, name, status').eq('website_id', base.id).neq('status', 'released').maybeSingle(),
      ]);
      // Fail closed: an unreadable answer is never "no open transfer" or "no domain".
      if (open.error) throw new Error(`${TABLE} read failed: ${dbCode(open.error)}`);
      if (dom.error) throw new Error(`website_domains read failed: ${dbCode(dom.error)}`);
      const d = dom.data as { id: string; name: string; status: string } | null;
      return {
        websiteId: site.id,
        ownerId: site.userId,
        status: site.status,
        deleted: false,
        pageCount: sitePagesOf(site, site.settings, site.pages)?.length ?? 0,
        hasOpenTransfer: (open.data?.length ?? 0) > 0,
        settings: { companyName: site.settings.companyName, brandColour: site.settings.brandColour, contactEmail: site.settings.contactEmail, contactPhone: site.settings.contactPhone, logoUrl: site.settings.logoUrl },
        domain: d ? { id: d.id, name: d.name, ready: d.status === 'live' } : null,
      };
    },
    unpaidDomain: async (ownerId) => {
      if (!UUID.test(ownerId) || !(await readDomainSettings()).chargeOn) return false;
      const { data, error } = await admin().from('website_domain_charges').select('domain_id').eq('owner_id', ownerId).eq('status', 'unpaid').limit(1);
      if (error) throw new Error(`website_domain_charges read failed: ${dbCode(error)}`);
      return (data?.length ?? 0) > 0;
    },
    site: async (websiteId): Promise<SiteState | null> => {
      if (!UUID.test(websiteId)) return null;
      const { data, error } = await admin().from('websites').select('id, user_id, status').eq('id', websiteId).maybeSingle();
      if (error) throw new Error(`websites read failed: ${dbCode(error)}`);
      const r = data as { id: string; user_id: string; status: string } | null;
      return r ? { id: r.id, ownerId: r.user_id, status: r.status } : null;
    },
    ownerEmail: async (ownerId) => {
      if (!UUID.test(ownerId)) return null;
      const { data } = await admin().from('profiles').select('email').eq('id', ownerId).maybeSingle();
      return strOrNull((data as { email?: unknown } | null)?.email);
    },
    pages: async (websiteId) => {
      const site = await siteById(websiteId);
      return site ? sitePagesOf(site, site.settings, site.pages) : null;
    },

    // Writes
    insertTransfer: async (row: NewTransfer): Promise<InsertResult> => {
      const { data, error } = await admin()
        .from(TABLE)
        .insert({
          website_id: row.websiteId,
          owner_id: row.ownerId,
          provider_key: row.providerKey,
          provider_name: row.providerName,
          ips_tag: row.ipsTag,
          method: row.method,
          domain_id: row.domainId,
          domain_name: row.domainName,
          snapshot: row.snapshot,
          domain_state: row.domainState,
          overlap_ends_at: row.overlapEndsAt.toISOString(),
        })
        .select('id, ref')
        .single();
      if (error || !data) return { ok: false, code: (error as { code?: string } | null)?.code === '23505' ? 'conflict' : 'unavailable' };
      const r = data as { id: string; ref: string };
      return { ok: true, id: r.id, ref: r.ref };
    },
    patch: async (id, f: TransferPatch) => {
      const set: Record<string, unknown> = {};
      if (f.exportState !== undefined) set.export_state = f.exportState;
      if (f.exportPath !== undefined) set.export_path = f.exportPath;
      if (f.exportError !== undefined) set.export_error = f.exportError === null ? null : f.exportError.slice(0, 200);
      if (f.exportAttempts !== undefined) set.export_attempts = f.exportAttempts;
      if (f.exportReadyAt !== undefined) set.export_ready_at = f.exportReadyAt ? f.exportReadyAt.toISOString() : null;
      if (f.domainState !== undefined) set.domain_state = f.domainState;
      if (f.domainRequestedAt !== undefined) set.domain_requested_at = f.domainRequestedAt ? f.domainRequestedAt.toISOString() : null;
      if (f.domainMovedAt !== undefined) set.domain_moved_at = f.domainMovedAt ? f.domainMovedAt.toISOString() : null;
      if (f.cancelledBy !== undefined) set.cancelled_by = f.cancelledBy !== null && UUID.test(f.cancelledBy) ? f.cancelledBy : null;
      if (Object.keys(set).length === 0) return true;
      const { data, error } = await admin().from(TABLE).update({ ...set, updated_at: new Date().toISOString() }).eq('id', id).select('id');
      if (error) {
        console.error('[website-transfer] write failed:', dbCode(error));
        return false;
      }
      return (data?.length ?? 0) > 0;
    },
    claim: async (id, column, at) => {
      const col = CLAIM_COLUMNS[column];
      let q = admin().from(TABLE).update({ [col]: at.toISOString(), updated_at: at.toISOString() }).eq('id', id).is(col, null);
      // An overlap that has ended is not cancelled afterwards, and a cancelled transfer does not end.
      if (column === 'overlapEndedAt') q = q.is('cancelled_at', null);
      if (column === 'cancelledAt') q = q.is('overlap_ended_at', null);
      const { data, error } = await q.select('id');
      if (error) {
        console.error('[website-transfer] claim failed:', dbCode(error));
        return false;
      }
      return (data?.length ?? 0) === 1;
    },
    unclaim: async (id, column) => {
      const { error } = await admin().from(TABLE).update({ [CLAIM_COLUMNS[column]]: null, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) console.error('[website-transfer] unclaim failed:', dbCode(error));
    },
    claimExportAttempt: async (id, expected, at) => {
      const { data, error } = await admin()
        .from(TABLE)
        .update({ export_attempts: expected + 1, updated_at: at.toISOString() })
        .eq('id', id)
        .eq('export_attempts', expected)
        .eq('export_state', 'pending')
        .select('id');
      if (error) {
        console.error('[website-transfer] attempt claim failed:', dbCode(error));
        return false;
      }
      return (data?.length ?? 0) === 1;
    },

    // The site and its domain
    blockRenewal: async (websiteId) => (await liveDomainEngine().blockRenewal(websiteId)).ok,
    allowRenewal: async (websiteId) => (await liveDomainEngine().allowRenewal(websiteId)).ok,
    // Batch 36's pause step: a live site moves by the usual rule (live -> paused).
    pauseSite: async (site) => (await setStatus(site.ownerId, 'paused')).ok,
    releaseDomain: async (domainId, opts) => {
      const r = await liveDomainEngine().release(domainId, opts);
      return { ok: r.ok, outcome: r.outcome };
    },
    // Coming back: back to setup. paused_at is cleared; approved_at and live_at keep their first-time stamps.
    resetSite: async (websiteId) => {
      const now = new Date().toISOString();
      const { data, error } = await admin().from('websites').update({ status: 'setup', paused_at: null, updated_at: now }).eq('id', websiteId).in('status', ['live', 'paused', 'preview']).select('id');
      if (error) {
        console.error('[website-transfer] reset failed:', dbCode(error));
        return false;
      }
      return (data?.length ?? 0) > 0;
    },

    registrar: () => getRegistrar(),

    // Our files and the network
    storage: {
      upload: async (path, bytes) => {
        const { error } = await admin().storage.from(BUCKET).upload(path, bytes, { contentType: 'application/zip', upsert: true });
        if (error) throw new Error('zip upload failed');
      },
      download: async (path) => {
        const { data, error } = await admin().storage.from(BUCKET).download(path);
        if (error) {
          if (/not.?found/i.test(error.message ?? '')) return null;
          throw new Error('zip download failed');
        }
        return data ? new Uint8Array(await data.arrayBuffer()) : null;
      },
      remove: async (path) => {
        const { error } = await admin().storage.from(BUCKET).remove([path]);
        if (error) throw new Error('zip delete failed');
      },
      signedUrl: async (path, seconds) => {
        const { data, error } = await admin().storage.from(BUCKET).createSignedUrl(path, seconds);
        return error || !data?.signedUrl ? null : data.signedUrl;
      },
    },
    fetch: cappedFetch,

    // Mail, activity: direct sends, outside the daily cap
    sendOwner: async (to, copy, opts) => {
      const from = fromHeader();
      const res = await sendEmail({
        to,
        ...copy,
        ...(from ? { from } : {}),
        idempotencyKey: opts.idempotencyKey,
        ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) } : {}),
      });
      return { sent: res.sent, ...(res.reason ? { reason: res.reason } : {}) };
    },
    sendAdmin: async (copy, key) => {
      const to = adminEmails();
      if (to.length === 0) return false;
      const from = fromHeader();
      let any = false;
      for (const address of to) {
        const res = await sendEmail({ to: address, ...copy, ...(from ? { from } : {}), idempotencyKey: `${key}:${address}` });
        any = any || res.sent;
      }
      return any;
    },
    record: (userId, kind, o) => recordActivity(userId, kind, { dedupeKey: o.dedupeKey, extras: { website: true } }),
  };
}

// ── Entry points: no write is made below this line except through the engine ──

const unavailable = (dryRun: boolean): StepResult => ({ ok: false, code: 'unavailable', dryRun, message: 'The transfer could not be reached just now. Please try again.' });
const notFound = (dryRun: boolean): StepResult => ({ ok: false, code: 'not_found', dryRun });

/**
 * The operator's start. `ownerId` is the signed-in account owner the caller resolved (websiteActor ->
 * ownerIdOrNull); the website is the one that owner holds. The input is the provider choice and the
 * dry-run flag: it can never name an owner, a website or a transfer.
 */
export async function startTransferLive(ownerId: string, input: { providerKey?: unknown; tag?: unknown; dryRun?: boolean }): Promise<StartResult> {
  const dry = Boolean(input.dryRun);
  if (!hasServiceRole() || !UUID.test(ownerId)) return unavailable(dry);
  try {
    return await engine.startTransfer(liveTransferDeps(), ownerId, { providerKey: input.providerKey, tag: input.tag, dryRun: input.dryRun });
  } catch (err) {
    console.error('[website-transfer] start failed:', (err as Error)?.name ?? 'error');
    return unavailable(dry);
  }
}

export type StepName = 'export' | 'email' | 'domain' | 'poll' | 'stuck' | 'overlap';

export interface SweepOpts {
  dryRun?: boolean;
  /** The most rows this run takes (the step's default when left out). */
  limit?: number;
  /** An epoch-ms deadline: no new row is started after it (the cron's time budget). */
  until?: number;
}

export interface SweepResult {
  step: StepName;
  dryRun: boolean;
  /** The due transfer ids (all of them a dry run found, or the ones this run took). */
  ids: string[];
  /** A run only: what each did, as codes. */
  results: Array<{ id: string; ok: boolean; code: string }>;
  error?: 'unavailable';
}

const DEFAULT_LIMIT: Record<StepName, number> = { export: 1, email: 10, domain: 10, poll: 20, stuck: 10, overlap: 10 };

/** An open transfer: not cancelled, overlap not ended. */
const openRows = () => admin().from(TABLE).select('id').is('cancelled_at', null).is('overlap_ended_at', null);

async function dueIds(step: StepName, limit: number): Promise<string[]> {
  const now = new Date();
  let q;
  switch (step) {
    case 'export':
      q = openRows().eq('export_state', 'pending').lt('export_attempts', engine.MAX_EXPORT_ATTEMPTS);
      break;
    case 'email':
      q = openRows().eq('export_state', 'ready').is('export_emailed_at', null);
      break;
    case 'domain':
      q = openRows().eq('domain_state', 'pending').in('method', ['tag', 'code']);
      break;
    case 'poll':
      q = openRows().or('domain_state.eq.requested,and(domain_state.eq.moved,moved_emailed_at.is.null)');
      break;
    case 'stuck': {
      const days = (await readSettings()).stuckDays;
      q = openRows()
        .eq('domain_state', 'requested')
        .is('stuck_alerted_at', null)
        .lt('domain_requested_at', new Date(now.getTime() - days * 86400000).toISOString());
      break;
    }
    case 'overlap':
      q = openRows().lte('overlap_ends_at', now.toISOString()).in('domain_state', ['none', 'moved']);
      break;
  }
  const { data, error } = await q.order('created_at', { ascending: true }).limit(limit);
  if (error) throw new Error(`${TABLE} read failed: ${dbCode(error)}`);
  return (data ?? []).map((r) => String((r as { id: unknown }).id));
}

async function sweep(step: StepName, runOne: (deps: TransferDeps, id: string) => Promise<StepResult>, opts: SweepOpts): Promise<SweepResult> {
  const dryRun = Boolean(opts.dryRun);
  if (!hasServiceRole()) return { step, dryRun, ids: [], results: [], error: 'unavailable' };
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? DEFAULT_LIMIT[step])));
  let ids: string[];
  try {
    ids = await dueIds(step, limit);
  } catch (err) {
    console.error('[website-transfer] due read failed:', (err as Error)?.name ?? 'error');
    return { step, dryRun, ids: [], results: [], error: 'unavailable' };
  }
  // A dry run stops here: the ids and the step name, and nothing else.
  if (dryRun) return { step, dryRun: true, ids, results: [] };

  const deps = liveTransferDeps();
  const results: SweepResult['results'] = [];
  for (const id of ids) {
    if (opts.until !== undefined && Date.now() > opts.until) break;
    try {
      const r = await runOne(deps, id);
      results.push({ id, ok: r.ok, code: r.code });
    } catch (err) {
      console.error('[website-transfer] step failed:', (err as Error)?.name ?? 'error');
      results.push({ id, ok: false, code: 'error' });
    }
  }
  return { step, dryRun: false, ids: results.map((r) => r.id), results };
}

/** Build the zip for the next pending export (one per run unless a limit says more). */
export const runExportStep = (opts: SweepOpts = {}): Promise<SweepResult> => sweep('export', (d, id) => engine.buildExport(d, id), opts);
/** Email the exports that are ready and not yet sent. */
export const runEmailStep = (opts: SweepOpts = {}): Promise<SweepResult> => sweep('email', (d, id) => engine.emailExport(d, id), opts);
/** Ask for the domain to move (the tag change, or the transfer code email) where it has not been asked. */
export const runDomainStep = (opts: SweepOpts = {}): Promise<SweepResult> => sweep('domain', (d, id) => engine.requestDomain(d, id), opts);
/** Has a requested domain left our account? */
export const runPollStep = (opts: SweepOpts = {}): Promise<SweepResult> => sweep('poll', (d, id) => engine.pollDomain(d, id), opts);
/** Tell the admin, once, of a move that has sat too long. */
export const runStuckStep = (opts: SweepOpts = {}): Promise<SweepResult> => sweep('stuck', (d, id) => engine.alertStuck(d, id), opts);
/** End the overlaps that are due. */
export const runOverlapStep = (opts: SweepOpts = {}): Promise<SweepResult> => sweep('overlap', (d, id) => engine.endOverlap(d, id), opts);

// ── Admin actions ──

async function adminRun(id: string, dryRun: boolean | undefined, run: (deps: TransferDeps, dry: boolean) => Promise<StepResult>): Promise<StepResult> {
  const dry = Boolean(dryRun);
  if (!hasServiceRole()) return unavailable(dry);
  if (!UUID.test(id)) return notFound(dry);
  try {
    return await run(liveTransferDeps(), dry);
  } catch (err) {
    console.error('[website-transfer] admin action failed:', (err as Error)?.name ?? 'error');
    return unavailable(dry);
  }
}

export interface AdminOpts {
  dryRun?: boolean;
}

export const retryExportLive = (id: string, opts: AdminOpts = {}): Promise<StepResult> => adminRun(id, opts.dryRun, (d, dryRun) => engine.retryExport(d, id, { dryRun }));
export const markTagChangedLive = (id: string, opts: AdminOpts = {}): Promise<StepResult> => adminRun(id, opts.dryRun, (d, dryRun) => engine.markTagChanged(d, id, { dryRun }));
/** The admin typed the transfer code: it is emailed to the owner and goes no further (not stored, logged or returned). */
export const sendCodeLive = (id: string, code: unknown, opts: AdminOpts = {}): Promise<StepResult> => adminRun(id, opts.dryRun, (d, dryRun) => engine.sendCode(d, id, code, { dryRun }));
export const markMovedLive = (id: string, opts: AdminOpts = {}): Promise<StepResult> => adminRun(id, opts.dryRun, (d, dryRun) => engine.markMoved(d, id, { dryRun }));
/** `by` is the admin's user id (the audit column). */
export const cancelLive = (id: string, opts: AdminOpts & { by?: string } = {}): Promise<StepResult> => adminRun(id, opts.dryRun, (d, dryRun) => engine.cancel(d, id, { dryRun, ...(opts.by ? { by: opts.by } : {}) }));
export const endOverlapNowLive = (id: string, opts: AdminOpts = {}): Promise<StepResult> => adminRun(id, opts.dryRun, (d, dryRun) => engine.endOverlapNow(d, id, { dryRun }));
export const startNewSetupLive = (id: string, opts: AdminOpts = {}): Promise<StepResult> => adminRun(id, opts.dryRun, (d, dryRun) => engine.startNewSetup(d, id, { dryRun }));
