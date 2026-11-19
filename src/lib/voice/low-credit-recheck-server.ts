import 'server-only';

/**
 * Review R3 (R3-14 / R2-24, R3-45 / R2-43): a queued low-credit call is
 * tested again just before it dials. The balance must still be at or below
 * low_credit_pence; the call's landing must still be the member's most
 * recent credit (a top-up since means the call is about credit that is
 * gone); and no slower-spender nudge may have been decided for that landing
 * (then the nudge is the notice). The rule itself is low-credit.ts; the
 * queue is queue-server.ts.
 */
import { createAdminClient } from '../supabase/admin';
import { getBillingSettings } from '../credit/unit-costs';
import { getBalance } from '../credit/ledger';
import { latestLanding, lowCreditRecheck, type GrantRow, type LowCreditRecheck } from './low-credit';

export type { LowCreditRecheck };

export async function lowCreditStillDue(userId: string, triggerRef: string | null, now: Date): Promise<LowCreditRecheck> {
  const admin = createAdminClient();
  const settings = await getBillingSettings();
  const balance = await getBalance(userId).catch(() => null);
  // Review R4 (R4-34): the decision is low-credit.ts's lowCreditRecheck; this only reads its facts, and only those it needs.
  const base = { balancePence: balance ? balance.totalPence : null, lowCreditPence: settings.lifecycle.lowCreditPence, triggerRef };
  const first = lowCreditRecheck(base);
  if (!first.ok || !triggerRef) return first;
  const since = new Date(now.getTime() - (settings.voice.lowCreditWindowDays + 31) * 86_400_000).toISOString();
  const { data: grants, error } = await admin.from('credit_grants').select('id, kind, amount_pence, source_ref, created_at').eq('user_id', userId).gt('amount_pence', 0).gte('created_at', since).order('created_at', { ascending: false }).limit(20);
  // The balance is the fact that matters; unreadable grants leave the queue-time landing standing.
  const landing = error ? null : latestLanding((grants ?? []) as GrantRow[]);
  const withLanding = lowCreditRecheck({ ...base, latestLandingId: landing?.id ?? null });
  if (!withLanding.ok) return withLanding;
  const { data: nudges } = await admin.from('credit_nudges').select('id').eq('user_id', userId).eq('landing_id', triggerRef).limit(1);
  return lowCreditRecheck({ ...base, latestLandingId: landing?.id ?? null, nudged: (nudges ?? []).length > 0 });
}
