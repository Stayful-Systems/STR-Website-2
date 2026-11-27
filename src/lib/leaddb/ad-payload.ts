/**
 * What goes to the lead database for one calculator lead, an `si_ad` lead (Batch 55 step 2, contract section 10).
 *
 * Three phases under one `si_lead_id`: `lead` (the landlord's details and the ad tag), then `report` (the figures,
 * the PDF and the billing fields) or `report_failed` (the billing fields only, never billable). A closed field set,
 * copied one by one, as Batch 32's website push: nothing else on the lead row or the analysis can reach the output.
 *
 * Billing (rules 10 and 11) is decided ONCE, by `adBilling`, when the first report phase is built, and frozen on the
 * delivery row; the lead database never recomputes it.
 *
 * Occupancy is a PERCENT 0 to 100 (it comes from `buildSummary`, which already converts the analyser's 0-1).
 *
 * Pure: no network, no database, no server-only.
 */
import { chargeDecision } from '../websites/policy.ts';
import { pickSameLandlord, type LandlordLeadRow } from '../leads/dedupe.ts';
import type { ReportSummary } from '../websites/summary.ts';
import { reportBlock, type LeadFields } from './payload.ts';

export type AdPhase = 'lead' | 'report' | 'report_failed';
export type AdMatch = 'code' | 'ad_id' | 'none' | 'foreign_code';
export type BillableReason = 'report_ran' | 'low_data' | 'repeat' | 'test' | 'no_figures';

/** A repeat landlord is an earlier ad lead of the same landlord for the same customer inside this many days (rule 10). */
export const REPEAT_WINDOW_DAYS = 30;

/** The message on every ad lead (the landlord's own words are never sent: the calculator has no message box). */
export const AD_LEAD_MESSAGE = 'Enquired through your Facebook ad calculator.';

export interface AdLeadDetails {
  name: string;
  email: string;
  phone: string;
  address: string;
  postcode: string;
  bedrooms: string;
  message: string;
}

export interface AdReport {
  gross_annual_income: number;
  nightly_rate: number;
  occupancy_pct: number;
  bedrooms: number;
  low_data: boolean;
  pdf_base64: string;
}

/** The body, exactly the contract's field names. Fields not used by a phase are left out. */
export interface AdLeadBody {
  ld_customer_id: string;
  si_lead_id: string;
  phase: AdPhase;
  is_test: boolean;
  pack_code?: string | null;
  ad_id?: string | null;
  ad_match?: AdMatch;
  repeat_of_si_lead_id?: string | null;
  lead?: AdLeadDetails;
  report?: AdReport;
  billable?: boolean;
  billable_reason?: BillableReason;
  report_attached_at?: string;
}

// ── The ad tag ──

export interface AdLinkFacts {
  /** ad_pack_lead_links.match */
  match: string;
  /** ad_pack_lead_links.meta_ad_id_seen */
  metaAdIdSeen: string | null;
  /** ad_pack_ads.code of ad_pack_lead_links.pack_ad_id (null when no pack ad was matched, or it was removed). */
  packAdCode: string | null;
}

const MATCHES: ReadonlySet<string> = new Set(['code', 'ad_id', 'none', 'foreign_code']);
const META_AD_ID = /^\d{1,30}$/;
const PACK_CODE = /^[A-Za-z0-9-]{1,40}$/;

/**
 * The ad tag the `lead` phase carries, read at send time from `ad_pack_lead_links`. `pack_code` is the matched pack
 * ad's code only when SI matched it (`code` or `ad_id`), otherwise null ("Ad unknown"); `ad_id` is Meta's id when it is
 * digits; `ad_match` is SI's own result, `none` when there is no link row at all.
 */
export function adTag(link: AdLinkFacts | null): { pack_code: string | null; ad_id: string | null; ad_match: AdMatch } {
  if (!link) return { pack_code: null, ad_id: null, ad_match: 'none' };
  const match = (MATCHES.has(link.match) ? link.match : 'none') as AdMatch;
  const matched = match === 'code' || match === 'ad_id';
  const code = matched && link.packAdCode && PACK_CODE.test(link.packAdCode) ? link.packAdCode : null;
  const adId = link.metaAdIdSeen && META_AD_ID.test(link.metaAdIdSeen) ? link.metaAdIdSeen : null;
  return { pack_code: code, ad_id: adId, ad_match: match };
}

// ── Billing ──

export interface AdBilling {
  billable: boolean;
  reason: BillableReason;
  lowData: boolean;
}

/**
 * Whether this lead is billable, decided once (rules 10 and 11). In order: a test lead (the owner trying their own
 * calculator: `website_reports.self_submit`) is never billable; a report that failed with no figures is never billable;
 * a repeat landlord is billable as `repeat`; a low-data report is billable as `low_data`; anything else is `report_ran`.
 * The low-data flag is reported on its own whatever the reason.
 */
export function adBilling(f: { isTest: boolean; phase: 'report' | 'report_failed'; qualityOk: boolean | null; repeat: boolean }): AdBilling {
  const hasFigures = f.phase === 'report';
  const lowData = hasFigures && f.qualityOk !== true;
  if (f.isTest) return { billable: false, reason: 'test', lowData };
  const d = chargeDecision({ billingMode: 'free', pricePence: 0, quality: f.qualityOk, hasFigures, source: 'si_ad' });
  if (!d.charge) return { billable: false, reason: 'no_figures', lowData };
  if (f.repeat) return { billable: true, reason: 'repeat', lowData };
  return { billable: true, reason: 'reason' in d && d.reason === 'low_data' ? 'low_data' : 'report_ran', lowData };
}

/** True when the frozen billing fields agree with each other (the contract's 400 rule, checked before sending). */
export function billingAgrees(isTest: boolean, billable: boolean, reason: string): boolean {
  if (isTest) return billable === false && reason === 'test';
  if (billable) return reason === 'report_ran' || reason === 'low_data' || reason === 'repeat';
  return reason === 'no_figures';
}

// ── Repeat landlord ──

/**
 * The earlier ad lead of the same landlord (same postcode and the same email or phone) for this customer inside
 * REPEAT_WINDOW_DAYS, or null. `rows` are the owner's earlier AD leads (each already known to the lead database);
 * this lead itself and anything after it are never picked.
 */
export function pickRepeat(
  rows: readonly LandlordLeadRow[],
  self: { id: string; createdAt: string; postcode: string | null; email: string | null; phone: string | null },
): string | null {
  if (!self.postcode || (!self.email && !self.phone)) return null;
  const at = Date.parse(self.createdAt);
  if (!Number.isFinite(at)) return null;
  const earlier = rows.filter((r) => r.id !== self.id && Date.parse(r.created_at) <= at);
  const hit = pickSameLandlord(earlier, { postcode: self.postcode, email: self.email, phone: self.phone }, REPEAT_WINDOW_DAYS, new Date(at));
  return hit ? hit.id : null;
}

// ── The body ──

const text = (v: string | null | undefined) => (typeof v === 'string' ? v.trim() : '');

export function adLeadDetails(lead: LeadFields): AdLeadDetails {
  return {
    name: text(lead.name),
    email: text(lead.email),
    phone: text(lead.phone),
    address: text(lead.address),
    postcode: text(lead.postcode),
    bedrooms: lead.bedrooms === null || lead.bedrooms === undefined ? '' : String(lead.bedrooms),
    message: AD_LEAD_MESSAGE,
  };
}

/** The report block with `low_data`, or undefined when there are no figures or no sendable PDF (Batch 32's rule). */
export function adReportBlock(summary: ReportSummary | null, pdf: Uint8Array | null, lowData: boolean): AdReport | undefined {
  const r = reportBlock(summary, pdf);
  if (!r) return undefined;
  return { gross_annual_income: r.gross_annual_income, nightly_rate: r.nightly_rate, occupancy_pct: r.occupancy_pct, bedrooms: r.bedrooms, low_data: lowData, pdf_base64: r.pdf_base64 };
}

export function buildAdLeadPhase(input: {
  ldCustomerId: string;
  leadId: string;
  isTest: boolean;
  tag: ReturnType<typeof adTag>;
  lead: LeadFields;
}): AdLeadBody {
  return {
    ld_customer_id: input.ldCustomerId,
    si_lead_id: input.leadId,
    phase: 'lead',
    is_test: input.isTest,
    pack_code: input.tag.pack_code,
    ad_id: input.tag.ad_id,
    ad_match: input.tag.ad_match,
    // The postcode is only known after step 2, so a repeat is found when the report phase is built and is sent there
    // (see buildAdReportPhase). On this phase it is null.
    repeat_of_si_lead_id: null,
    lead: adLeadDetails(input.lead),
  };
}

/**
 * The `report` or `report_failed` phase. DEVIATION from the contract text (section 10 lists `repeat_of_si_lead_id`
 * on phase `lead` only): the landlord's postcode is not known at step 1, so the repeat is found here and sent on the
 * report phase too. It is information only; billing already carries `repeat`.
 */
export function buildAdReportPhase(input: {
  ldCustomerId: string;
  leadId: string;
  isTest: boolean;
  phase: 'report' | 'report_failed';
  report?: AdReport;
  billable: boolean;
  billableReason: BillableReason;
  repeatOfLeadId: string | null;
  reportAttachedAt: string;
}): AdLeadBody {
  return {
    ld_customer_id: input.ldCustomerId,
    si_lead_id: input.leadId,
    phase: input.phase,
    is_test: input.isTest,
    repeat_of_si_lead_id: input.repeatOfLeadId,
    ...(input.phase === 'report' && input.report ? { report: input.report } : {}),
    billable: input.billable,
    billable_reason: input.billableReason,
    report_attached_at: input.reportAttachedAt,
  };
}

// ── Responses (contract section 10) ──

/**
 * Whether a refused call is worth another go. A network error, a timeout, an unset secret on either side (status 0
 * `not_configured`, or a 404 with an empty body), 401, 408 and 5xx are retried. 400, 403 (`stopped`, `unpaid_hold`),
 * 404 `unknown_customer`, 409 (other than `no_lead`, handled by the caller), 413, 422 and 429 (`daily_cap`) are final.
 */
export function adLeadRetryable(status: number, code: string): boolean {
  if (status === 0) return true;
  if (status === 404) return code === 'not_available';
  if (status === 400 || status === 403 || status === 409 || status === 413 || status === 422 || status === 429) return false;
  return status >= 500 || status === 408 || status === 401;
}

/** The pack-generated call: 404 `unknown_customer` is final; 200 `recorded` / `already_recorded` is done. */
export function packNoticeOutcome(r: { ok: boolean; status: number; code: string; data?: { code?: unknown } }): 'done' | 'final' | 'retry' {
  if (r.ok) {
    const c = r.data?.code;
    return c === 'recorded' || c === 'already_recorded' ? 'done' : 'retry';
  }
  if (r.status === 404 && r.code === 'unknown_customer') return 'final';
  if (r.status === 400 || r.status === 413) return 'final';
  return 'retry';
}
