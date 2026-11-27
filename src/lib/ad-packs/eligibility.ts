/**
 * Batch 38: who may have an ad pack, as pure logic.
 *
 * Eligible = the account owner, with a linked Academy purchase that has not
 * been refunded, whose website is live on its own domain, while the feature
 * switch (billing_settings ad_packs_enabled) is on. eligibility-server.ts
 * gathers the facts; this decides, and says why not in plain English.
 *
 * Batch 55 (Part A): a second route. An owner with a lead database ad account
 * and no website of their own is judged by evaluateLeadDbEligibility instead:
 * the account must be linked, allowed, have a card on file and not be stopped.
 * chooseAdRoute decides which route applies. The Academy route above is pinned
 * byte for byte by eligibility-academy-pin.test.ts; nothing below changes it.
 *
 * Pure: no network, no database, no server-only.
 */
import { adRouteStopped, type AdRouteStopReason, type LeadDbAdAccount } from '../leaddb/ad-account.ts';

export const ELIGIBILITY_REASONS = ['not_owner', 'no_academy', 'academy_refunded', 'no_site', 'site_not_live', 'no_domain', 'domain_not_live', 'switch_off'] as const;
export type EligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

/** What the database says about the account, nothing more. */
export type EligibilityFacts = {
  /** The signed-in person owns the account (a team member does not). */
  isOwner: boolean;
  /** 'active' = a linked purchase with no refund; 'refunded' = only refunded ones; 'none' = no linked purchase. */
  academy: 'active' | 'refunded' | 'none';
  hasSite: boolean;
  /** websites.status = 'live'. */
  siteLive: boolean;
  /** The site has a domain row (not released). */
  hasDomain: boolean;
  /** The domain is live for this site (website_domains.status = 'live'). */
  domainLive: boolean;
  /** billing_settings ad_packs_enabled. */
  switchOn: boolean;
};

export type EligibilityVerdict = { eligible: boolean; reasons: EligibilityReason[] };

/**
 * Every reason the pack is not available, most basic first. A non-owner gets
 * only 'not_owner' (nothing else can be said about an account that is not
 * theirs). A missing site hides the site-live and domain reasons; a missing
 * domain hides domain-not-live. `admin: true` skips only 'switch_off', so an
 * admin can preview the screen while the feature is off.
 */
export function evaluateEligibility(facts: EligibilityFacts, opts: { admin?: boolean } = {}): EligibilityVerdict {
  const reasons: EligibilityReason[] = [];
  if (!facts.isOwner) return { eligible: false, reasons: ['not_owner'] };
  if (facts.academy === 'none') reasons.push('no_academy');
  else if (facts.academy === 'refunded') reasons.push('academy_refunded');
  if (!facts.hasSite) {
    reasons.push('no_site');
  } else {
    if (!facts.siteLive) reasons.push('site_not_live');
    if (!facts.hasDomain) reasons.push('no_domain');
    else if (!facts.domainLive) reasons.push('domain_not_live');
  }
  if (!facts.switchOn && opts.admin !== true) reasons.push('switch_off');
  return { eligible: reasons.length === 0, reasons };
}

const PLAIN: Record<EligibilityReason, string> = {
  not_owner: 'Only the owner of the account can set up the ad pack.',
  no_academy: 'The ad pack comes with the Academy. Once your Academy purchase is linked to this account, it will appear here.',
  academy_refunded: 'The ad pack comes with the Academy, and your Academy purchase has been refunded.',
  no_site: 'You need a website first. The ads send people to it.',
  site_not_live: 'Your website is not live yet. Put it live, then come back for your ads.',
  no_domain: 'Your website needs its own .co.uk address first. The ads send people there.',
  domain_not_live: 'Your website address is not live yet. It can take a little while to go live, so check back soon.',
  switch_off: 'The ad pack is not open yet. We will tell you as soon as it is.',
};

/** One plain sentence for the screen, no jargon. An unknown reason gets a safe fallback. */
export function plainReason(reason: PackEligibilityReason): string {
  return (PLAIN as Record<string, string>)[reason] ?? (LEADDB_PLAIN as Record<string, string>)[reason] ?? 'The ad pack is not available for this account yet.';
}

/** A billing_settings switch (jsonb true/false, or the strings "true"/"false"); anything else is OFF. */
export function parseSwitch(raw: unknown): boolean {
  return raw === true || raw === 'true';
}

// ── The lead database route (Batch 55, Part A) ──

/** Which way in an account has: the Academy (Batch 38) or a lead database ad account (Batch 55). */
export type AdRoute = 'academy' | 'leaddb';
export const AD_ROUTES = ['academy', 'leaddb'] as const satisfies readonly AdRoute[];

/** The reasons only the lead database route can give. */
export const LEADDB_ONLY_REASONS = ['has_website', 'no_leaddb_account', 'account_stopped', 'no_card', 'not_allowed'] as const;
/** Every reason the lead database route can give, most basic first. */
export const LEADDB_REASONS = ['not_owner', 'has_website', 'no_leaddb_account', 'account_stopped', 'no_card', 'not_allowed', 'switch_off'] as const;
export type LeadDbEligibilityReason = (typeof LEADDB_REASONS)[number];
/** A reason from either route. The Academy's own list (ELIGIBILITY_REASONS) is unchanged. */
export type PackEligibilityReason = EligibilityReason | LeadDbEligibilityReason;

/** What the database says about a lead database account, nothing more. */
export type LeadDbEligibilityFacts = {
  /** The signed-in person owns the account (a team member does not). */
  isOwner: boolean;
  /** The owner has a site-mode website of their own: such an owner is not offered this route. */
  hasWebsite: boolean;
  /** The owner has a lead database ad account here AND its calculator site. */
  linked: boolean;
  /** Zac's switch for this owner (leaddb_ad_accounts.allowed). */
  allowed: boolean;
  /** The lead database says a usable card is on file. */
  cardOnFile: boolean;
  /** No state yet, lapsed, cancelled, or past its cancel date (the card is NOT part of this: it has its own reason). */
  stopped: boolean;
  /** billing_settings ad_packs_enabled. */
  switchOn: boolean;
};

/**
 * Every reason the lead database route is not available, most basic first.
 * A non-owner gets only 'not_owner'. A website of their own gets only
 * 'has_website' (plus 'switch_off' while it is off), because nothing about the
 * lead database account matters to them. No account hides the account reasons.
 * With an account, the order is the one adRouteVerdict uses: stopped, no card,
 * not allowed. `admin: true` skips only 'switch_off'.
 */
export function evaluateLeadDbEligibility(facts: LeadDbEligibilityFacts, opts: { admin?: boolean } = {}): { eligible: boolean; reasons: LeadDbEligibilityReason[] } {
  const reasons: LeadDbEligibilityReason[] = [];
  if (!facts.isOwner) return { eligible: false, reasons: ['not_owner'] };
  if (facts.hasWebsite) {
    reasons.push('has_website');
  } else if (!facts.linked) {
    reasons.push('no_leaddb_account');
  } else {
    if (facts.stopped) reasons.push('account_stopped');
    if (!facts.cardOnFile) reasons.push('no_card');
    if (!facts.allowed) reasons.push('not_allowed');
  }
  if (!facts.switchOn && opts.admin !== true) reasons.push('switch_off');
  return { eligible: reasons.length === 0, reasons };
}

/** adRouteVerdict's reason, as the eligibility reason it becomes. */
export const LEADDB_REASON_OF_VERDICT: Record<AdRouteStopReason, LeadDbEligibilityReason> = {
  no_account: 'no_leaddb_account',
  account_stopped: 'account_stopped',
  // Batch 55 step 2: the unpaid hold reads as the account being on hold (the same neutral wording; never "pause").
  unpaid_hold: 'account_stopped',
  no_card: 'no_card',
  not_allowed: 'not_allowed',
};

/**
 * The account facts for evaluateLeadDbEligibility, from the stored account.
 * `stopped` is "stopped for any reason but the card" (the card has its own
 * reason), found by asking the stop rule with a card on file. Pause is never
 * read. `hasCalculatorSite` is false when the account row exists but its
 * calculator site does not (provisioning unfinished): not linked yet.
 */
export function leadDbAccountFacts(account: LeadDbAdAccount | null, now: Date, hasCalculatorSite = true): Pick<LeadDbEligibilityFacts, 'linked' | 'allowed' | 'cardOnFile' | 'stopped'> {
  if (!account) return { linked: false, allowed: false, cardOnFile: false, stopped: true };
  return {
    linked: hasCalculatorSite,
    allowed: account.allowed === true,
    cardOnFile: account.cardOnFile === true,
    stopped: adRouteStopped({ ...account, cardOnFile: true }, now),
  };
}

/**
 * Which route an owner is on. A lead database ad account and no site-mode
 * website means the lead database route; anything else is the Academy route,
 * exactly as before (an owner with a website of their own stays on it).
 */
export function chooseAdRoute(input: { hasAdAccount: boolean; hasSiteWebsite: boolean }): AdRoute {
  return input.hasAdAccount && !input.hasSiteWebsite ? 'leaddb' : 'academy';
}

const LEADDB_PLAIN: Record<(typeof LEADDB_ONLY_REASONS)[number], string> = {
  has_website: 'You already have your own website, so the lead database ads are not available for this account.',
  no_leaddb_account: 'Your lead database account is not linked to this account yet. Once it is, your ads will appear here.',
  account_stopped: 'Your lead database account is not active at the moment, so the ads are on hold. Once it is active again, they will appear here.',
  no_card: 'Your lead database account needs a payment card on file before you can make ads. Add one there, then come back.',
  not_allowed: 'Your ads are not open for your account yet. We will tell you as soon as they are.',
};
