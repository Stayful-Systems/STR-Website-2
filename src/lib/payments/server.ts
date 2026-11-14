import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { queueFunnelSync, type FunnelReason } from '../crm/monday-funnel/queue-server';
import type { PaymentRecord, RefundRecord } from './rules';

/**
 * Writing the rows behind "Total paid" (src/lib/payments/rules.ts). A payment
 * is inserted once per Stripe id and never changed; a refund keeps the
 * charge's largest cumulative amount (public.member_refund_set). Neither ever
 * throws or holds up a payment: a failure is a warning (one a minute per
 * message, so an un-run schema cannot flood the logs). Each new payment and
 * each refund queues the member for Monday (Total paid, First payment).
 */

const REASON: Record<PaymentRecord['kind'], FunnelReason> = { starter_pack: 'starter_pack', topup: 'topup', auto_topup: 'topup', subscription: 'plan' };

const warnedAt = new Map<string, number>();
function warn(message: string): void {
  const now = Date.now();
  if (now - (warnedAt.get(message) ?? 0) < 60_000) return;
  warnedAt.set(message, now);
  console.warn('[payments] not recorded:', message);
}

/** Records a payment. Returns true when this call wrote the row (false for a copy already recorded, or a failure). */
export async function recordPayment(p: PaymentRecord | null): Promise<boolean> {
  if (!p || !hasServiceRole()) return false;
  try {
    const { data, error } = await createAdminClient()
      .from('member_payments')
      .upsert(
        { id: p.id, user_id: p.userId, kind: p.kind, amount_pence: p.amountPence, currency: p.currency, plan_code: p.planCode, payment_intent_id: p.paymentIntentId },
        { onConflict: 'id', ignoreDuplicates: true },
      )
      .select('id');
    if (error) {
      warn(error.message);
      return false;
    }
    const wrote = (data?.length ?? 0) > 0;
    if (wrote) await queueFunnelSync(p.userId, REASON[p.kind]);
    if (wrote) await packOfferAccepted(p);
    return wrote;
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Records a charge's refunds (cumulative). Never lowers what is stored. */
export async function recordRefund(r: RefundRecord | null): Promise<void> {
  if (!r || !hasServiceRole()) return;
  try {
    const { error } = await createAdminClient().rpc('member_refund_set', { p: { charge: r.chargeId, user: r.userId, pi: r.paymentIntentId, amount: Math.max(0, Math.round(r.amountRefundedPence)) } });
    if (error) warn(error.message);
    else await queueFunnelSync(r.userId, 'refund');
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Batch 29: a further payment (top-up, automatic top-up or a plan's paid
 * invoice) after the starter pack's £15 offer was shown, on Home or in an
 * email: record-only pack_offer_accepted, once per member (its dedupe key).
 * Never throws.
 */
async function packOfferAccepted(p: PaymentRecord): Promise<void> {
  if (p.kind === 'starter_pack' || !(p.amountPence > 0)) return;
  try {
    const { data } = await createAdminClient().from('profiles').select('pack_offer_home_at, pack_offer_emailed_at').eq('id', p.userId).maybeSingle();
    const row = data as { pack_offer_home_at: string | null; pack_offer_emailed_at: string | null } | null;
    const shown = [row?.pack_offer_home_at, row?.pack_offer_emailed_at].filter((x): x is string => Boolean(x)).sort()[0] ?? null;
    if (!shown) return;
    const { recordActivity } = await import('../activity/log');
    await recordActivity(p.userId, 'pack_offer_accepted', { dedupeKey: 'pack_offer_accepted', extras: { kind: p.kind, amount_pence: p.amountPence, shown_at: shown } });
  } catch {
    /* record-only: never in the way of a payment */
  }
}
