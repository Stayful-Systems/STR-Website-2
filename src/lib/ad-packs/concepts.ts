/**
 * Batch 55 step 5 (Phase 1, 55c A6): the concept and the format each lead database pack ad is recorded with
 * (ad_pack_ads.concept_id and .format), so batch 55 Phase 4 can group results by them as well as by angle and version.
 *
 * Pack codes never carry the concept (batch 55 rule 5, 55c rule 10): it lives on the row.
 *
 * FORMATS (the column's check, supabase/schema.sql "Batch 55 step 5"):
 *   notice_video     the batch 38 notice video (5b today)
 *   type_cards       the batch 38 type-only cards (3a and 17 today, and the fallback look in Phase 2)
 *   phone_recording  55c Phase 2: the calculator on a phone, then the example report (5b)
 *   report_carousel  55c Phase 2: real example report pages, one per card (3a)
 *   loupe            55c Phase 2: a report page under a moving magnifier (17)
 *
 * PHASE 1 writes the batch 38 look: 5b → notice_video, 3a and 17 → type_cards, concept `<angle>-v1`. Phase 2 changes
 * conceptFor. The Academy route stores neither (null): its rows are byte-identical to before.
 *
 * Pure: no network, no database, no server-only.
 */
import type { Angle } from './codes.ts';

export const AD_FORMATS = ['phone_recording', 'report_carousel', 'loupe', 'notice_video', 'type_cards'] as const;
export type AdFormat = (typeof AD_FORMATS)[number];

/** The concept id's shape (the column's check): lower-case letters, digits and hyphens, 1 to 40, no leading hyphen. */
export const CONCEPT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isAdFormat(v: unknown): v is AdFormat {
  return typeof v === 'string' && (AD_FORMATS as readonly string[]).includes(v);
}

/** The concept and format of one lead database pack ad (Phase 1: the batch 38 look). */
export function conceptFor(angle: Angle): { conceptId: string; format: AdFormat } {
  return { conceptId: `${angle}-v1`, format: angle === '5b' ? 'notice_video' : 'type_cards' };
}
