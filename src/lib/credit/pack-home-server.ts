import 'server-only';

import { after } from 'next/server';
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { payerFor } from '../team';
import { logActivity } from '../activity/log';
import { getBalance } from './ledger';
import { getBillingSettings } from './unit-costs';
import { packStateForPayer } from './pack-server';
import { earlyOfferHomeShown } from './pack-rules';

/**
 * Batch 29: Home's two starter-pack cards.
 *   offer      the one-off "start Starter or top up and your bonus stops
 *              expiring" card, when a pack-only member's balance is at or
 *              under pack_early_offer_pence. Shown on the UK day it is first
 *              seen (stamped then, with a record-only pack_offer_shown), never
 *              after, nor once dismissed.
 *   picksBack  "I paused your daily picks while you were away…": once, after a
 *              pack pause ended because they came back.
 * The stamps are written after the page is sent (next/server after()). Never
 * throws: an unreadable state shows neither card.
 */
export interface PackHomeCards {
  offer: { totalPence: number; bonusPence: number } | null;
  picksBack: boolean;
}

const NONE: PackHomeCards = { offer: null, picksBack: false };

interface Row {
  pack_offer_home_at: string | null;
  pack_offer_emailed_at: string | null;
  pack_offer_dismissed_at: string | null;
  pack_picks_back_at: string | null;
  pack_picks_note_at: string | null;
  last_low_balance_email_at: string | null;
}

export async function packHomeCardsFor(userId: string, now: Date = new Date()): Promise<PackHomeCards> {
  if (!hasServiceRole()) return NONE;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.from('profiles').select('pack_offer_home_at, pack_offer_emailed_at, pack_offer_dismissed_at, pack_picks_back_at, pack_picks_note_at, last_low_balance_email_at').eq('id', userId).maybeSingle();
    if (error || !data) return NONE;
    const p = data as Row;
    const back = p.pack_picks_back_at ? Date.parse(p.pack_picks_back_at) : NaN;
    const noted = p.pack_picks_note_at ? Date.parse(p.pack_picks_note_at) : NaN;
    const picksBack = Number.isFinite(back) && !(Number.isFinite(noted) && noted >= back);

    const payer = await payerFor(userId);
    const state = await packStateForPayer(payer.payerId);
    let offer: PackHomeCards['offer'] = null;
    if (state.packOnly) {
      const [balance, settings] = await Promise.all([getBalance(payer.payerId), getBillingSettings()]);
      const facts = { packOnly: true, totalPence: balance.totalPence, offerPence: settings.lifecycle.packEarlyOfferPence, homeAt: p.pack_offer_home_at, emailedAt: p.pack_offer_emailed_at, dismissedAt: p.pack_offer_dismissed_at, lowToldAt: p.last_low_balance_email_at };
      if (earlyOfferHomeShown(facts, now)) {
        offer = { totalPence: balance.totalPence, bonusPence: state.bonusPence };
        if (!p.pack_offer_home_at) {
          after(async () => {
            const { data: stamped } = await admin.from('profiles').update({ pack_offer_home_at: now.toISOString() }).eq('id', userId).is('pack_offer_home_at', null).select('id');
            if ((stamped ?? []).length > 0) logActivity(userId, 'pack_offer_shown', { dedupeKey: 'pack_offer_shown:home', extras: { surface: 'home' } });
          });
        }
      }
    }
    if (picksBack) {
      after(async () => {
        await admin.from('profiles').update({ pack_picks_note_at: now.toISOString() }).eq('id', userId);
      });
    }
    return { offer, picksBack };
  } catch (err) {
    console.warn('[pack] Home cards not read:', err instanceof Error ? err.message : String(err));
    return NONE;
  }
}

/** The member closed the offer card. */
export async function dismissPackOffer(userId: string): Promise<void> {
  if (!hasServiceRole()) return;
  const { error } = await createAdminClient().from('profiles').update({ pack_offer_dismissed_at: new Date().toISOString() }).eq('id', userId).is('pack_offer_dismissed_at', null);
  if (error) console.error('[pack] offer dismiss failed:', error.message);
}
