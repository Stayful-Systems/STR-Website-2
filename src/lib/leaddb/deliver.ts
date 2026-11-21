/**
 * Getting a website lead into the operator's lead database account (Batch 32).
 *
 * Never inline with the landlord's request: the lead is already safely stored
 * and listed in SI Leads by the time anything reaches this queue, and the push
 * is the copy. It retries with the CRM's backoff (1 / 5 / 25 minutes, then
 * hourly, 6 attempts).
 *
 * The lead goes at step 1 (the report is "coming"); when its report is done it
 * goes again with the figures and the PDF under the same SI lead id, and the
 * lead database attaches the report to the SAME lead. Three retries therefore
 * keep one SI lead id and one leaddb_lead_id.
 *
 * ⚠️ `leads.status` and `leads.crm_pushed_at` mean "went to your CRM" and are
 * NEVER written here. This queue's own table (`leaddb_deliveries`) holds the
 * lead database's state. Nothing here is charged, counted or credited.
 *
 * ⚠️ NOTHING IN HERE LOGS A LEAD. Log lines carry a lead id and a code at
 * most, never a name, an address or a body.
 *
 * All outside effects arrive through `LeadDbDeps`, so the whole flow runs
 * under `node --test` with a fake store and a fake fetch. The real deps live
 * in store.ts (server-only) and are loaded lazily by the exported wrappers.
 */
import { nextAttemptAt } from '../crm/backoff.ts';
import { buildSummary, type ReportSummary } from '../websites/summary.ts';
import type { AnalysisResult } from '../types.ts';
import { leadDbPushLead, type LeadDbResult, type WebsiteLeadBody, type WebsiteLeadReply } from './client.ts';
import { buildPushBody, reportBlock } from './payload.ts';

/** A claimed push is held this long before it may be claimed again (a function killed at its limit frees it). */
export const LEASE_MS = 5 * 60 * 1000;

export interface DeliveryRow {
  lead_id: string;
  owner_id: string;
  attempts: number;
  lead_sent_at: string | null;
  report_sent_at: string | null;
  leaddb_lead_id: string | null;
}

export interface LeadContext {
  leadId: string;
  ownerId: string;
  status: string | null;
  archivedAt: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postcode: string | null;
  bedrooms: number | null;
  result: AnalysisResult | null;
  /** The website report's state and quality; null when this is not a website lead. */
  report: { state: string; qualityOk: boolean | null } | null;
  /**
   * Batch 35: the lead came from an operator's Facebook lead-form sheet (it has an
   * `ad_sheet_rows` row). It has no report, and goes to the lead database lead-only.
   * Optional: absent means false, so a website lead's context is unchanged.
   */
  sheetLead?: boolean;
}

export interface LinkState {
  ownerId: string;
  status: 'code_sent' | 'active' | 'revoked' | 'error';
}

export interface FinishPatch {
  status: 'pending' | 'sent' | 'failed';
  attempts?: number;
  next_attempt_at?: string;
  lead_sent_at?: string;
  report_sent_at?: string;
  leaddb_lead_id?: string;
  outcome?: string;
  last_error?: string | null;
}

export interface LeadDbStore {
  /** Claims one due pending row (lease), or null when someone else has it or it is not due. */
  claim(leadId: string, nowIso: string, leaseUntilIso: string): Promise<DeliveryRow | null>;
  context(leadId: string): Promise<LeadContext | null>;
  link(ownerId: string): Promise<LinkState | null>;
  finish(leadId: string, patch: FinishPatch, claimedAttempts: number): Promise<void>;
  /** Marks the owner's link errored (the other side said not_linked / no_product) or healthy again. */
  linkResult(ownerId: string, result: { ok: true } | { ok: false; code: string }): Promise<void>;
  due(limit: number, nowIso: string): Promise<DeliveryRow[]>;
  /**
   * Insert-if-missing a pending row; and, only when the report is done, re-pend a sent row still owed it.
   * Returns what happened. A failed row is left alone (admin Retry is the way back).
   */
  enqueue(leadId: string, ownerId: string, opts: { reportDone: boolean }): Promise<'inserted' | 'repended' | 'exists'>;
  /** Website leads of owners with an active link that have no delivery row (not held, not archived). */
  unqueued(limit: number): Promise<{ leadId: string; ownerId: string }[]>;
  /** Sent rows whose report is done but not yet sent. */
  reportsOwed(limit: number): Promise<{ leadId: string; ownerId: string }[]>;
}

export interface LeadDbDeps {
  store: LeadDbStore;
  post: (body: WebsiteLeadBody) => Promise<LeadDbResult<WebsiteLeadReply>>;
  /** The report PDF, or null when it could not be rendered (the lead then goes alone). */
  renderPdf: (ctx: LeadContext) => Promise<Uint8Array | null>;
  now: () => Date;
}

/** Recorded on a sent row whose report finished with no figures: there is nothing to send, so none is owed. */
export const NO_REPORT_FIGURES = 'no_report_figures';

/** Whether a result code means the link itself is the problem (shown on the connect screen). */
const LINK_CODES = new Set(['not_linked', 'no_product']);

/**
 * Runs one queued push, recording whatever happened. Returns null when the row
 * was not ours to run (not due, or someone else holds it).
 */
export async function runLeadDbDelivery(leadId: string, deps: LeadDbDeps): Promise<{ ok: boolean; code: string } | null> {
  const { store } = deps;
  const now = deps.now();
  const row = await store.claim(leadId, now.toISOString(), new Date(now.getTime() + LEASE_MS).toISOString());
  if (!row) return null;
  const attempts = row.attempts;

  const fail = async (code: string, retryable: boolean) => {
    const used = attempts + 1;
    const next = nextAttemptAt(used, retryable, now.getTime());
    await store.finish(
      leadId,
      {
        status: next === null ? 'failed' : 'pending',
        attempts: used,
        next_attempt_at: next ?? now.toISOString(),
        last_error: code,
      },
      attempts,
    );
    return { ok: false, code };
  };

  const ctx = await store.context(leadId);
  if (!ctx) return fail('lead_gone', false);
  if (ctx.archivedAt) return fail('archived', false);
  if (!ctx.report && !ctx.sheetLead) return fail('not_a_website_lead', false);
  if (ctx.status === 'held') {
    // The customer chose to review it first. Nothing is sent and no attempt is used; the next run looks again.
    await store.finish(leadId, { status: 'pending', next_attempt_at: new Date(now.getTime() + 60 * 60_000).toISOString() }, attempts);
    return { ok: true, code: 'held' };
  }
  if (ctx.ownerId !== row.owner_id) return fail('owner_mismatch', false);

  const link = await store.link(ctx.ownerId);
  if (!link || link.status !== 'active') return fail('not_linked', false);

  let report: WebsiteLeadBody['report'] | undefined;
  let summary: ReportSummary | null = null;
  const reportDue = ctx.report?.state === 'done' && row.report_sent_at === null && ctx.result !== null;
  if (reportDue && ctx.result) {
    summary = buildSummary(ctx.result, ctx.report?.qualityOk === true);
    if (summary) {
      let pdf: Uint8Array | null = null;
      try {
        pdf = await deps.renderPdf(ctx);
      } catch {
        // A failed render must not cost the operator the lead: it goes alone and the report is tried again.
        console.error('[leaddb] PDF render failed for lead', leadId);
      }
      report = reportBlock(summary, pdf);
    }
  }

  const body = buildPushBody({
    ownerId: ctx.ownerId,
    leadId,
    lead: { name: ctx.name, email: ctx.email, phone: ctx.phone, address: ctx.address, postcode: ctx.postcode, bedrooms: ctx.bedrooms },
    report,
  });
  let res = await deps.post(body);

  // The receiver refused the REPORT (bad PDF or figures), which fails the same way for ever. The lead itself
  // must not be lost to it: send it alone now, and leave the report owed (bounded like any other retry).
  if (!res.ok && res.code === 'bad_report' && report !== undefined) {
    report = undefined;
    res = await deps.post(
      buildPushBody({
        ownerId: ctx.ownerId,
        leadId,
        lead: { name: ctx.name, email: ctx.email, phone: ctx.phone, address: ctx.address, postcode: ctx.postcode, bedrooms: ctx.bedrooms },
        report: undefined,
      }),
    );
  }

  if (!res.ok || !res.data) {
    // Only the other side saying the link itself is wrong marks the link; a network blip says nothing about it.
    if (LINK_CODES.has(res.code)) await store.linkResult(ctx.ownerId, { ok: false, code: res.code }).catch(() => {});
    return fail(res.code, res.retryable);
  }

  const reply = res.data;
  const reportLanded = report !== undefined && (reply.report === 'attached' || reply.report === 'already_attached' || reply.report === 'kept_existing');
  // A report we owed but could not build (no figures yet, a PDF that failed) leaves the row owing it, so a later run retries.
  const stillOwed = reportDue && summary !== null && !reportLanded;
  const nowIso = now.toISOString();
  const retryAt = nextAttemptAt(attempts + 1, true, now.getTime());
  await store.finish(
    leadId,
    stillOwed
      ? {
          // The lead is in; only the report is owed. Bounded like any other retry: after six it is failed and visible.
          status: retryAt === null ? 'failed' : 'pending',
          attempts: attempts + 1,
          next_attempt_at: retryAt ?? nowIso,
          lead_sent_at: row.lead_sent_at ?? nowIso,
          leaddb_lead_id: reply.lead_id,
          outcome: reply.outcome,
          last_error: report === undefined ? 'report_not_sent' : 'report_not_attached',
        }
      : {
          status: 'sent',
          attempts: attempts + 1,
          next_attempt_at: nowIso,
          lead_sent_at: row.lead_sent_at ?? nowIso,
          ...(reportLanded ? { report_sent_at: nowIso } : {}),
          leaddb_lead_id: reply.lead_id,
          outcome: reply.outcome,
          // A report that finished with no figures has nothing to send. Say so, so the sweep does not owe it for ever.
          last_error: reportDue && summary === null ? NO_REPORT_FIGURES : null,
        },
    attempts,
  );
  await store.linkResult(ctx.ownerId, { ok: true }).catch(() => {});
  return { ok: true, code: 'ok' };
}

/**
 * Queues a push for a website lead. Called after a lead is saved (step 1) and
 * when its report is done. NEVER THROWS: the form route and the report run
 * call it fire-and-forget, and a failure here must cost the landlord nothing.
 *
 * Acts only for a website lead (it has a website report row) that is not held,
 * whose owner has an ACTIVE link. Anything else is a quiet no-op: plenty of
 * operators will never connect a lead database.
 */
export async function enqueueLeadDbPush(leadId: string, deps?: LeadDbDeps): Promise<'queued' | 'skipped'> {
  try {
    const d = deps ?? (await realDeps());
    const ctx = await d.store.context(leadId);
    if (!ctx || (!ctx.report && !ctx.sheetLead) || ctx.archivedAt || ctx.status === 'held') return 'skipped';
    const link = await d.store.link(ctx.ownerId);
    if (!link || link.status !== 'active') return 'skipped';
    await d.store.enqueue(leadId, ctx.ownerId, { reportDone: ctx.report?.state === 'done' });
    return 'queued';
  } catch {
    console.error('[leaddb] enqueue failed for lead', leadId);
    return 'skipped';
  }
}

export interface LeadDbSweepSummary {
  enqueued: number;
  /** Dry run: what would be queued (ids only). */
  would?: { leadId: string; ownerId: string }[];
}

/** The safety net: queues website leads of linked owners that have no row, and sent rows owed a finished report. */
export async function sweepLeadDbDeliveries(limit = 50, opts: { dry?: boolean } = {}, deps?: LeadDbDeps): Promise<LeadDbSweepSummary> {
  try {
    const d = deps ?? (await realDeps());
    const fresh = (await d.store.unqueued(limit)).map((f) => ({ ...f, reportDone: false }));
    const owed = (await d.store.reportsOwed(limit)).map((f) => ({ ...f, reportDone: true }));
    const found = [...fresh, ...owed];
    if (opts.dry) return { enqueued: 0, would: found.map(({ leadId, ownerId }) => ({ leadId, ownerId })) };
    let enqueued = 0;
    for (const f of found) {
      const r = await d.store.enqueue(f.leadId, f.ownerId, { reportDone: f.reportDone });
      if (r !== 'exists') enqueued += 1;
    }
    return { enqueued };
  } catch {
    console.error('[leaddb] sweep failed');
    return { enqueued: 0 };
  }
}

export interface LeadDbDrainSummary {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  due?: { lead_id: string; attempts: number }[];
}

/** Drains what is due, sequentially (each may render a PDF), inside a time budget. `dry` lists ids and sends nothing. */
export async function drainLeadDbDeliveries(
  limit = 10,
  opts: { dry?: boolean; budgetMs?: number } = {},
  deps?: LeadDbDeps,
): Promise<LeadDbDrainSummary> {
  const none: LeadDbDrainSummary = { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  let d: LeadDbDeps;
  try {
    d = deps ?? (await realDeps());
  } catch {
    return none;
  }
  const started = Date.now();
  const due = await d.store.due(limit, d.now().toISOString());
  if (opts.dry) return { ...none, due: due.map((r) => ({ lead_id: r.lead_id, attempts: r.attempts })) };

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of due) {
    if (Date.now() - started > (opts.budgetMs ?? 40_000)) {
      skipped += 1;
      continue;
    }
    const result = await runLeadDbDelivery(r.lead_id, d);
    if (result?.ok) sent += 1;
    else failed += 1;
  }
  return { attempted: due.length - skipped, sent, failed, skipped };
}

async function realDeps(): Promise<LeadDbDeps> {
  const { supabaseDeps } = await import('./store');
  return supabaseDeps();
}

export { leadDbPushLead };
