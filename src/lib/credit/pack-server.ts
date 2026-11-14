import 'server-only';

import { cache } from 'react';
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { ACCESS_COLUMNS, accountStatus } from '../access';
import { payerFor } from '../team';
import { getBillingSettings } from './unit-costs';
import { NOT_PACK, PACK_COPY, isPackOnly, type PackState } from './pack-rules';
import { InsufficientCreditError } from './ledger';

/**
 * A pack-only member hit a Batch 29 limit: the fresh-report cap ('pack_cap'),
 * the second opinion that needs credit beyond the pack ('pack_topup_needed'),
 * or a cap claim that could not be written ('failed'). An
 * InsufficientCreditError, so every existing 402 path still offers the top-up
 * and plan choice; `message` is the line to show.
 */
export class PackLimitError extends InsufficientCreditError {
  readonly reason: 'pack_cap' | 'pack_topup_needed' | 'failed';
  constructor(reason: 'pack_cap' | 'pack_topup_needed' | 'failed', cap = 3) {
    super(0, 0);
    this.reason = reason;
    this.message = reason === 'pack_cap' ? PACK_COPY.capReached(cap) : reason === 'pack_topup_needed' ? `${PACK_COPY.deepTopUp}: ${PACK_COPY.deepTopUpWhy.toLowerCase()}` : 'We couldn’t check your fresh reports just now. Nothing was charged; please try again.';
  }
}

/**
 * Batch 29: the starter pack's state for one account, and the fresh-report
 * cap's slots. The rules are written up in ./pack-rules.ts; the database does
 * the allocation itself (credit_bonus_pays_for), so this module only answers
 * "is this member pack-only, what bonus is left, how many fresh reports".
 */

interface StateRow {
  pack_at?: string | null;
  paid_again_at?: string | null;
  bonus_pence?: number | string | null;
  bonus_expires_at?: string | null;
  fresh_used?: number | string | null;
}

/** The pack state of the account that pays (a team member's owner). Never throws: unreadable is NOT_PACK. */
export async function packStateForPayer(payerId: string): Promise<PackState> {
  if (!hasServiceRole() || !payerId) return NOT_PACK;
  try {
    const admin = createAdminClient();
    const [{ data, error }, { data: profile, error: profileErr }, settings] = await Promise.all([
      admin.rpc('pack_member_state', { p: { user: payerId } }),
      admin.from('profiles').select(ACCESS_COLUMNS).eq('id', payerId).maybeSingle(),
      getBillingSettings(),
    ]);
    if (error) throw new Error(error.message);
    if (profileErr) throw new Error(profileErr.message);
    const r = (data ?? {}) as StateRow;
    const packAt = r.pack_at ?? null;
    const paidAgainAt = r.paid_again_at ?? null;
    const bought = Boolean(packAt);
    const status = accountStatus((profile ?? {}) as Parameters<typeof accountStatus>[0]);
    return {
      bought,
      packAt,
      paidAgainAt,
      packOnly: isPackOnly({ bought, paidAgainAt, planStatus: status }),
      bonusPence: Math.max(0, Number(r.bonus_pence ?? 0) || 0),
      bonusExpiresAt: r.bonus_expires_at ?? null,
      freshUsed: Math.max(0, Number(r.fresh_used ?? 0) || 0),
      freshCap: settings.lifecycle.packFreshReportCap,
    };
  } catch (err) {
    console.warn('[pack] state not read (schema.sql Batch 29 section not run?):', err instanceof Error ? err.message : String(err));
    return NOT_PACK;
  }
}

/** The pack state for a member, read once per request however many surfaces ask. */
export const packStateFor = cache(async (userId: string): Promise<PackState> => {
  if (!hasServiceRole() || !userId) return NOT_PACK;
  const payer = await payerFor(userId).catch(() => null);
  return packStateForPayer(payer?.payerId ?? userId);
});

export type FreshClaim = { ok: true; claimed: boolean } | { ok: false; reason: 'pack_cap' | 'failed'; used?: number; cap?: number };

/**
 * Takes one of a pack-only payer's fresh-report slots for this action (a
 * purchase id or an action id), before anything is charged. For anyone who is
 * not pack-only it does nothing and allows. Race-free (public.pack_fresh_report_claim
 * counts and inserts under the member's row lock); the same action id again is
 * the same slot. A claim that cannot be written refuses: never a fresh report
 * the cap was meant to stop.
 */
export async function claimFreshReport(input: { payerId: string; actionId: string; kind: 'full_analysis' | 'report'; state?: PackState }): Promise<FreshClaim> {
  const state = input.state ?? (await packStateForPayer(input.payerId));
  if (!state.packOnly) return { ok: true, claimed: false };
  const { data, error } = await createAdminClient().rpc('pack_fresh_report_claim', {
    p: { user: input.payerId, action_id: input.actionId, kind: input.kind, cap: state.freshCap, since: state.packAt },
  });
  if (error) {
    console.error('[pack] fresh-report claim failed:', error.message);
    return { ok: false, reason: 'failed' };
  }
  const r = (data ?? {}) as { ok?: boolean; used?: number; cap?: number };
  if (!r.ok) return { ok: false, reason: 'pack_cap', used: Number(r.used ?? 0), cap: Number(r.cap ?? state.freshCap) };
  return { ok: true, claimed: true };
}

/** Gives a slot back (the run ended with nothing charged, or it was a saved analysis after all). Never throws. */
export async function releaseFreshReport(actionId: string | null | undefined): Promise<void> {
  if (!actionId || !hasServiceRole()) return;
  try {
    const { error } = await createAdminClient().rpc('pack_fresh_report_release', { p_action: actionId });
    if (error) console.error('[pack] fresh-report release failed:', error.message);
  } catch (err) {
    console.error('[pack] fresh-report release failed:', err instanceof Error ? err.message : String(err));
  }
}

/** The bonus left for the member's account, for the balance line (null: none, or unreadable). */
export async function packBonusFor(userId: string): Promise<{ pence: number; expiresAt: string | null } | null> {
  const s = await packStateFor(userId);
  return s.bonusPence > 0 ? { pence: s.bonusPence, expiresAt: s.bonusExpiresAt } : null;
}
