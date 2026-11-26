import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { ownerIdOrNull } from '../leads/scope';
import { ownSite, type WebsiteRow } from '../websites/store-server';
import { domainIsLiveFor, domainOfSite } from '../domains/store-server';
import { readAdAccount } from '../leaddb/ad-account-server';
import { CALCULATOR_MODE } from '../websites/calculator';
import { appHost } from './links.ts';
import { chooseAdRoute, evaluateEligibility, evaluateLeadDbEligibility, leadDbAccountFacts, parseSwitch, type AdRoute, type EligibilityFacts, type PackEligibilityReason } from './eligibility.ts';

export { evaluateEligibility, plainReason, ELIGIBILITY_REASONS, type AdRoute, type EligibilityFacts, type EligibilityReason, type PackEligibilityReason } from './eligibility.ts';

/**
 * Batch 38: gathers the facts that decide whether an account may have an ad
 * pack (read only) and hands them to evaluateEligibility.
 *
 *   owner     ownerIdOrNull (a team member's own id finds nothing)
 *   Academy   a linked academy_purchases row for the owner: refunded_at null
 *             counts, only-refunded does not. Read directly (select only);
 *             nothing from src/lib/academy is imported
 *   site      ownSite(ownerId), live = websites.status 'live'
 *   domain    domainOfSite(site.id) and domainIsLiveFor (the database's word)
 *   switch    billing_settings ad_packs_enabled (jsonb, off unless true)
 *
 * Batch 55 (Part A): a second route. An owner with a lead database ad account
 * (leaddb_ad_accounts, read by readAdAccount) and no website of their own
 * (websites.mode 'site') is on the 'leaddb' route: judged by
 * evaluateLeadDbEligibility, using their calculator site (websites.mode
 * 'calculator') and this app's own host, with no Academy purchase and no
 * domain needed. Everyone else is on the 'academy' route, exactly as before.
 *
 * SERVER ONLY. A failed read logs the table and the database's error code
 * and counts as "not eligible", never as eligible.
 */

export type PackEligibility = {
  eligible: boolean;
  reasons: PackEligibilityReason[];
  /** Which way in the account has. A non-owner reads as 'academy'. */
  route: AdRoute;
  /** The account owner's id, when the person is one. */
  ownerId?: string;
  /** The Academy route: the owner's website. The lead database route: their calculator site, only when eligible. */
  website?: WebsiteRow;
  /**
   * The Academy route: the live domain (bare host, e.g. acme.co.uk), only when it is live.
   * The lead database route: this app's own bare host, only when eligible.
   */
  domain?: string;
  /** The lead database route only, when eligible: the calculator site's slug, so links go to /s/<slug>. */
  sitePath?: string;
};

async function academyOf(ownerId: string): Promise<EligibilityFacts['academy']> {
  if (!hasServiceRole()) return 'none';
  const { data, error } = await createAdminClient().from('academy_purchases').select('id, refunded_at').eq('user_id', ownerId);
  if (error) {
    console.error('[ad-packs] academy read failed:', error.code ?? 'error');
    return 'none';
  }
  const rows = (data ?? []) as { refunded_at: string | null }[];
  if (rows.some((r) => r.refunded_at === null)) return 'active';
  return rows.length > 0 ? 'refunded' : 'none';
}

/** This app's own bare host and the calculator site's slug, or nothing when the host is not a plain host (a local address). */
function appHostOf(slug: string): { domain?: string; sitePath?: string } {
  try {
    return { domain: appHost(), sitePath: slug };
  } catch {
    console.error('[ad-packs] the app host is not a plain host name');
    return {};
  }
}

/** billing_settings ad_packs_enabled: false when missing, unreadable or anything but true. */
export async function readAdPacksEnabled(): Promise<boolean> {
  if (!hasServiceRole()) return false;
  const { data, error } = await createAdminClient().from('billing_settings').select('value').eq('key', 'ad_packs_enabled').maybeSingle();
  if (error) {
    console.error('[ad-packs] switch read failed:', error.code ?? 'error');
    return false;
  }
  return parseSwitch((data as { value?: unknown } | null)?.value);
}

/**
 * Whether this signed-in person may have an ad pack, and if not, every reason.
 * `admin: true` (an admin previewing the screen) skips only 'switch_off'.
 */
export async function packEligibility(userId: string, opts: { admin?: boolean } = {}): Promise<PackEligibility> {
  const ownerId = await ownerIdOrNull(userId ? { id: userId } : null);
  if (!ownerId) return { ...evaluateEligibility({ isOwner: false, academy: 'none', hasSite: false, siteLive: false, hasDomain: false, domainLive: false, switchOn: false }, opts), route: 'academy' };

  const [academy, ownedSite, switchOn, adAccount] = await Promise.all([academyOf(ownerId), ownSite(ownerId), readAdPacksEnabled(), hasServiceRole() ? readAdAccount(ownerId) : Promise.resolve(null)]);
  const isCalculator = ownedSite?.mode === CALCULATOR_MODE;
  const route = chooseAdRoute({ hasAdAccount: adAccount !== null, hasSiteWebsite: ownedSite !== null && !isCalculator });

  if (route === 'leaddb') {
    const verdict = evaluateLeadDbEligibility(
      { isOwner: true, hasWebsite: false, ...leadDbAccountFacts(adAccount, new Date(), isCalculator), switchOn },
      opts,
    );
    return {
      ...verdict,
      route,
      ownerId,
      ...(isCalculator && ownedSite ? { website: ownedSite } : {}),
      ...(verdict.eligible && ownedSite ? appHostOf(ownedSite.slug) : {}),
    };
  }

  // The Academy route, exactly as it was. A calculator site is not a website of the owner's own.
  const website = ownedSite && !isCalculator ? ownedSite : null;
  const domainRow = website ? await domainOfSite(website.id) : null;
  const domainLive = Boolean(website && domainRow && domainRow.status === 'live' && (await domainIsLiveFor(website.id, domainRow.name)));

  const verdict = evaluateEligibility(
    {
      isOwner: true,
      academy,
      hasSite: website !== null,
      siteLive: website?.status === 'live',
      hasDomain: domainRow !== null,
      domainLive,
      switchOn,
    },
    opts,
  );
  return {
    ...verdict,
    route,
    ownerId,
    ...(website ? { website } : {}),
    ...(domainLive && domainRow ? { domain: domainRow.name } : {}),
  };
}
