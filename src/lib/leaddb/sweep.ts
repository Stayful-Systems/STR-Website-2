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
