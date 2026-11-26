import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { reserveAnalysis, runAnalysis, type AnalysisRunOptions } from '../analysis/run';
import { analysisComplete } from '../analysis/reuse';
import type { AnalysisInput } from '../analysis/input';
import { InsufficientCreditError, faceAvailableFor } from '../credit/ledger';
import { isTrustworthyReport } from '../market/quality';
import { completeLead } from '../leads/store';
import { enqueueLeadDbPush } from '../leaddb/deliver';
import { parseLeadRules } from '../leads/rules';
import type { AnalysisResult } from '../types';
import { readWebsiteSettings } from './store-server';
import { CALCULATOR_BILLING, isCalculatorMode } from './calculator';
import { notifyOperatorOfWebsiteLead, notifyOperatorReportFailed, sendLandlordEmail } from './notify-server';
import { buildSummary, type ReportSummary } from './summary';
import {
  MAX_REPORT_ATTEMPTS,
  chargeDecision,
  claimOutcome,
  decideStep2,
  freezeMode,
  landlordOutcome,
  nextDay,
  qualityOk,
  staleLeaseAction,
} from './policy';
import type { BillingMode, ClaimResult, FrozenBilling, LandlordOutcome, ReportState } from './types';

/**
 * Batch 31: runs the income report for a customer website's lead.
 *
 * `runWebsiteReport(leadId)` is the one entry. The step-2 route calls it once
 * the landlord's address is saved; the held-report cron calls it for due held
 * reports and stale leases. Every rule is policy.ts's: this gathers the facts,
 * asks, and acts.
 *
 *  1. The report row (website_reports) says where the report is. Only a row
 *     awaiting its address, held (cap or credit), or running on a lease that
 *     has run out is runnable; anything else just reports its state.
 *  2. The billing mode and price are FROZEN on the row at step 2 and read
 *     from there on every retry (policy.freezeMode / decideStep2).
 *       free      a self-submit is held without running (held_self). Otherwise
 *                 website_free_report_claim: claimed / already -> run;
 *                 site_full / day_full -> held_cap, due the next UK day.
 *       charged   the owner's balance covers the price -> run; short ->
 *                 held_credit.
 *  3. A lease is taken with a conditional update (state and attempts must
 *     still be what was read): running, lease_until, attempts + 1. Two callers
 *     cannot both run one report. A failed run releases its lease for the cron
 *     until the third attempt, then the report is failed.
 *  4. The run is reserveAnalysis / runAnalysis.
 *       free      billedUserId: null (house spend, never debits anyone)
 *       charged   fixedPrice + reserveBasePence: every call is logged, nothing
 *                 is debited per call
 *  5. After finish(), and only when charged and the report is quality OK,
 *     website_report_charge charges the owner once (never with the run's
 *     action id). A low-quality or failed report is never charged.
 *  6. completeLead(..., emailProspect:false): the lead gets its report and the
 *     CRM delivery, but the landlord is NOT emailed a /r link. Their own email
 *     is the figures-only summary from notify-server. A website lead is never
 *     'queued'.
 *  7. quality_ok and state 'done' are stored, then the landlord's email goes.
 *
 * Batch 55 (Part A): a CALCULATOR site (websites.mode = 'calculator') runs the same report but is
 * not billed here. It skips the free-report claim (so never held_cap), decideStep2 (so never
 * held_credit, and no held_self: the owner may try their own calculator) and chargeReport; the
 * run is house-paid (billedUserId null) and the billing mode is frozen as 'free' at 0p. The lead
 * database bills these reports later (Phase 2). A site-mode report is exactly as above. The stop
 * rule (a stopped owner) is NOT checked here: a report already running must finish, so this file
 * never reads the ad account (a test pins it).
 *
 * What comes back is a small state object: never the result, never an address.
 * Nothing here logs a lead's details; log lines carry the lead id and an error
 * name only.
 */

/** A running report holds its lease this long; the cron takes it over after. */
export const REPORT_LEASE_MS = 5 * 60 * 1000;

const UUID = /^[0-9a-f-]{36}$/i;

export interface WebsiteReportState {
  state: ReportState;
  /** What the landlord is shown (policy.landlordOutcome). 'will_contact' for anything unfinished. */
  outcome: LandlordOutcome;
  /** A held_cap report runs on or after this UK day (YYYY-MM-DD). */
  dueDay: string | null;
  qualityOk: boolean | null;
  /** The headline figures when the report is done and has them; otherwise null. Never an address. */
  summary: ReportSummary | null;
}

interface ReportRow {
  leadId: string;
  websiteId: string;
  state: ReportState;
  billingMode: BillingMode | null;
  pricePence: number | null;
  dueDay: string | null;
  leaseUntil: string | null;
  attempts: number;
  qualityOk: boolean | null;
  selfSubmit: boolean;
}

interface RunContext {
  report: ReportRow;
  ownerId: string;
  /** websites.mode of the report's site: 'calculator' skips the claim, the credit hold and the charge. */
  siteMode: string | null;
  funnelId: string;
  /** The landlord's property, as step 2 stored it. Null until step 2 has saved it. */
  input: AnalysisInput | null;
  rulesRaw: unknown;
  unqualifiedPolicy: 'crm_flagged' | 'hold';
}

type Admin = ReturnType<typeof createAdminClient>;

const REPORT_COLUMNS = 'lead_id, website_id, state, billing_mode, price_pence, due_day, lease_until, attempts, quality_ok, self_submit';

function toReport(r: Record<string, unknown>): ReportRow {
  return {
    leadId: String(r.lead_id),
    websiteId: String(r.website_id),
    state: r.state as ReportState,
    billingMode: r.billing_mode === 'free' || r.billing_mode === 'charged' ? r.billing_mode : null,
    pricePence: typeof r.price_pence === 'number' ? r.price_pence : null,
    dueDay: typeof r.due_day === 'string' ? r.due_day : null,
    leaseUntil: typeof r.lease_until === 'string' ? r.lease_until : null,
    attempts: Number(r.attempts) || 0,
    qualityOk: typeof r.quality_ok === 'boolean' ? r.quality_ok : null,
    selfSubmit: r.self_submit === true,
  };
}

async function loadContext(admin: Admin, leadId: string): Promise<RunContext | null> {
  const { data: rep, error } = await admin.from('website_reports').select(REPORT_COLUMNS).eq('lead_id', leadId).maybeSingle();
  if (error || !rep) return null;
  const report = toReport(rep as Record<string, unknown>);

  const { data: site } = await admin.from('websites').select('user_id, funnel_id, mode').eq('id', report.websiteId).maybeSingle();
  if (!site) return null;
  const { user_id: ownerId, funnel_id: funnelId, mode: siteMode } = site as { user_id: string; funnel_id: string; mode?: string | null };

  // The lead must be this website's own: its owner and its funnel.
  const [{ data: lead }, { data: funnel }] = await Promise.all([
    admin.from('leads').select('id, input').eq('id', leadId).eq('user_id', ownerId).eq('funnel_id', funnelId).maybeSingle(),
    admin.from('funnels').select('lead_rules, unqualified_policy').eq('id', funnelId).eq('user_id', ownerId).maybeSingle(),
  ]);
  if (!lead) return null;
  const input = (lead as { input?: unknown }).input;
  const f = funnel as { lead_rules?: unknown; unqualified_policy?: string } | null;
  return {
    report,
    ownerId,
    siteMode: siteMode ?? null,
    funnelId,
    input: input && typeof input === 'object' ? (input as AnalysisInput) : null,
    rulesRaw: f?.lead_rules ?? null,
    unqualifiedPolicy: f?.unqualified_policy === 'hold' ? 'hold' : 'crm_flagged',
  };
}

// ── State ──

function stateOf(r: Pick<ReportRow, 'state' | 'dueDay' | 'qualityOk'>, summary: ReportSummary | null): WebsiteReportState {
  return {
    state: r.state,
    outcome: landlordOutcome({ state: r.state, quality: r.qualityOk, hasFigures: summary !== null }),
    dueDay: r.state === 'held_cap' ? r.dueDay : null,
    qualityOk: r.qualityOk,
    summary,
  };
}

/** The summary of a finished report, built from the lead's stored result: headline figures only. */
async function summaryFor(admin: Admin, leadId: string, ownerId: string, quality: boolean | null): Promise<ReportSummary | null> {
  const { data } = await admin.from('leads').select('result').eq('id', leadId).eq('user_id', ownerId).maybeSingle();
  const result = (data as { result?: AnalysisResult | null } | null)?.result;
  return result ? buildSummary(result, quality === true) : null;
}

/** Where a report is now, for a resubmit or a poll. Null when there is no such report. */
export async function currentReportState(leadId: string): Promise<WebsiteReportState | null> {
  if (!hasServiceRole() || !UUID.test(leadId)) return null;
  const admin = createAdminClient();
  const ctx = await loadContext(admin, leadId);
  if (!ctx) return null;
  const summary = ctx.report.state === 'done' ? await summaryFor(admin, leadId, ctx.ownerId, ctx.report.qualityOk) : null;
  return stateOf(ctx.report, summary);
}

/** Today in the UK, from the database (website_uk_day): the app never works the day out itself. */
async function ukToday(admin: Admin): Promise<string> {
  const { data, error } = await admin.rpc('website_uk_day');
  if (!error && typeof data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data)) return data;
  // The database could not say: the same day from the clock, in London time.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ── Conditional writes ──

const RUNNABLE_FROM: readonly ReportState[] = ['awaiting_address', 'held_cap', 'held_credit'];

/** Holds a report (held_self / held_cap / held_credit). Wins only if the row is still as read. */
async function hold(admin: Admin, r: ReportRow, to: 'held_self' | 'held_cap' | 'held_credit', frozen: FrozenBilling, dueDay: string | null, nowIso: string): Promise<boolean> {
  // Still exactly as read: same state and attempts (and, for a running one, still past its lease).
  let q = admin
    .from('website_reports')
    .update({ state: to, billing_mode: frozen.billingMode, price_pence: frozen.pricePence, due_day: dueDay, lease_until: null, updated_at: nowIso })
    .eq('lead_id', r.leadId)
    .eq('state', r.state)
    .eq('attempts', r.attempts);
  if (r.state === 'running') q = q.lt('lease_until', nowIso);
  const { data, error } = await q.select('lead_id');
  if (error) {
    console.error(`[website-report] hold failed for lead ${r.leadId}:`, error.message);
    return false;
  }
  return (data ?? []).length > 0;
}

/**
 * Takes the lease: running, lease_until, attempts + 1, the frozen billing mode
 * and price. Conditional on the row being as read, so only one caller wins.
 */
async function takeLease(admin: Admin, r: ReportRow, frozen: FrozenBilling, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  let q = admin
    .from('website_reports')
    .update({
      state: 'running',
      billing_mode: frozen.billingMode,
      price_pence: frozen.pricePence,
      lease_until: new Date(now.getTime() + REPORT_LEASE_MS).toISOString(),
      attempts: r.attempts + 1,
      updated_at: nowIso,
    })
    .eq('lead_id', r.leadId)
    .eq('state', r.state)
    .eq('attempts', r.attempts);
  if (r.state === 'running') q = q.lt('lease_until', nowIso);
  const { data, error } = await q.select('lead_id');
  if (error) {
    console.error(`[website-report] lease failed for lead ${r.leadId}:`, error.message);
    return false;
  }
  return (data ?? []).length > 0;
}

/** Ends a lease we hold: only while the row is still running at the attempt we took. */
async function endRun(admin: Admin, leadId: string, attempt: number, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await admin
    .from('website_reports')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('lead_id', leadId)
    .eq('state', 'running')
    .eq('attempts', attempt)
    .select('lead_id');
  if (error) {
    console.error(`[website-report] update failed for lead ${leadId}:`, error.message);
    return false;
  }
  return (data ?? []).length > 0;
}

// ── The run's options ──

/**
 * How the run is paid for. Free: house spend, billedUserId null, nothing is
 * ever debited. Charged: the owner's reservation at the frozen price, every
 * call logged and none debited (fixedPrice); the one charge comes after the run.
 */
function runOptionsFor(frozen: FrozenBilling, ownerId: string, funnelId: string): AnalysisRunOptions {
  return frozen.billingMode === 'charged'
    ? { billedUserId: ownerId, fixedPrice: true, reserveBasePence: frozen.pricePence, requireCredit: true, funnelId }
    : { billedUserId: null, funnelId };
}

/**
 * The one place a website report is charged: website_report_charge, once per
 * lead (its guard row), never with the run's action id. Records "unpaid" instead
 * of raising when the balance is short, and never loses the landlord's summary:
 * a failure here is logged and the report still goes out.
 */
async function chargeReport(admin: Admin, o: { ownerId: string; leadId: string; websiteId: string; pence: number }): Promise<void> {
  try {
    const { error } = await admin.rpc('website_report_charge', {
      p: { owner: o.ownerId, lead: o.leadId, website: o.websiteId, pence: o.pence, meta: {} },
    });
    if (error) console.error(`[website-report] charge failed for lead ${o.leadId}:`, error.message);
  } catch (err) {
    console.error(`[website-report] charge failed for lead ${o.leadId}:`, err instanceof Error ? err.name : 'error');
  }
}

// ── The run ──

export interface RunWebsiteReportOptions {
  /** Progress text for the step-2 stream. Stage, percentage and message only. */
  onProgress?: AnalysisRunOptions['onProgress'];
}

/**
 * Runs, holds or reports on the website lead's income report. Returns the small
 * state object, or null when there is no such report (or no database). Safe to
 * call twice, and from the route and the cron at once: the conditional lease
 * lets only one run it, and the other reads the state back.
 */
export async function runWebsiteReport(leadId: string, opts: RunWebsiteReportOptions = {}): Promise<WebsiteReportState | null> {
  if (!hasServiceRole() || !UUID.test(leadId)) return null;
  const admin = createAdminClient();
  const ctx = await loadContext(admin, leadId);
  if (!ctx) return null;
  const { report } = ctx;
  const now = new Date();
  const nowIso = now.toISOString();

  const staleRunning = report.state === 'running' && (report.leaseUntil === null || Date.parse(report.leaseUntil) < now.getTime());
  const runnable = RUNNABLE_FROM.includes(report.state) || staleRunning;
  if (!runnable) {
    // Done, failed, expired, held for being a self-submit, or somebody else is running it.
    const summary = report.state === 'done' ? await summaryFor(admin, leadId, ctx.ownerId, report.qualityOk) : null;
    return stateOf(report, summary);
  }

  // Step 2 has not saved the property yet: nothing to run, nothing changes.
  if (!ctx.input) return stateOf(report, null);

  // A running report whose lease has run out: give up after the third attempt.
  if (staleRunning && staleLeaseAction(report.attempts) === 'fail') {
    return giveUp(admin, ctx, report.attempts, nowIso);
  }

  const today = await ukToday(admin);
  // A held report runs on or after its due day, not before.
  if (report.state === 'held_cap' && report.dueDay && report.dueDay > today) return stateOf(report, null);

  // ── The decision: what the frozen billing mode says to do ──
  const calculator = isCalculatorMode(ctx.siteMode);
  const firstTime = report.state === 'awaiting_address';
  let frozen: FrozenBilling;
  if (calculator) {
    // Batch 55: no free claim, no held_cap, no decideStep2, no held_credit, no charge. Free at 0p, house-paid, always runs.
    frozen = CALCULATOR_BILLING;
  } else {
    const settings = await readWebsiteSettings();
    const existing: FrozenBilling | null = report.billingMode ? { billingMode: report.billingMode, pricePence: report.pricePence ?? 0 } : null;
    const mode = freezeMode(settings, existing);
    let balancePence: number | null = null;
    if (mode.billingMode === 'charged') balancePence = await faceAvailableFor(ctx.ownerId, 'website_report').catch(() => null);
    const decision = decideStep2({ frozen: existing, settings, selfSubmit: report.selfSubmit, balancePence });

    if (decision.kind === 'hold') {
      // held_self: saved and flagged, NOT run. held_credit: waits for credit.
      const won = await hold(admin, report, decision.state, decision.frozen, null, nowIso);
      const after: ReportRow = { ...report, state: won ? decision.state : report.state, dueDay: null };
      if (won && firstTime) {
        await sendLandlordEmail({ leadId, kind: 'will_contact' });
        await notifyOperatorOfWebsiteLead({ leadId, websiteId: report.websiteId });
      }
      return stateOf(won ? after : await reread(admin, ctx), null);
    }

    frozen = decision.frozen;
    if (decision.kind === 'claim') {
      // Free: one of today's slots. Held reports (the cron) need used < limit; live ones also leave room for the backlog.
      const { data, error } = await admin.rpc('website_free_report_claim', { p_lead: leadId, p_website: report.websiteId, p_held: report.state === 'held_cap' });
      // A claim that cannot be answered counts as full: nothing is spent, the cron tries tomorrow.
      const claim: ClaimResult = !error && (data === 'claimed' || data === 'already' || data === 'site_full' || data === 'day_full') ? data : 'day_full';
      if (error) console.error(`[website-report] claim failed for lead ${leadId}:`, error.message);
      const out = claimOutcome(claim);
      if (out.kind === 'hold') {
        const dueDay = nextDay(today);
        const won = await hold(admin, report, out.state, frozen, dueDay, nowIso);
        if (won && firstTime) {
          await sendLandlordEmail({ leadId, kind: 'held' });
          await notifyOperatorOfWebsiteLead({ leadId, websiteId: report.websiteId });
        }
        return stateOf(won ? { ...report, state: out.state, dueDay } : await reread(admin, ctx), null);
      }
    }
  }

  // ── The lease ──
  if (!(await takeLease(admin, report, frozen, now))) return stateOf(await reread(admin, ctx), null);
  const attempt = report.attempts + 1;

  // ── The run ──
  const runInput: AnalysisInput = { ...ctx.input, enhancedRequested: false };
  const runOptions = runOptionsFor(frozen, ctx.ownerId, ctx.funnelId);
  let prepared: Awaited<ReturnType<typeof reserveAnalysis>>;
  try {
    prepared = await reserveAnalysis(runInput, runOptions);
  } catch (err) {
    if (err instanceof InsufficientCreditError && !calculator) {
      // The balance fell short between the check and the reservation: wait for credit. (Never a calculator report: it is house-paid.)
      const won = await endRun(admin, leadId, attempt, { state: 'held_credit', lease_until: null, attempts: report.attempts });
      return stateOf(won ? { ...report, state: 'held_credit', dueDay: null } : await reread(admin, ctx), null);
    }
    return failedAttempt(admin, ctx, attempt, err);
  }

  let result: AnalysisResult;
  try {
    ({ result } = await runAnalysis(prepared, runInput, { ...runOptions, ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) }));
  } catch (err) {
    await prepared.finish({ completed: false }).catch(() => {});
    return failedAttempt(admin, ctx, attempt, err);
  }
  // runAnalysis releases the reservation itself; this is the same release again (idempotent) so the charge below
  // can never come while a hold is open.
  await prepared.finish({ completed: true }).catch(() => {});

  // A report with no short-let figures is no report: not saved, not charged, and tried again until the third attempt.
  const complete = analysisComplete(result);
  if (!complete) return failedAttempt(admin, ctx, attempt, new Error('no_figures'));

  const trustworthy = isTrustworthyReport({
    comparables_found: result.dataQuality?.comparablesFound ?? null,
    quality_level: result.dataQuality?.level ?? null,
  });
  const quality = qualityOk({ complete, trustworthy });

  // Charged mode only, and only a quality-OK report with figures: once, after finish().
  // A calculator report is never charged here (the lead database bills it later), whatever the mode on the row says.
  const charge = calculator ? ({ charge: false, reason: 'free_mode' } as const) : chargeDecision({ billingMode: frozen.billingMode, pricePence: frozen.pricePence, quality, hasFigures: complete });
  if (charge.charge) await chargeReport(admin, { ownerId: ctx.ownerId, leadId, websiteId: report.websiteId, pence: charge.pence });

  // The lead gets its report and its CRM delivery; the landlord is not emailed a /r link.
  const verdict = await completeLead({
    leadId,
    result,
    rules: parseLeadRules(ctx.rulesRaw),
    unqualifiedPolicy: ctx.unqualifiedPolicy,
    emailProspect: false,
  });
  if (!verdict) console.error(`[website-report] lead ${leadId} ran but its report could not be saved`);

  // quality_ok and state done, in one write; only the run that still holds the lease finishes it.
  const done = await endRun(admin, leadId, attempt, { state: 'done', quality_ok: quality, completed_at: new Date().toISOString(), lease_until: null });
  const summary = buildSummary(result, quality);
  if (!done) return stateOf(await reread(admin, ctx), null);

  void enqueueLeadDbPush(leadId).catch(() => {}); // Batch 32: the report is done, so the lead database gets it (never throws, never waits)
  await sendLandlordEmail({ leadId, kind: summary ? 'summary' : 'will_contact', summary });
  // Safety net for the step-1 notice (once per lead: 'already' when it went at step 1).
  await notifyOperatorOfWebsiteLead({ leadId, websiteId: report.websiteId });
  return stateOf({ ...report, state: 'done', qualityOk: quality, dueDay: null }, summary);
}

async function reread(admin: Admin, ctx: RunContext): Promise<ReportRow> {
  const { data } = await admin.from('website_reports').select(REPORT_COLUMNS).eq('lead_id', ctx.report.leadId).maybeSingle();
  return data ? toReport(data as Record<string, unknown>) : ctx.report;
}

/**
 * An attempt that did not produce a report. Under the third attempt the lease
 * is released at once so the cron takes the report again; at the third the
 * report is failed. Only an error NAME is logged: an error's text may carry
 * what a provider was asked.
 */
async function failedAttempt(admin: Admin, ctx: RunContext, attempt: number, err: unknown): Promise<WebsiteReportState> {
  const leadId = ctx.report.leadId;
  console.error(`[website-report] attempt ${attempt} failed for lead ${leadId}:`, err instanceof Error ? err.name : 'error');
  if (attempt < MAX_REPORT_ATTEMPTS) {
    // Still running, lease already past: the cron's stale-lease pass retries it.
    await endRun(admin, leadId, attempt, { lease_until: new Date().toISOString() });
    return stateOf({ ...ctx.report, state: 'running', dueDay: null }, null);
  }
  return giveUp(admin, ctx, attempt, new Date().toISOString());
}

/** The third attempt is spent: failed, the landlord told "will be in touch", the operator told to follow up. */
async function giveUp(admin: Admin, ctx: RunContext, attempt: number, nowIso: string): Promise<WebsiteReportState> {
  const leadId = ctx.report.leadId;
  const { data, error } = await admin
    .from('website_reports')
    .update({ state: 'failed', lease_until: null, completed_at: nowIso, updated_at: nowIso })
    .eq('lead_id', leadId)
    .eq('state', 'running')
    .eq('attempts', attempt)
    .select('lead_id');
  if (error) console.error(`[website-report] could not fail lead ${leadId}:`, error.message);
  const won = !error && (data ?? []).length > 0;
  if (won) {
    await sendLandlordEmail({ leadId, kind: 'will_contact' });
    await notifyOperatorReportFailed({ leadId });
    return stateOf({ ...ctx.report, state: 'failed', dueDay: null }, null);
  }
  return stateOf(await reread(admin, ctx), null);
}
