/**
 * Batch 38: text lengths for the pack's ads. Meta's own recommendations and
 * the stricter limits our pack texts keep, in ONE object so a Meta rule change
 * is a one-file edit.
 *
 *   headline     Meta recommends 27 characters; a pack headline is never over 40
 *   primary text Meta shows about the first 125 characters before "See more";
 *                the first sentence must make sense inside that. A pack's
 *                primary text is one paragraph of 300 characters at most
 *   description  a pack description is 90 characters at most; Meta may cut it
 *                off past about 30 on some placements. A full sentence of
 *                10 to 15 words is the aim (a note, never a failure)
 *
 * Pure: no network, no database, no server-only.
 */

export const AD_LIMITS = {
  headline: { recommended: 27, hard: 40 },
  primary: { visible: 125, hard: 300 },
  description: { hard: 90, metaVisible: 30, minWords: 10, maxWords: 15 },
} as const;

export type LengthKind = 'headline' | 'primary' | 'description';
export type LengthLevel = 'green' | 'amber' | 'red';
export type LengthCheck = { length: number; level: LengthLevel; notes: string[] };

/** The first sentence: up to the first . ! or ? followed by a space or the end. */
export function firstSentence(text: string): string {
  const t = text.trim();
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(t);
  return (m ? m[0] : t).trim();
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

/**
 * green = within the recommendation, amber = over the recommendation but
 * within the hard limit, red = over the hard limit (or empty).
 *
 * Primary text: the recommendation is about the FIRST sentence (it must fit
 * the 125 visible characters), the hard limit is the whole text. Description:
 * there is no amber; it is green up to the pack limit, with a note past the
 * point Meta may cut it off.
 */
export function checkLength(kind: LengthKind, text: string): LengthCheck {
  const t = String(text ?? '').trim();
  const length = t.length;
  const notes: string[] = [];
  if (length === 0) return { length, level: 'red', notes: ['Empty.'] };

  if (kind === 'headline') {
    const { recommended, hard } = AD_LIMITS.headline;
    if (length > hard) notes.push(`Over the ${hard}-character limit by ${length - hard}.`);
    else if (length > recommended) notes.push(`Over Meta's recommended ${recommended} characters by ${length - recommended}; it may be cut off.`);
    return { length, level: length > hard ? 'red' : length > recommended ? 'amber' : 'green', notes };
  }

  if (kind === 'primary') {
    const { visible, hard } = AD_LIMITS.primary;
    const first = firstSentence(t).length;
    if (length > hard) notes.push(`Over the ${hard}-character limit by ${length - hard}.`);
    if (first > visible) notes.push(`The first sentence is ${first} characters; it should be ${visible} or fewer so it makes sense before "See more".`);
    else if (length > visible) notes.push(`Meta shows about the first ${visible} characters, then "See more"; the first sentence fits.`);
    const level: LengthLevel = length > hard ? 'red' : first > visible ? 'amber' : 'green';
    return { length, level, notes };
  }

  const { hard, metaVisible, minWords, maxWords } = AD_LIMITS.description;
  if (length > hard) notes.push(`Over the ${hard}-character limit by ${length - hard}.`);
  else if (length > metaVisible) notes.push(`May be cut off on some placements past ${metaVisible} characters.`);
  const words = wordCount(t);
  if (words < minWords || words > maxWords) notes.push(`${words} words; a full sentence of ${minWords} to ${maxWords} words reads best.`);
  return { length, level: length > hard ? 'red' : 'green', notes };
}
