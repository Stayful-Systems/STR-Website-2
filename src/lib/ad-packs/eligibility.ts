/**
 * Batch 38: who may have an ad pack, as pure logic.
 *
 * Eligible = the account owner, with a linked Academy purchase that has not
 * been refunded, whose website is live on its own domain, while the feature
 * switch (billing_settings ad_packs_enabled) is on. eligibility-server.ts
 * gathers the facts; this decides, and says why not in plain English.
 *
 * Pure: no network, no database, no server-only.
 */

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
export function plainReason(reason: EligibilityReason): string {
  return PLAIN[reason] ?? 'The ad pack is not available for this account yet.';
}

/** A billing_settings switch (jsonb true/false, or the strings "true"/"false"); anything else is OFF. */
export function parseSwitch(raw: unknown): boolean {
  return raw === true || raw === 'true';
}
