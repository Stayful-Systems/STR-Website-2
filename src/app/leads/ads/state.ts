/**
 * Batch 36 (Phase 8): which screen an operator's pack is on, and whether they
 * may regenerate it, as pure decisions over what the generator reports
 * (PackView). The page only asks; the tests pin the rules.
 *
 * Server side only (it uses generate-core.ts, which needs node:crypto): the
 * client component never imports this, it is handed the answers.
 *
 * Pure: no network, no database, no server-only.
 */
import { brandHash, generateMessage, regenerateBlock, STALE_GENERATING_MS, type PackView } from '../../../lib/ad-packs/generate-core.ts';

export type Screen =
  /** No pack yet (or a first attempt that failed): "Confirm your main area". */
  | { kind: 'start'; failedBefore: boolean }
  /** Another attempt holds the pack right now. */
  | { kind: 'working' }
  /** A pack to look at, not yet approved. `notice` is set when a newer attempt failed and this is the earlier version. */
  | { kind: 'preview'; notice: string | null }
  | { kind: 'approved'; notice: string | null }
  /** The checks did not pass; nothing to show. */
  | { kind: 'checks_failed' };

export const KEPT_NOTICE = 'We could not make your newer version, so this is still your earlier one. Nothing was lost.';

/** Which screen the pack is on. A 'generating' pack older than ten minutes is taken as abandoned (the generator does the same). */
export function packScreen(view: PackView | null, nowMs: number): Screen {
  if (!view) return { kind: 'start', failedBefore: false };
  const { pack } = view;
  switch (pack.status) {
    case 'generating':
      return Date.parse(pack.updatedAt) > nowMs - STALE_GENERATING_MS ? { kind: 'working' } : { kind: 'start', failedBefore: true };
    case 'preview':
      return { kind: 'preview', notice: null };
    case 'approved':
      return { kind: 'approved', notice: null };
    case 'checks_failed':
      return { kind: 'checks_failed' };
    case 'failed':
      // A failed regenerate keeps the version that was good: show it, with a line saying so.
      if (view.showAds) return pack.approvedAt !== null ? { kind: 'approved', notice: KEPT_NOTICE } : { kind: 'preview', notice: KEPT_NOTICE };
      return { kind: 'start', failedBefore: true };
    default:
      return { kind: 'start', failedBefore: false };
  }
}

export type RegenView = {
  /** The one-tap Regenerate may be shown: a free regeneration is left AND the brand has changed. */
  canRegenerate: boolean;
  left: number;
  /** The plain reason it may not be, or null when it may. */
  reason: string | null;
};

/**
 * Whether the operator may regenerate, decided with the generator's own rules
 * (regenerateBlock) over the brand as it is now on their website (company, logo,
 * colour, fee) and the area and photos the pack was made with. A change of area
 * or photos is made in the form itself, and the generator judges that when it is
 * submitted.
 */
export function regenView(view: PackView, brand: { company: string; logoUrl: string | null; brandColour: string | null; feePct: number | null }): RegenView {
  const { pack } = view;
  const left = view.freeRegensLeft;
  const hash = brandHash({ ...brand, photos: pack.photos ?? [], areaKey: pack.areaKey ?? '' });
  // regenerateBlock wants the allowance, which is what has been used plus what is left.
  const block = regenerateBlock(pack, hash, { freeRegens: pack.regenCount + left });
  return block === null ? { canRegenerate: true, left, reason: null } : { canRegenerate: false, left, reason: generateMessage(block) };
}
