import { cache } from 'react';
import { liveSiteBySlug } from '@/lib/websites/store-server';
import { sitePagesOf } from '@/lib/websites/render';
import { buildSitePages } from '@/lib/websites/page-model';
import { EMPTY_CALCULATOR_COPY, calculatorServes, isCalculatorMode } from '@/lib/websites/calculator';
import { readAdAccount } from '@/lib/leaddb/ad-account-server';
import { siteAbsoluteUrl, siteDomain } from '@/lib/websites/urls';
import type { SiteRef } from '@/lib/websites/types';

/**
 * Batch 31: the live site behind a /s/<slug> address, for the layout, each
 * page and each page's metadata. `cache` makes the lookup one query per
 * request however many of them ask.
 *
 * Only a LIVE site resolves: paused, preview, invited, a bad slug and an
 * unknown one are all `null`, and every caller turns that into notFound().
 * A live site with no stored copy cannot be drawn either, so it is also null.
 *
 * Batch 55 (Part A): a CALCULATOR site (websites.mode = 'calculator') has no
 * stored copy, so the pages check is skipped for it only (its pages are built
 * from the settings alone, which is all the form and the privacy page need).
 * It also resolves to `null` while the lead database ad route is stopped for
 * its owner (calculatorServes: no account, no state yet, lapsed, cancelled or
 * no card; a paused account still serves), so the visitor sees what any other
 * missing site shows. This is the PAGE only. The report run is not stopped
 * here: a report already running finishes (the report cron reads the report
 * row, never this lookup).
 */
export const loadLiveSite = cache(async (slug: string) => {
  const row = await liveSiteBySlug(slug);
  if (!row) return null;
  if (isCalculatorMode(row.mode)) {
    const account = await readAdAccount(row.userId);
    if (!calculatorServes(row, account, new Date())) return null;
    return { row, pages: buildSitePages({ site: row, settings: row.settings, copy: EMPTY_CALCULATOR_COPY }) };
  }
  const pages = sitePagesOf(row, row.settings, row.pages);
  if (!pages) return null;
  return { row, pages };
});

/**
 * Batch 33: the canonical address of a page, only for a site on its own
 * domain ("https://harbourmanagement.co.uk/fees"). A site on the temporary
 * address has none: it stays noindex and is never competing with itself.
 */
export function canonicalFor(site: SiteRef, path: string): { canonical: string } | undefined {
  return siteDomain(site) ? { canonical: siteAbsoluteUrl(site, path) } : undefined;
}
