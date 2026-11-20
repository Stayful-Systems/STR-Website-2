import 'server-only';

import { packEligibility, readAdPacksEnabled } from './eligibility-server.ts';
import { createLiveStore } from './store-server.ts';
import type { PackStatus } from './store-types.ts';

/**
 * Batch 38 (Phase 8): the cheap check behind the "Your ad pack" card on /leads,
 * which runs on every load of that page for an account owner.
 *
 *   1  the master switch (one tiny read). Off: nothing else is read. It is off
 *      until the pack is opened, so for now that is the only query.
 *   2  with the switch on, the full eligibility check (a handful of light
 *      reads), remembered per owner for a minute so reloading Leads does not
 *      repeat it
 *   3  the owner's pack row for its status (one read, never remembered, so the
 *      card is right the moment a pack is made or approved)
 *
 * Fails closed: any problem reads as "show nothing". The card never links an
 * account that is not eligible, and an admin previewing with the switch off
 * does not get the card (they open /leads/ads directly).
 */

const TTL_MS = 60_000;
const memo = new Map<string, { at: number; eligible: boolean }>();

/** The status of the owner's pack (null: none yet), or `false` when the card must not be shown. */
export async function adPackEntry(userId: string): Promise<{ status: PackStatus | null } | false> {
  try {
    if (!(await readAdPacksEnabled())) return false;
    const hit = memo.get(userId);
    let eligible: boolean;
    let ownerId: string | undefined;
    if (hit && Date.now() - hit.at < TTL_MS) {
      eligible = hit.eligible;
      ownerId = userId;
    } else {
      const e = await packEligibility(userId);
      eligible = e.eligible && Boolean(e.ownerId);
      ownerId = e.ownerId;
      memo.set(userId, { at: Date.now(), eligible });
      if (memo.size > 500) memo.clear();
    }
    if (!eligible || !ownerId) return false;
    const pack = await createLiveStore().getPack(ownerId);
    return { status: pack?.status ?? null };
  } catch {
    return false;
  }
}
