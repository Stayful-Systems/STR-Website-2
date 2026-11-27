/**
 * Getting a calculator lead into the customer's lead database account as an `si_ad` lead (Batch 55 step 2, contract
 * section 10). The Batch 32 website push (deliver.ts) never sends these: it fails them with `calculator_site`.
 *
 * Never inline with the landlord's request: the lead is already stored and listed in SI Leads, and this queue
 * (`leaddb_ad_deliveries`, one row per lead) is the copy. The cron (/api/internal/leaddb-deliveries) drains it with the
 * CRM's backoff (1 / 5 / 25 minutes, then hourly, 6 attempts).
 *
 * The phases, under one `si_lead_id`:
 *   1. `lead`           the landlord's details and the ad tag (read at send time from ad_pack_lead_links).
 *   2. `report`         when website_reports.state = 'done': the figures, the PDF, `low_data`, and the billing fields.
 *      `report_failed`  when website_reports.state = 'failed' (no figures at all): the billing fields, never billable.
 *   A 409 `no_lead` (the report arrived before LD holds the lead) resets the row to send `lead` first, then the report.
 *
 * Billing is decided ONCE, the first time a report phase is built (`adBilling`), and frozen on the row
 * (billable, billable_reason, low_data, repeat_of_lead_id), so every retry sends the same answer. A test lead (the
 * owner trying their own calculator, website_reports.self_submit) is still sent, with `is_test: true` on every phase.
 * The stop rule and the unpaid hold are NOT checked here: SI stops the page and the lead API, and a lead that exists, or
 * a report that finished, is delivered and charged (rule 19).
 *
 * ⚠️ `leads.status` and `leads.crm_pushed_at` mean "went to your CRM" and are NEVER written here.
 * ⚠️ NOTHING IN HERE LOGS A LEAD. Log lines carry a lead id and a code at most.
 *
 * All outside effects arrive through `AdDeliverDeps`, so the flow runs under `node --test` with a fake store and a
 * fake post. The real deps live in ad-store.ts (server-only), loaded lazily.
 */
import { nextAttemptAt } from '../crm/backoff.ts';
import { buildSummary } from '../websites/summary.ts';
import type { AnalysisResult } from '../types.ts';
import type { LandlordLeadRow } from '../leads/dedupe.ts';
import type { LeadDbResult } from './client.ts';
import {
  REPEAT_WINDOW_DAYS,
  adBilling,
  adLeadRetryable,
  adReportBlock,
  adTag,
  billingAgrees,
  buildAdLeadPhase,
  buildAdReportPhase,
  packNoticeOutcome,
  pickRepeat,
  type AdLeadBody,
  type AdLinkFacts,
  type AdPhase,
  type BillableReason,
} from './ad-payload.ts';

/** A claimed push is held this long before it may be claimed again (a function killed at its limit frees it). */
export const AD_LEASE_MS = 5 * 60 * 1000;

export interface AdDeliveryRow {
  lead_id: string;
  owner_id: string;
  ld_customer_id: string;
  attempts: number;
  phase_sent: AdPhase | null;
  billable: boolean | null;
  billable_reason: BillableReason | null;
  low_data: boolean | null;
  repeat_of_lead_id: string | null;
}

export interface AdLeadContext {
  leadId: string;
  ownerId: string;
  createdAt: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postcode: string | null;
  bedrooms: number | null;
  result: AnalysisResult | null;
  /** The lead's report came from a calculator site (websites.mode = 'calculator'). */
  calculator: boolean;
  /** The website report row, or null. */
  report: { state: string; qualityOk: boolean | null; selfSubmit: boolean; completedAt: string | null } | null;
}

export interface AdFinishPatch {
  status: 'pending' | 'sent' | 'failed';
  attempts?: number;
  next_attempt_at?: string;
  phase_sent?: AdPhase | null;
  outcome?: string;
  last_error?: string | null;
}

export interface FrozenAdBilling {
  billable: boolean;
  billable_reason: BillableReason;
  low_data: boolean;
  repeat_of_lead_id: string | null;
}

export interface AdStore {
  /** Claims one due pending row (lease), or null when someone else has it or it is not due. */
  claim(leadId: string, nowIso: string, leaseUntilIso: string): Promise<AdDeliveryRow | null>;
  context(leadId: string): Promise<AdLeadContext | null>;
  /** The owner's lead database customer id, or null when the owner has no ad account. */
  account(ownerId: string): Promise<{ ldCustomerId: string } | null>;
  /** The lead's ad tag facts, or null when no link row exists. */
  adLink(leadId: string): Promise<AdLinkFacts | null>;
  /** The owner's ad leads (rows of this queue) created at or after `sinceIso`, with their landlord keys. */
  adLeadRows(ownerId: string, sinceIso: string): Promise<LandlordLeadRow[]>;
  /** Writes the billing fields only while they are still null. Returns the values now on the row. */
  freezeBilling(leadId: string, billing: FrozenAdBilling): Promise<FrozenAdBilling | null>;
  finish(leadId: string, patch: AdFinishPatch, claimedAttempts: number): Promise<void>;
  due(limit: number, nowIso: string): Promise<AdDeliveryRow[]>;
  /**
   * Insert-if-missing a pending row; and, only when the report is final (done or failed), re-pend a sent row whose
   * report phase is still owed. A failed row is left alone.
   */
  enqueue(leadId: string, ownerId: string, ldCustomerId: string, opts: { reportFinal: boolean }): Promise<'inserted' | 'repended' | 'exists'>;
  /** Calculator leads of owners with an ad account that have no row, and sent rows owed a finished report. */
  sweep(limit: number): Promise<{ leadId: string; ownerId: string; ldCustomerId: string; reportFinal: boolean }[]>;
  /** Owners whose "first ad pack made" call is pending. */
  pendingPackNotices(limit: number): Promise<{ ownerId: string; ldCustomerId: string }[]>;
  /** Clears the pending flag: 'done' also stamps pack_notice_sent_at. */
  packNoticeResult(ownerId: string, outcome: 'done' | 'final'): Promise<void>;
}

export interface AdDeliverDeps {
  store: AdStore;
  post: (body: AdLeadBody) => Promise<LeadDbResult<{ ok: true; code?: string; lead_id?: string }>>;
  postPackNotice: (body: { ld_customer_id: string }) => Promise<LeadDbResult<{ ok: true; code?: string }>>;
  /** The report PDF, or null when it could not be rendered. */
  renderPdf: (ctx: AdLeadContext) => Promise<Uint8Array | null>;
  now: () => Date;
}

const FINAL_REPORT_STATES = new Set(['done', 'failed']);

/** The report phase this context is owed now, or null while the report is not final. */
export function reportPhaseFor(ctx: Pick<AdLeadContext, 'report'>): 'report' | 'report_failed' | null {
  if (ctx.report?.state === 'done') return 'report';
  if (ctx.report?.state === 'failed') return 'report_failed';
  return null;
}

/**
 * Runs one queued push, recording whatever happened. Returns null when the row was not ours to run (not due, or
 * someone else holds it).
 */
export async function runAdDelivery(leadId: string, deps: AdDeliverDeps): Promise<{ ok: boolean; code: string } | null> {
  const { store } = deps;
  const now = deps.now();
  const nowIso = now.toISOString();
  const row = await store.claim(leadId, nowIso, new Date(now.getTime() + AD_LEASE_MS).toISOString());
  if (!row) return null;
  const attempts = row.attempts;

  const fail = async (code: string, retryable: boolean, phaseSent?: AdPhase | null) => {
    const used = attempts + 1;
    const next = nextAttemptAt(used, retryable, now.getTime());
    await store.finish(
      leadId,
      {
        status: next === null ? 'failed' : 'pending',
        attempts: used,
        next_attempt_at: next ?? nowIso,
        last_error: code,
        ...(phaseSent !== undefined ? { phase_sent: phaseSent } : {}),
      },
      attempts,
    );
    return { ok: false, code };
  };

  const ctx = await store.context(leadId);
  if (!ctx) return fail('lead_gone', false);
  if (!ctx.calculator) return fail('not_calculator', false);
  if (ctx.ownerId !== row.owner_id) return fail('owner_mismatch', false);
  const isTest = ctx.report?.selfSubmit === true;
  const lead = { name: ctx.name, email: ctx.email, phone: ctx.phone, address: ctx.address, postcode: ctx.postcode, bedrooms: ctx.bedrooms };

  let phaseSent: AdPhase | null = row.phase_sent;
  let lastCode = 'ok';
  // At most: lead, report, then (after a 409 no_lead) lead and report once more.
  let resentLead = false;
  for (let step = 0; step < 4; step += 1) {
    if (phaseSent === 'report' || phaseSent === 'report_failed') break;

    if (phaseSent === null) {
      const tag = adTag(await store.adLink(leadId));
      const res = await deps.post(buildAdLeadPhase({ ldCustomerId: row.ld_customer_id, leadId, isTest, tag, lead }));
      if (!res.ok) return fail(res.code, adLeadRetryable(res.status, res.code), null);
      phaseSent = 'lead';
      lastCode = typeof res.data?.code === 'string' ? res.data.code : 'ok';
      continue;
    }

    // phaseSent === 'lead': the report phase, once the report is final.
    const phase = reportPhaseFor(ctx);
    if (!phase) break;

    // Billing: frozen on the row the first time; every later attempt sends exactly the same.
    let billing: FrozenAdBilling | null =
      row.billable !== null && row.billable_reason !== null
        ? { billable: row.billable, billable_reason: row.billable_reason, low_data: row.low_data === true, repeat_of_lead_id: row.repeat_of_lead_id }
        : null;
    if (!billing) {
      const since = new Date(Date.parse(ctx.createdAt) - REPEAT_WINDOW_DAYS * 86_400_000).toISOString();
      const repeatOf = phase === 'report' ? pickRepeat(await store.adLeadRows(ctx.ownerId, since), { id: leadId, createdAt: ctx.createdAt, postcode: ctx.postcode, email: ctx.email, phone: ctx.phone }) : null;
      const b = adBilling({ isTest, phase, qualityOk: ctx.report?.qualityOk ?? null, repeat: repeatOf !== null });
      billing = (await store.freezeBilling(leadId, { billable: b.billable, billable_reason: b.reason, low_data: b.lowData, repeat_of_lead_id: repeatOf })) ?? null;
      if (!billing) return fail('billing_not_frozen', true, phaseSent);
      row.billable = billing.billable;
      row.billable_reason = billing.billable_reason;
      row.low_data = billing.low_data;
      row.repeat_of_lead_id = billing.repeat_of_lead_id;
    }
    if (!billingAgrees(isTest, billing.billable, billing.billable_reason)) return fail('billing_disagrees', false, phaseSent);

    let report: ReturnType<typeof adReportBlock> = undefined;
    if (phase === 'report') {
      const summary = ctx.result ? buildSummary(ctx.result, ctx.report?.qualityOk === true) : null;
      if (!summary) return fail('report_not_ready', true, phaseSent);
      let pdf: Uint8Array | null = null;
      try {
        pdf = await deps.renderPdf(ctx);
      } catch {
        console.error('[leaddb-ad] PDF render failed for lead', leadId);
      }
      report = adReportBlock(summary, pdf, billing.low_data);
      if (!report) return fail('pdf_not_ready', true, phaseSent);
    }

    const res = await deps.post(
      buildAdReportPhase({
        ldCustomerId: row.ld_customer_id,
        leadId,
        isTest,
        phase,
        report,
        billable: billing.billable,
        billableReason: billing.billable_reason,
        repeatOfLeadId: billing.repeat_of_lead_id,
        reportAttachedAt: ctx.report?.completedAt ?? nowIso,
        lead,
      }),
    );
    if (!res.ok) {
      if (res.status === 409 && res.code === 'no_lead' && !resentLead) {
        // LD does not hold the lead phase: send it first, then the report again.
        resentLead = true;
        phaseSent = null;
        continue;
      }
      return fail(res.code, res.status === 409 && res.code === 'no_lead' ? true : adLeadRetryable(res.status, res.code), phaseSent);
    }
    phaseSent = phase;
    lastCode = typeof res.data?.code === 'string' ? res.data.code : 'ok';
  }

  await store.finish(
    leadId,
    { status: 'sent', attempts: attempts + 1, next_attempt_at: nowIso, phase_sent: phaseSent, outcome: lastCode, last_error: null },
    attempts,
  );
  return { ok: true, code: lastCode };
}

/**
 * Queues the push for a calculator lead. Called after step 1 is saved, when the report is done, and when the report
 * fails for good. NEVER THROWS: the form route and the report run call it fire-and-forget.
 *
 * Acts only for a lead of a calculator site whose owner has a lead database ad account. Anything else is a quiet no-op.
 */
export async function enqueueAdLeadPush(leadId: string, deps?: AdDeliverDeps): Promise<'queued' | 'skipped'> {
  try {
    const d = deps ?? (await realDeps());
    const ctx = await d.store.context(leadId);
    if (!ctx || !ctx.calculator) return 'skipped';
    const account = await d.store.account(ctx.ownerId);
    if (!account) return 'skipped';
    await d.store.enqueue(leadId, ctx.ownerId, account.ldCustomerId, { reportFinal: FINAL_REPORT_STATES.has(ctx.report?.state ?? '') });
    return 'queued';
  } catch {
    console.error('[leaddb-ad] enqueue failed for lead', leadId);
    return 'skipped';
  }
}

export interface AdDrainSummary {
  swept: number;
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  packNotices: { sent: number; final: number; retry: number };
  due?: { lead_id: string; attempts: number; phase_sent: AdPhase | null }[];
  wouldSweep?: { leadId: string; ownerId: string }[];
  wouldNotify?: string[];
}

/**
 * The ad lead run: the sweep (lost enqueues, finished reports not yet sent), the drain inside a time budget, then the
 * pending "first ad pack made" calls. `dry` lists ids and sends and queues nothing.
 */
export async function drainAdLeadDeliveries(
  limit = 10,
  opts: { dry?: boolean; budgetMs?: number } = {},
  deps?: AdDeliverDeps,
): Promise<AdDrainSummary> {
  const none: AdDrainSummary = { swept: 0, attempted: 0, sent: 0, failed: 0, skipped: 0, packNotices: { sent: 0, final: 0, retry: 0 } };
  let d: AdDeliverDeps;
  try {
    d = deps ?? (await realDeps());
  } catch {
    return none;
  }
  const started = Date.now();
  const budget = opts.budgetMs ?? 15_000;
  try {
    const found = await d.store.sweep(50);
    const due = await d.store.due(limit, d.now().toISOString());
    const notices = await d.store.pendingPackNotices(20);
    if (opts.dry) {
      return {
        ...none,
        due: due.map((r) => ({ lead_id: r.lead_id, attempts: r.attempts, phase_sent: r.phase_sent })),
        wouldSweep: found.map(({ leadId, ownerId }) => ({ leadId, ownerId })),
        wouldNotify: notices.map((n) => n.ownerId),
      };
    }
    let swept = 0;
    for (const f of found) {
      const r = await d.store.enqueue(f.leadId, f.ownerId, f.ldCustomerId, { reportFinal: f.reportFinal });
      if (r !== 'exists') swept += 1;
    }
    // Rows the sweep just queued are due now: read again so they go this run.
    const toRun = swept > 0 ? await d.store.due(limit, d.now().toISOString()) : due;
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const r of toRun) {
      if (Date.now() - started > budget) {
        skipped += 1;
        continue;
      }
      const result = await runAdDelivery(r.lead_id, d);
      if (result?.ok) sent += 1;
      else failed += 1;
    }
    const packNotices = { sent: 0, final: 0, retry: 0 };
    for (const n of notices) {
      if (Date.now() - started > budget) break;
      const res = await d.postPackNotice({ ld_customer_id: n.ldCustomerId });
      const outcome = packNoticeOutcome(res);
      if (outcome === 'retry') {
        packNotices.retry += 1;
        continue;
      }
      await d.store.packNoticeResult(n.ownerId, outcome);
      if (outcome === 'done') packNotices.sent += 1;
      else packNotices.final += 1;
    }
    return { swept, attempted: toRun.length - skipped, sent, failed, skipped, packNotices };
  } catch {
    console.error('[leaddb-ad] drain failed');
    return none;
  }
}

async function realDeps(): Promise<AdDeliverDeps> {
  const { supabaseAdDeps } = await import('./ad-store');
  return supabaseAdDeps();
}
