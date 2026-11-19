import { cache } from 'react';
import { liveSiteBySlug } from '@/lib/websites/store-server';
import { sitePagesOf } from '@/lib/websites/render';

/**
 * Batch 31: the live site behind a /s/<slug> address, for the layout, each
 * page and each page's metadata. `cache` makes the lookup one query per
 * request however many of them ask.
 *
 * Only a LIVE site resolves: paused, preview, invited, a bad slug and an
 * unknown one are all `null`, and every caller turns that into notFound().
 * A live site with no stored copy cannot be drawn either, so it is also null.
 */
export const loadLiveSite = cache(async (slug: string) => {
  const row = await liveSiteBySlug(slug);
  if (!row) return null;
  const pages = sitePagesOf(row, row.settings, row.pages);
  if (!pages) return null;
  return { row, pages };
});
