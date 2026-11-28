/**
 * Batch 55 step 5 (Phase 2): the pure plan of the lead database pictures (ld-images.tsx draws them; a test cannot
 * import JSX, so the names, sizes and words live here).
 *
 * Pure: no network, no database, no server-only.
 */
import type { CardSize } from './images-sizes.ts';

/** The report page's card width on a 1080-wide picture (55c rule 7: "about 960 px wide on 1080"). */
export const CAROUSEL_CARD_W = 960;
export const CAROUSEL_SIZES: readonly CardSize[] = ['1x1', '4x5', '9x16'];

/** 3a-card<n>-<size>.png: the same names as the batch 38 cards (and the type-only fallback), so a carousel replaces them. */
export function carouselName(n: number, size: CardSize): string {
  return `3a-card${n}-${size}.png`;
}

/** The words on the drawn calculator: LeadForm.tsx's step-two labels, word for word (a test pins them to the file). */
export function phoneFrameLabels() {
  return {
    heading: 'Free income report',
    step: 'Step 2 of 2: the property',
    address: 'Property address',
    addressPlaceholder: 'Start typing the address',
    postcode: 'Postcode',
    bedrooms: 'Bedrooms',
    guests: 'Sleeps (guests)',
    button: 'Show my estimate',
  } as const;
}
