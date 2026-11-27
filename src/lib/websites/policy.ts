/**
 * Batch 31: the rules of the customer websites, in one pure place. Nothing
 * here reads the database or the clock: the server code (store, report run,
 * cron) gathers the facts, asks these functions, and acts on the answer, so
 * every rule can be tested without a database.
 *
 *   access         who may have a website (management + account owner +
 *                  invited, and a paid plan only while the plan gate is on).
 *   freezeMode     the billing mode and price are fixed at step 2 and never
 *                  change for that report, whatever the settings do later.
 *   isSelfSubmit   a lead that looks like the operator testing their own site.
 *   decideStep2    what step 2 does: free -> claim a slot (or hold when the
 *                  lead is a self-submit); charged -> check the balance.
 *   claimOutcome   what the claim's answer means.
 *   qualityOk      the report is good enough to show without a caveat and to charge for.
 *   chargeDecision whether to charge once the report has run.
 *   landlordOutcome what the landlord is shown.
 *   nextState      the report state machine, matching website_reports.state.
 *
 * Website code never imports funnels/charge-server or funnels/tiers: the
 * charge itself is the website_report_charge SQL function, called by the
 * report run (policy.test.ts pins the imports).
 *
 * Pure: no network, no database, no server-only.
 */
import { normaliseMobile } from '../credit/abuse.ts';
import type { WebsiteSettings } from './settings.ts';
import type { BillingMode, ClaimResult, FrozenBilling, LandlordOutcome, ReportState } from './types.ts';

// ── Access ──

export interface AccessFacts {
  /** The account is a management company (profiles.signup_path = 'management'). */
  isManagement: boolean;
  /** The signed-in user is an account owner, not a team member (ownerIdOrNull is their own id). */
  isOwner: boolean;
  /** An admin has invited this member (a websites row exists for them). */
  invited: boolean;
  /** The member has a paid plan. Only read while the plan gate is on. */
  paid: boolean;
}

export type AccessDenial = 'not_management' | 'not_owner' | 'not_invited' | 'plan_required';
export type AccessResult = { allowed: true } | { allowed: false; reason: AccessDenial };

/**
 * invite / go_live: everything, and a paid plan too while the gate is on.
 * keep_live: a site that is already live keeps working when the gate is later
 * switched on (the gate blocks the invite and going live, not live sites), so
 * the plan is not asked for again.
 */
export type AccessPurpose = 'invite' | 'go_live' | 'keep_live';

export function websiteAccess(facts: AccessFacts, planGateOn: boolean, purpose: AccessPurpose = 'go_live'): AccessResult {
  if (!facts.isManagement) return { allowed: false, reason: 'not_management' };
  if (!facts.isOwner) return { allowed: false, reason: 'not_owner' };
  if (purpose !== 'invite' && !facts.invited) return { allowed: false, reason: 'not_invited' };
  if (planGateOn && purpose !== 'keep_live' && !facts.paid) return { allowed: false, reason: 'plan_required' };
  return { allowed: true };
}

// ── Mode freeze ──

/**
 * The billing mode and price for a report. With `existing` (the values already
 * on the report row) they are returned unchanged: a settings flip between step
 * 2 and the end of the run, or a retry by the cron, never changes them. With
 * none, the settings now are read and become that report's for good.
 */
export function freezeMode(settings: Pick<WebsiteSettings, 'reportChargeOn' | 'reportPence'>, existing?: FrozenBilling | null): FrozenBilling {
  if (existing && (existing.billingMode === 'free' || existing.billingMode === 'charged')) {
    return { billingMode: existing.billingMode, pricePence: Math.max(0, Math.floor(existing.pricePence || 0)) };
  }
  return settings.reportChargeOn ? { billingMode: 'charged', pricePence: settings.reportPence } : { billingMode: 'free', pricePence: 0 };
}

// ── Self-submit ──

export interface SelfSubmitFacts {
  /** The submitted lead. */
  leadEmail?: string | null;
  leadPhone?: string | null;
  /** The owner's profile (account email and phone), and the site's contact details. */
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  siteEmail?: string | null;
  sitePhone?: string | null;
  /** The signed-in user on the request, if any. */
  sessionUserId?: string | null;
  /** The site's owner, and every member of the owner's team. */
  ownerUserId?: string | null;
  teamUserIds?: readonly string[] | null;
}

const normEmail = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim().toLowerCase();
  return t.length > 0 ? t : null;
};

export type SelfSubmitReason = 'owner_email' | 'owner_phone' | 'site_email' | 'site_phone' | 'session';

/** Why a lead looks like the operator testing their own site; empty when it does not. */
export function selfSubmitReasons(f: SelfSubmitFacts): SelfSubmitReason[] {
  const out: SelfSubmitReason[] = [];
  const email = normEmail(f.leadEmail);
  const phone = normaliseMobile(f.leadPhone);
  const same = (a: string | null, b: string | null) => a !== null && b !== null && a === b;
  if (same(email, normEmail(f.ownerEmail))) out.push('owner_email');
  if (same(phone, normaliseMobile(f.ownerPhone))) out.push('owner_phone');
  if (same(email, normEmail(f.siteEmail))) out.push('site_email');
  if (same(phone, normaliseMobile(f.sitePhone))) out.push('site_phone');
  const session = f.sessionUserId ?? null;
  if (session && (session === (f.ownerUserId ?? null) || (f.teamUserIds ?? []).includes(session))) out.push('session');
  return out;
}

export function isSelfSubmit(f: SelfSubmitFacts): boolean {
  return selfSubmitReasons(f).length > 0;
}

// ── Step 2 ──

export type Step2Decision =
  /** Free mode, self-submit: saved and flagged, the report is NOT run. */
  | { kind: 'hold'; state: 'held_self'; frozen: FrozenBilling }
  /** Free mode: ask website_free_report_claim; claimOutcome() reads its answer. */
  | { kind: 'claim'; frozen: FrozenBilling }
  /** Charged mode, balance covers the price: run, then charge once if quality is OK. */
  | { kind: 'run'; frozen: FrozenBilling; charge: true }
  /** Charged mode, balance short: wait for credit. */
  | { kind: 'hold'; state: 'held_credit'; frozen: FrozenBilling };

export interface Step2Facts {
  /** What the report row already holds (a retry), or null at the first step 2. */
  frozen: FrozenBilling | null;
  /** The settings now: read only when nothing is frozen yet. */
  settings: Pick<WebsiteSettings, 'reportChargeOn' | 'reportPence'>;
  selfSubmit: boolean;
  /** The owner's balance in pence (charged mode only); null when unknown reads as short. */
  balancePence: number | null;
}

export function decideStep2(f: Step2Facts): Step2Decision {
  const frozen = freezeMode(f.settings, f.frozen);
  if (frozen.billingMode === 'free') {
    // The free-report leak: a self-submit never runs free.
    return f.selfSubmit ? { kind: 'hold', state: 'held_self', frozen } : { kind: 'claim', frozen };
  }
  // Charged: a self-submit runs and is charged like any other lead (it stays flagged).
  const enough = f.balancePence !== null && Number.isFinite(f.balancePence) && f.balancePence >= frozen.pricePence;
  return enough ? { kind: 'run', frozen, charge: true } : { kind: 'hold', state: 'held_credit', frozen };
}

export type ClaimOutcome = { kind: 'run' } | { kind: 'hold'; state: 'held_cap' };

/** claimed / already -> run; site_full / day_full -> held_cap (runs the next UK day). */
export function claimOutcome(result: ClaimResult): ClaimOutcome {
  return result === 'claimed' || result === 'already' ? { kind: 'run' } : { kind: 'hold', state: 'held_cap' };
}

/** The UK day after a YYYY-MM-DD day (the database supplies today's; the app never works it out). */
export function nextDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error('nextDay: expected YYYY-MM-DD');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return d.toISOString().slice(0, 10);
}

// ── Quality and charging ──

/** Complete (analysisComplete) AND trustworthy (isTrustworthyReport): both, or the report is low confidence. */
export function qualityOk(parts: { complete: boolean; trustworthy: boolean }): boolean {
  return parts.complete === true && parts.trustworthy === true;
}

export type ChargeDecision =
  | { charge: false; reason: 'free_mode' | 'no_figures' | 'low_quality' }
  | { charge: true; pence: number }
  /** Batch 55 step 2: an ad-calculator (si_ad) report with limited local data is still charged (rule 11). */
  | { charge: true; pence: number; reason: 'low_data' };

/** Where the lead came from. Absent: a website report, exactly as before. */
export type ChargeSource = 'si_website' | 'si_ad';

/**
 * Whether to charge once a report has run. Uses the mode FROZEN at step 2, never
 * the live setting. Free mode makes no charge decision at all. Charged mode
 * charges only a report that has figures and is quality OK; a low-quality or
 * failed report is never charged.
 *
 * Batch 55 step 2 (rules 10 and 11): `source: 'si_ad'` is a calculator report billed by the lead database, not here,
 * so the frozen mode and price are not read: a report with no figures is not charged (`no_figures`); a low-quality one
 * IS charged, with reason `low_data` (the quality check is only the label); anything else is charged. The pence is
 * whatever was passed (the lead database sets the price). Test leads are decided by the caller before this is asked.
 * Without `source`, or with 'si_website', nothing changes.
 */
export function chargeDecision(f: { billingMode: BillingMode; pricePence: number; quality: boolean | null; hasFigures: boolean; source?: ChargeSource }): ChargeDecision {
  if (f.source === 'si_ad') {
    const pence = Math.max(0, Math.floor(Number.isFinite(f.pricePence) ? f.pricePence : 0));
    if (!f.hasFigures) return { charge: false, reason: 'no_figures' };
    if (f.quality !== true) return { charge: true, pence, reason: 'low_data' };
    return { charge: true, pence };
  }
  if (f.billingMode !== 'charged') return { charge: false, reason: 'free_mode' };
  if (!f.hasFigures) return { charge: false, reason: 'no_figures' };
  if (f.quality !== true) return { charge: false, reason: 'low_quality' };
  if (!(f.pricePence > 0)) return { charge: false, reason: 'free_mode' };
  return { charge: true, pence: f.pricePence };
}

// ── What the landlord sees ──

/**
 * summary          figures, labelled as an estimate
 * summary_caveat   figures labelled "early estimate, limited local data"
 * held             the 24-hour message (held_cap)
 * will_contact     "{Company} will be in touch": a self-submit held, a failed
 *                  report, a report with no figures, credit held, or anything
 *                  not finished. Never a figure, never a reason.
 */
export function landlordOutcome(f: { state: ReportState; quality: boolean | null; hasFigures: boolean }): LandlordOutcome {
  switch (f.state) {
    case 'done':
      if (!f.hasFigures) return 'will_contact';
      return f.quality === true ? 'summary' : 'summary_caveat';
    case 'held_cap':
      return 'held';
    default:
      return 'will_contact';
  }
}

// ── State machine ──

export type ReportEvent =
  | 'run_started' // awaiting_address, held_cap or held_credit -> running (a lease taken)
  | 'lease_retaken' // running -> running: the cron took a stale lease (attempts + 1)
  | 'hold_cap'
  | 'hold_credit'
  | 'hold_self'
  | 'completed'
  | 'failed'
  | 'expired';

export const MAX_REPORT_ATTEMPTS = 3;

const TRANSITIONS: Record<ReportState, Partial<Record<ReportEvent, ReportState>>> = {
  awaiting_address: { run_started: 'running', hold_cap: 'held_cap', hold_credit: 'held_credit', hold_self: 'held_self', expired: 'expired' },
  held_cap: { run_started: 'running', expired: 'expired' },
  held_credit: { run_started: 'running', expired: 'expired' },
  held_self: { expired: 'expired' },
  running: { lease_retaken: 'running', completed: 'done', failed: 'failed' },
  done: {},
  failed: {},
  expired: {},
};

/** The state after an event, or null when the event is not allowed from that state. */
export function nextState(from: ReportState, event: ReportEvent): ReportState | null {
  return TRANSITIONS[from][event] ?? null;
}

export function canTransition(from: ReportState, to: ReportState): boolean {
  return Object.values(TRANSITIONS[from]).includes(to);
}

export function isTerminalState(s: ReportState): boolean {
  return Object.keys(TRANSITIONS[s]).length === 0;
}

/** States whose rows the 14-day expiry may remove (website_reports_expires_idx). */
export function isExpirable(s: ReportState): boolean {
  return nextState(s, 'expired') !== null;
}

/** A running report whose lease has passed: try again, or give up after the third attempt. */
export function staleLeaseAction(attempts: number): 'retry' | 'fail' {
  return attempts >= MAX_REPORT_ATTEMPTS ? 'fail' : 'retry';
}
