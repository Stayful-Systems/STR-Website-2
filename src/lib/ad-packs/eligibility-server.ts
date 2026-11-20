import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { ownerIdOrNull } from '../leads/scope';
import { ownSite, type WebsiteRow } from '../websites/store-server';
import { domainIsLiveFor, domainOfSite } from '../domains/store-server';
import { evaluateEligibility, parseSwitch, type EligibilityFacts, type EligibilityReason } from './eligibility.ts';

export { evaluateEligibility, plainReason, ELIGIBILITY_REASONS, type EligibilityFacts, type EligibilityReason } from './eligibility.ts';

/**
 * Batch 36: gathers the facts that decide whether an account may have an ad
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
 * SERVER ONLY. A failed read logs the table and the database's error code
 * and counts as "not eligible", never as eligible.
 */

export type PackEligibility = {
  eligible: boolean;
  reasons: EligibilityReason[];
  /** The account owner's id, when the person is one. */
  ownerId?: string;
  website?: WebsiteRow;
  /** The live domain (bare host, e.g. acme.co.uk), only when it is live. */
  domain?: string;
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
  if (!ownerId) return { ...evaluateEligibility({ isOwner: false, academy: 'none', hasSite: false, siteLive: false, hasDomain: false, domainLive: false, switchOn: false }, opts) };

  const [academy, website, switchOn] = await Promise.all([academyOf(ownerId), ownSite(ownerId), readAdPacksEnabled()]);
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
    ownerId,
    ...(website ? { website } : {}),
    ...(domainLive && domainRow ? { domain: domainRow.name } : {}),
  };
}
