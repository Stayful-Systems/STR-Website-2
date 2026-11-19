/**
 * Batch 31: the shapes the customer websites share. The state and status
 * lists mirror the CHECK constraints in supabase/schema.sql's Batch 31
 * section (websites_status_check, website_reports_state_check,
 * website_reports_billing_mode_check); a pin in types.test.ts holds them to it.
 *
 * Pure: no network, no database, no server-only.
 */

/** websites.status. Live / paused lives here, never on the funnel row. */
export const WEBSITE_STATUSES = ['invited', 'setup', 'preview', 'live', 'paused'] as const;
export type WebsiteStatus = (typeof WEBSITE_STATUSES)[number];

/** website_reports.state. */
export const REPORT_STATES = ['awaiting_address', 'held_cap', 'held_credit', 'held_self', 'running', 'done', 'failed', 'expired'] as const;
export type ReportState = (typeof REPORT_STATES)[number];

/** website_reports.billing_mode: set once, at step 2. */
export const BILLING_MODES = ['free', 'charged'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

/** website_free_report_claim's answer. */
export const CLAIM_RESULTS = ['claimed', 'already', 'site_full', 'day_full'] as const;
export type ClaimResult = (typeof CLAIM_RESULTS)[number];

/** website_report_charge's `result`. */
export const CHARGE_RESULTS = ['charged', 'unpaid', 'already_charged'] as const;
export type ChargeResult = (typeof CHARGE_RESULTS)[number];

/** What a landlord sees on screen and in their email after step 2. */
export const LANDLORD_OUTCOMES = ['summary', 'summary_caveat', 'held', 'will_contact'] as const;
export type LandlordOutcome = (typeof LANDLORD_OUTCOMES)[number];

/** The part of a websites row that addressing needs. */
export interface SiteRef {
  slug: string;
  /** Batch 33: a customer's own domain. Null for now; ignored today. */
  domain?: string | null;
}

/** The billing mode and price held on the report row from step 2 on. */
export interface FrozenBilling {
  billingMode: BillingMode;
  /** 0 when free. */
  pricePence: number;
}

/** A lead's attribution as stored in lead_sources (a path only, never a query string). */
export interface LeadSourceFields {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  fbclid: string | null;
  landing_page: string | null;
  /** varchar(40). */
  ad_code: string | null;
}
