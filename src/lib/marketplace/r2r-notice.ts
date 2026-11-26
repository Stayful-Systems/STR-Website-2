/**
 * Deal feed (queue Batch 1): the rent-to-rent permission notice. A rent-to-rent deal is an
 * ordinary let; running it as a short let needs permission, and the notice says so on the
 * deal sheet and on the full report panel. Plain text, and only for a rental (kind 'rent').
 * The same words are in the knowledge entry deal_r2r_permission.
 */
export const R2R_PERMISSION_NOTICE = 'This is an ordinary let. You still need the landlord’s written permission for short lets, and the lender’s and freeholder’s where they apply.';

/** The notice for a deal of this kind, or null (a sale never shows it). */
export function r2rNoticeFor(kind: string | null | undefined): string | null {
  return kind === 'rent' ? R2R_PERMISSION_NOTICE : null;
}
