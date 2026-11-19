import type { Message, Section, Unsubscribe } from '../notify/message.ts';
import { PACK_COPY } from './pack-rules.ts';
import { manageNotificationsUrl } from '../url.ts';

/**
 * Batch 29, section C: the starter pack's £15 offer as a daily-email section.
 * It sits where the low-credit decision would sit, never beside it. Review R4
 * (R4-15): on a morning with no daily email built, it goes as its own email
 * (packOfferMessage). Pure (src/lib/credit/pack-offer-server.ts decides who it
 * is due for).
 */
export function packOfferSection(o: { totalPence: number; bonusPence: number }, siteUrl: string): Section {
  const base = siteUrl.replace(/\/$/, '');
  return {
    key: 'notice',
    title: null,
    blocks: [
      { type: 'text', text: PACK_COPY.earlyOfferTitle, tone: 'strong' },
      { type: 'text', text: PACK_COPY.earlyOffer(o.totalPence, o.bonusPence), tone: 'callout' },
      {
        type: 'buttons',
        links: [
          { label: 'Start Starter', url: `${base}/account/billing/choose?pick=starter`, primary: true },
          { label: 'Top up', url: `${base}/account/billing/choose?pick=topup` },
        ],
      },
    ],
  };
}

/** Review R4 (R4-15): the offer as its own email, on a morning no daily email was built. In the day's one slot. */
export function packOfferMessage(o: { totalPence: number; bonusPence: number }, siteUrl: string, unsubscribe: Unsubscribe | null): Message {
  const base = siteUrl.replace(/\/$/, '');
  return {
    kind: 'low_credit',
    subject: PACK_COPY.earlyOfferTitle,
    eyebrow: 'Stayful · Your credit',
    sections: [packOfferSection(o, base)],
    reason: 'You get this because your starter pack credit is running low.',
    manageUrl: manageNotificationsUrl(base),
    unsubscribe,
  };
}
