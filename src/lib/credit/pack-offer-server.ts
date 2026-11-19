import 'server-only';

import type { createAdminClient } from '../supabase/admin';
import { logActivity } from '../activity/log';
import { getBillingSettings } from './unit-costs';
import { packStateForPayer } from './pack-server';
import { earlyOfferEmailDue, lowCreditHeldForOffer, lowCreditWaitsForOffer } from './pack-rules';
import { packOfferMessage } from './pack-offer';
import { siteUrl } from '../url';
import { sendEmail, isEmailConfigured } from '../email/send';
import { renderEmail } from '../notify/render-email';
import { abandonSend, claimSlot, finishSend, markSending, releaseClaim } from '../notify/sends';
import { newSendToken, sendKey } from '../notify/cap';

export { packOfferSection } from './pack-offer';

/**
 * Batch 29, section C: the £15 early offer in the daily email, and its place
 * before Batch 20's £5 decision (and Batch 25's nudge, which stands in for it).
 *   - due: a pack-only member whose total balance is at or under
 *     pack_early_offer_pence and who has not had the offer's email section.
 *     The picks run or the digest (whichever email goes first that day) adds
 *     the section and stamps pack_offer_emailed_at. Review R4 (R4-15, Zac 19
 *     Nov 2026): on a morning no daily email is built for them, the digest
 *     sends it as its own email (sendPackOfferAlone), so the £5 decision is
 *     held one day, never day after day.
 *   - held: sent (or first shown on Home) today, or due with a morning email
 *     to carry it (lowCreditHeldForOffer in pack-rules.ts). The £5 decision
 *     and the nudge wait for these members, so a member never gets both on
 *     one day and the offer goes first (low-credit-server.ts, after-debit.ts).
 *     A member with daily emails off or picks paused is never held.
 * Anything unreadable holds nobody and offers nothing.
 */
type Admin = ReturnType<typeof createAdminClient>;

const ID_CHUNK = 200;

export interface PackOfferState {
  /** The email section is due (once ever). */
  due: boolean;
  /** The £5 decision and the nudge wait today. */
  held: boolean;
  sentToday: boolean;
  totalPence: number;
  bonusPence: number;
}

export async function packOfferStates(admin: Admin, userIds: readonly string[], now: Date = new Date()): Promise<Map<string, PackOfferState>> {
  const out = new Map<string, PackOfferState>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const offerPence = (await getBillingSettings()).lifecycle.packEarlyOfferPence;
    if (!(offerPence > 0)) return out;
    // Pack buyers only (one read), then their stamps, state and balance.
    const buyers: string[] = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data, error } = await admin.from('starter_pack_purchases').select('user_id').eq('status', 'granted').in('user_id', ids.slice(i, i + ID_CHUNK));
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as { user_id: string | null }[]) if (r.user_id) buyers.push(r.user_id);
    }
    if (buyers.length === 0) return out;
    const stamps = new Map<string, { emailed: string | null; dismissed: string | null; home: string | null; dailyEmails: boolean }>();
    const balances = new Map<string, number>();
    for (let i = 0; i < buyers.length; i += ID_CHUNK) {
      const chunk = buyers.slice(i, i + ID_CHUNK);
      const [{ data: rows, error: rowsErr }, { data: bals, error: balErr }] = await Promise.all([
        admin.from('profiles').select('id, pack_offer_emailed_at, pack_offer_dismissed_at, pack_offer_home_at, sourcing_alerts, picks_paused_inactive_at').in('id', chunk),
        admin.rpc('lifecycle_balances', { p: { users: chunk } }),
      ]);
      if (rowsErr) throw new Error(rowsErr.message);
      if (balErr) throw new Error(balErr.message);
      for (const r of (rows ?? []) as { id: string; pack_offer_emailed_at: string | null; pack_offer_dismissed_at: string | null; pack_offer_home_at: string | null; sourcing_alerts: boolean | null; picks_paused_inactive_at: string | null }[]) {
        stamps.set(r.id, { emailed: r.pack_offer_emailed_at, dismissed: r.pack_offer_dismissed_at, home: r.pack_offer_home_at, dailyEmails: r.sourcing_alerts !== false && !r.picks_paused_inactive_at });
      }
      for (const b of (bals ?? []) as { u: string; total: number | string }[]) balances.set(b.u, Number(b.total) || 0);
    }
    for (const id of buyers) {
      const st = stamps.get(id);
      if (!st) continue;
      const sentToday = lowCreditWaitsForOffer(st.emailed, now);
      const total = balances.get(id) ?? 0;
      // The pack state (pack-only?) only matters while the offer could still be due.
      let due = false;
      let bonus = 0;
      if (!st.emailed && total <= offerPence) {
        const state = await packStateForPayer(id);
        bonus = state.bonusPence;
        due = earlyOfferEmailDue({ packOnly: state.packOnly, totalPence: total, offerPence, homeAt: null, emailedAt: st.emailed, dismissedAt: st.dismissed });
      }
      const held = lowCreditHeldForOffer({ due, emailedAt: st.emailed, homeAt: st.home, dailyEmails: st.dailyEmails }, now);
      if (due || held) out.set(id, { due, held, sentToday, totalPence: total, bonusPence: bonus });
    }
  } catch (err) {
    console.warn('[pack-offer] states unreadable:', err instanceof Error ? err.message : String(err));
    out.clear();
  }
  return out;
}

/** The members the £5 decision and the nudge wait for today (the offer is due, or went today). */
export async function packOfferHolds(admin: Admin, userIds: readonly string[], now: Date = new Date()): Promise<Set<string>> {
  return new Set([...(await packOfferStates(admin, userIds, now))].filter(([, s]) => s.held).map(([id]) => id));
}

/** The section went: once ever. Record-only pack_offer_shown (surface email). */
export async function markPackOfferEmailed(admin: Admin, userId: string, now: Date = new Date()): Promise<void> {
  const { data, error } = await admin.from('profiles').update({ pack_offer_emailed_at: now.toISOString() }).eq('id', userId).is('pack_offer_emailed_at', null).select('id');
  if (error) {
    console.error('[pack-offer] emailed stamp failed:', error.message);
    return;
  }
  if ((data ?? []).length > 0) logActivity(userId, 'pack_offer_shown', { dedupeKey: 'pack_offer_shown:email', extras: { surface: 'email' } });
}

/**
 * Review R4 (R4-15): the offer as its own email, in the day's one slot, when no
 * daily email was built for the member that morning (the digest's fallback).
 * Stamps pack_offer_emailed_at once it has gone, so the £5 decision waits for
 * the next UK day. Never the £5 decision's stamp.
 */
export async function sendPackOfferAlone(admin: Admin, input: { userId: string; email: string; state: Pick<PackOfferState, 'totalPence' | 'bonusPence'>; now?: Date }): Promise<'sent' | 'slot_used' | 'unavailable' | 'failed' | 'not_configured'> {
  const now = input.now ?? new Date();
  if (!isEmailConfigured()) return 'not_configured';
  const claim = await claimSlot(admin, input.userId, 'low_credit', now);
  if (!claim.ok) return claim.reason === 'slot_used' ? 'slot_used' : 'unavailable';
  const base = siteUrl();
  const token = newSendToken();
  const unsubscribeUrl = `${base.replace(/\/$/, '')}/api/notify/unsubscribe/${token}`;
  const message = packOfferMessage(input.state, base, { label: 'Stop these emails', url: unsubscribeUrl, oneClickUrl: unsubscribeUrl });
  const summary = { packOffer: true, balancePence: Math.round(input.state.totalPence), subject: message.subject };
  if (!(await markSending(admin, claim.id, summary, token))) {
    await releaseClaim(admin, claim.id);
    return 'unavailable';
  }
  const mail = renderEmail(message);
  const res = await sendEmail({ to: input.email, subject: mail.subject, html: mail.html, text: mail.text, headers: mail.headers, idempotencyKey: sendKey('daily', input.userId, claim.day) });
  if (!res.sent) {
    // The slot goes back for a later send today.
    await abandonSend(admin, claim.id);
    return 'failed';
  }
  await finishSend(admin, claim.id, true, summary, []);
  await markPackOfferEmailed(admin, input.userId, now);
  return 'sent';
}
