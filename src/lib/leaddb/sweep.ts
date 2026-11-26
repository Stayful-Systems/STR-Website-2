/**
 * Batch 32 / 35: which leads of one owner the sweep queues. Pure (no database, no server-only), so a test can pin it.
 *
 * Website leads come first, in the order they were read (those with a website report: unchanged behaviour). Leads read
 * from a Facebook lead-form sheet (an `ad_sheet_rows` row names them, and they have no report) follow, and go lead-only.
 * A lead that already has a delivery row, or appears twice, is never returned again.
 */
export function pickUnqueued(websiteIds: readonly string[], sheetIds: readonly string[], have: ReadonlySet<string>, room: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...websiteIds, ...sheetIds]) {
    if (out.length >= room) break;
    if (have.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** A lead row read with its website report's site id (the report row embeds as an object; an array is tolerated). */
export type ReportedLead = { id: string; website_reports?: { website_id?: string } | { website_id?: string }[] | null };

/** The site ids a lead row's report(s) point at. */
export function reportSiteIdsOf(row: ReportedLead): string[] {
  const w = row.website_reports;
  const list = Array.isArray(w) ? w : w ? [w] : [];
  return list.map((x) => x.website_id).filter((x): x is string => typeof x === 'string');
}

/**
 * Batch 55 (Part A): the ids of the website leads the sweep may queue, leaving out every lead whose report belongs to a
 * CALCULATOR site (`calculatorSiteIds`). A calculator lead is never an `si_website` push (Phase 2 sends it as `si_ad`).
 * Order is kept; a lead with no readable report site is kept (that is the old behaviour for a site-mode lead).
 */
export function withoutCalculatorLeads(rows: readonly ReportedLead[], calculatorSiteIds: ReadonlySet<string>): string[] {
  return rows.filter((r) => !reportSiteIdsOf(r).some((id) => calculatorSiteIds.has(id))).map((r) => r.id);
}
