/**
 * Batch 36: is a customer website switched off? Read by the public site's
 * layout (to show the neutral page instead of a 404) and by the own-domain
 * routing (so a switched-off site's domain still reaches that page).
 *
 * "Switched off" is not a status (the five statuses are unchanged): it is a
 * PAUSED site whose website_grace row has switched_off_at set and has not been
 * cancelled (switching back on sets cancelled_at, and the site is live again).
 * It stays true after the data is deleted: the stub row remains, and so does
 * the neutral page. A site an admin merely paused has no such row, so it is
 * still a 404.
 *
 * The lead and report APIs never read this: they only accept a live site
 * (liveSiteBySlug), so a switched-off site takes no new lead.
 *
 * Nothing here imports server-only at the top: the lookup loads the admin
 * client when it is actually used, so the rules run under node --test.
 */
import { slugProblem } from './slug.ts';

export interface GraceFlags {
  switched_off_at: string | null;
  cancelled_at: string | null;
}

/** A paused site with a switch-off that has not been undone. */
export function isSwitchedOff(status: string | null | undefined, grace: Partial<GraceFlags> | null | undefined): boolean {
  return status === 'paused' && Boolean(grace?.switched_off_at) && !grace?.cancelled_at;
}

export type SwitchedOffLookup = (slug: string) => Promise<{ status: string; grace: Partial<GraceFlags> | null } | null>;

const realLookup: SwitchedOffLookup = async (slug) => {
  const { createAdminClient, hasServiceRole } = await import('../supabase/admin');
  if (!hasServiceRole()) return null;
  const { data, error } = await createAdminClient().from('websites').select('status, website_grace(switched_off_at, cancelled_at)').eq('slug', slug).maybeSingle();
  if (error || !data) return null;
  const row = data as { status: string; website_grace: Partial<GraceFlags> | Partial<GraceFlags>[] | null };
  const g = Array.isArray(row.website_grace) ? row.website_grace[0] : row.website_grace;
  return { status: row.status, grace: g ?? null };
};

/** True when the slug is a switched-off site (deleted or not). Any failure reads as false: the page is a 404, as before. */
export async function switchedOffBySlug(slug: string, lookup: SwitchedOffLookup = realLookup): Promise<boolean> {
  if (typeof slug !== 'string' || slugProblem(slug) !== null) return false;
  try {
    const row = await lookup(slug);
    return row ? isSwitchedOff(row.status, row.grace) : false;
  } catch {
    return false;
  }
}
