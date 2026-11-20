/**
 * Batch 33: turning a company name into the .co.uk names we offer.
 *
 *   "Harbour Management Ltd"  ->  harbourmanagement.co.uk   (not ...managementmanagement)
 *
 * slugFromCompany strips Ltd, Limited, LLP, PLC and "&", drops punctuation and a
 * trailing "management"; candidates() builds the primary name and then the
 * alternatives in this order: -management, <town>management, lettings,
 * -lettings, <town>lettings. validCoUk is the one test of what may be bought:
 * a single plain label (1-63 characters, letters, digits and inner hyphens, no
 * xn--) under .co.uk, and not a brand we must never register.
 *
 * Pure: no network, no database, no server-only.
 */

/** One DNS label under .co.uk: 1-63 characters, no leading or trailing hyphen. The schema's check is the same pattern. */
export const CO_UK_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.co\.uk$/;

/** Brands we never register. airbnb, vrbo and stayful are blocked anywhere in the name; booking only at the start (it is also an ordinary word). */
export const BRAND_ANYWHERE = ['airbnb', 'vrbo', 'stayful', 'expedia', 'tripadvisor', 'rightmove', 'zoopla', 'onthemarket'] as const;
export const BRAND_PREFIX = ['booking'] as const;

/** Words dropped from a company name: its legal form. */
const LEGAL_WORDS = new Set(['ltd', 'limited', 'llp', 'plc']);

/** The longest company stem kept: with "management" (10) and a town (12) the label stays within 63. */
const STEM_MAX = 40;
const TOWN_MAX = 12;

function ascii(v: string): string {
  return v.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** The company's own distinctive part as one run of letters and digits: "Harbour Management Ltd" -> "harbour". Empty when nothing is left. */
export function slugFromCompany(company: unknown): string {
  if (typeof company !== 'string') return '';
  // Apostrophes vanish (O'Neil -> oneil); every other symbol, "&" included, is a word break.
  const words = ascii(company.toLowerCase())
    .replace(/['‘’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !LEGAL_WORDS.has(w));
  let joined = words.join('');
  // A trailing "management" is ours to add, not theirs to repeat ("Management Ltd" alone leaves nothing to build on).
  if (joined.endsWith('management')) joined = joined.slice(0, -'management'.length);
  joined = joined.slice(0, STEM_MAX);
  return joined;
}

/** A town as one run of letters and digits, short enough to fit. */
export function townPart(town: unknown): string {
  if (typeof town !== 'string') return '';
  return ascii(town.toLowerCase()).replace(/[^a-z0-9]+/g, '').slice(0, TOWN_MAX);
}

/** Is this name one we may buy: a plain .co.uk label, no punycode, no brand. */
export function validCoUk(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (!CO_UK_NAME.test(name)) return false;
  const label = name.slice(0, -'.co.uk'.length);
  // xn-- (punycode) and any other label with hyphens in its 3rd and 4th place are reserved.
  if (label.startsWith('xn--') || label.slice(2, 4) === '--') return false;
  if (BRAND_ANYWHERE.some((b) => label.includes(b))) return false;
  if (BRAND_PREFIX.some((b) => label.startsWith(b))) return false;
  return true;
}

/**
 * The names to offer, best first, at most 6, all valid, no repeats. The first
 * is the primary (<company>management.co.uk); the rest are alternatives for
 * when it is taken or the member prefers another. `towns` are the member's
 * areas: only the first usable one is used. An empty company gives nothing.
 */
export function candidates(company: unknown, towns: readonly unknown[] = []): string[] {
  const base = slugFromCompany(company);
  if (!base) return [];
  const town = towns.map(townPart).find((t) => t.length > 0) ?? '';
  const labels = [
    `${base}management`,
    `${base}-management`,
    town ? `${base}${town}management` : '',
    `${base}lettings`,
    `${base}-lettings`,
    town ? `${base}${town}lettings` : '',
  ];
  const out: string[] = [];
  for (const label of labels) {
    if (!label) continue;
    const name = `${label}.co.uk`;
    if (validCoUk(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** "harbourmanagement.co.uk" for display and for the one place a name is compared. */
export function normaliseDomain(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase().replace(/\.$/, '') : '';
}
