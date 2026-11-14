import type { Section } from '../notify/message.ts';
import { PACK_COPY } from './pack-rules.ts';

/**
 * Batch 29, section C: the starter pack's £15 offer as a daily-email section.
 * It sits where the low-credit decision would sit, never beside it. Pure
 * (src/lib/credit/pack-offer-server.ts decides who it is due for).
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
