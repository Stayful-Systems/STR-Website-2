/**
 * Batch 33: the shapes and constants the customer website domains share. The
 * status list mirrors website_domains_status_check in supabase/schema.sql's
 * Batch 33 section (a pin in policy.test.ts holds it to it).
 *
 * Pure: no network, no database, no server-only.
 */

/** website_domains.status. */
export const DOMAIN_STATUSES = ['awaiting_admin', 'held_cap', 'registering', 'connecting', 'live', 'needs_choice', 'failed', 'releasing', 'released'] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

/** website_domains.renew_decision. */
export const RENEW_DECISIONS = ['renew', 'dont_renew'] as const;
export type RenewDecision = (typeof RENEW_DECISIONS)[number];

/** website_domain_spend_claim's answer. */
export const SPEND_CLAIMS = ['claimed', 'already', 'over_cap'] as const;
export type SpendClaim = (typeof SPEND_CLAIMS)[number];

/** website_domain_charge's `result`. */
export const DOMAIN_CHARGE_RESULTS = ['charged', 'unpaid', 'already_charged'] as const;
export type DomainChargeResult = (typeof DOMAIN_CHARGE_RESULTS)[number];

/** The most one domain may cost (£25): anything dearer, and any premium name, is refused. */
export const DOMAIN_MAX_PRICE_PENCE = 2500;
/** An offer is good for this long; after it the member is offered fresh names. */
export const OFFER_TTL_MS = 24 * 60 * 60 * 1000;
/** Names offered to a member: the primary and up to five alternatives. */
export const MAX_OFFER_NAMES = 6;
/** Tries before a purchase or connection is marked failed and waits for the admin's Retry. */
export const MAX_ATTEMPTS = 3;
/** A domain stuck in one unfinished state this long alerts the admin once. */
export const STUCK_HOURS = 24;
/** A renewal comes up on the admin's list this many days before expiry. */
export const RENEWAL_WINDOW_DAYS = 30;
/** Nobody decided by this many days before expiry: the auto-renew rule runs. */
export const AUTO_RENEW_DAYS = 7;
/** A registering row older than this is resumed by the cron (after an ownership check). */
export const REGISTERING_RESUME_MINUTES = 15;

/** The part of a website_domains row the app works with. */
export interface DomainRow {
  id: string;
  websiteId: string;
  /** The account owner. Never put this in a public payload. */
  ownerId: string;
  name: string;
  status: DomainStatus;
  registrar: string | null;
  registrarRef: string | null;
  costPence: number | null;
  boughtAt: string | null;
  expiresAt: string | null;
  renewAllowed: boolean;
  renewDecision: RenewDecision | null;
  renewDecidedBy: string | null;
  renewDecidedAt: string | null;
  dnsSetAt: string | null;
  vercelAddedAt: string | null;
  httpsOkAt: string | null;
  liveAt: string | null;
  attempts: number;
  lastError: string | null;
  stuckAlertedAt: string | null;
  renewalAlertedFor: string | null;
  autoRenewAlertedFor: string | null;
  stateChangedAt: string;
  createdAt: string;
  /** Bumped on every write: the engine's optimistic lock (a second runner of the same step loses). */
  updatedAt: string;
}
