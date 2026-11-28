/**
 * Batch 55 step 5 (Phase 3): where a LEAD DATABASE customer finds landlords, and how the ads say it.
 *
 * A lead database pack (ad_packs.route = 'leaddb') covers either the whole UK (the default on the start screen) or 1 to
 * MAX_COVERAGE_AREAS places the customer picks. Stored on the pack as `coverage` ('uk' | 'areas') and `coverage_areas`
 * (the place names the ads say, in the order chosen). A pack made before this (coverage null) reads as 'areas' with
 * its one area label, exactly what its ads said.
 *
 * The phrases (all pure, all tested in coverage.test.ts):
 *
 *   inAreaPhrase     the audience, inside the first 125 characters of every primary text:
 *                      uk        "across the UK"
 *                      1 to 3    "in Leeds", "in Leeds and York", "in Leeds, York and Harrogate"
 *                      4 or more "in Leeds, York, Harrogate and nearby areas"
 *                    (kept short: when the names are long it names fewer, then "and nearby areas")
 *   manageSentence   one sentence naming EVERY chosen area: "Acme manages short lets in Leeds, York, Harrogate,
 *                    Wakefield and Bradford." / "Acme manages short lets across the UK."
 *   shortInPhrase    the on-screen and headline form: up to 2 names, then "and more" ("in Leeds, York and more")
 *   spokenInPhrase   the voiceover form: up to 2 names, then "and nearby areas" (said aloud, "and more" reads oddly)
 *   offerNeedle      what the gate looks for in the first 125 characters and on frame one: "uk", or the first area
 *   lookKey          the same-area look rule's key (ld-gate.ts chooseLook): UK_LOOK_KEY for nationwide, else the first
 *                    chosen area's figure key (the caller passes it). Deliberately simple: two customers share a look
 *                    pool only when both are nationwide or both start from the same area.
 *
 * In a list of two or more, a district label "Lenton, Nottingham" is said by its first part ("Lenton"), so the commas
 * of the list stay readable. One area alone keeps its full label, as the ads said before this.
 *
 * Pure: no network, no database, no server-only.
 */

export const COVERAGE_MODES = ['uk', 'areas'] as const;
export type CoverageMode = (typeof COVERAGE_MODES)[number];
export type Coverage = { mode: 'uk'; areas: [] } | { mode: 'areas'; areas: string[] };

export const MAX_COVERAGE_AREAS = 10;
export const MAX_COVERAGE_AREA_CHARS = 80;
/** The look-pool key of a nationwide pack (area keys are upper-case postcode codes, so it can never clash). */
export const UK_LOOK_KEY = 'uk';
export const UK_COVERAGE: Coverage = { mode: 'uk', areas: [] };

/** The longest audience phrase allowed in the opening sentence, so the offer stays inside 125 characters. */
const MAX_IN_PHRASE = 52;
/** The longest on-screen phrase (frame one and the headline bar). */
const MAX_SHORT_PHRASE = 36;

export function isCoverageMode(v: unknown): v is CoverageMode {
  return v === 'uk' || v === 'areas';
}

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The chosen names, tidied: trimmed, no repeats (case does not matter), each 1 to 80 characters. Null when any entry
 * is not a string, is empty or too long, or there are more than MAX_COVERAGE_AREAS (nothing is silently dropped).
 */
export function cleanCoverageAreas(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') return null;
    const s = clean(v);
    if (s.length < 1 || s.length > MAX_COVERAGE_AREA_CHARS) return null;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.length > MAX_COVERAGE_AREAS ? null : out;
}

/** A coverage from its parts, or null when they do not make one ('areas' needs 1 to 10 names; 'uk' takes none). */
export function makeCoverage(mode: unknown, areas: unknown): Coverage | null {
  if (mode === 'uk') return { mode: 'uk', areas: [] };
  if (mode !== 'areas') return null;
  const list = cleanCoverageAreas(areas);
  return list && list.length > 0 ? { mode: 'areas', areas: list } : null;
}

/**
 * The coverage a stored pack's ads say. coverage null (the Academy, or a lead database pack made before Phase 3) is
 * 'areas' with its one area label, so an in-flight pack keeps today's wording. No label at all: 'areas' with none,
 * which the phrases read as "your area".
 */
export function coverageOfPack(p: { coverage?: string | null; coverageAreas?: readonly string[] | null; areaLabel?: string | null }): Coverage {
  if (p.coverage === 'uk') return { mode: 'uk', areas: [] };
  if (p.coverage === 'areas') {
    const list = cleanCoverageAreas([...(p.coverageAreas ?? [])]);
    if (list && list.length > 0) return { mode: 'areas', areas: list };
  }
  const label = clean(p.areaLabel);
  return { mode: 'areas', areas: label ? [label.slice(0, MAX_COVERAGE_AREA_CHARS)] : [] };
}

/** The names as the ads say them: one area its full label; in a list, each label's first part (before a comma). */
export function spokenNames(c: Coverage): string[] {
  if (c.mode === 'uk') return [];
  const names = c.areas.map(clean).filter(Boolean);
  if (names.length < 2) return names;
  return names.map((n) => clean(n.split(',')[0]) || n);
}

/** "A", "A and B", "A, B and C". */
export function joinNatural(names: readonly string[]): string {
  const n = names.filter((x) => x !== '');
  if (n.length <= 1) return n[0] ?? '';
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/** Up to `max` names then `tail`, shortened (fewer names) until it fits `maxLen`; at least the first name. */
function listPhrase(names: readonly string[], max: number, tail: string, maxLen: number): string {
  const all = joinNatural(names);
  if (names.length <= max && all.length <= maxLen) return all;
  for (let k = Math.min(max, names.length - 1); k >= 1; k--) {
    const p = `${names.slice(0, k).join(', ')} and ${tail}`;
    if (p.length <= maxLen || k === 1) return p;
  }
  return names[0] ?? '';
}

/** The audience phrase of the opening sentence: "across the UK", "in Leeds, York and Harrogate", "... and nearby areas". */
export function inAreaPhrase(c: Coverage): string {
  if (c.mode === 'uk') return 'across the UK';
  const names = spokenNames(c);
  if (names.length === 0) return 'in your area';
  return `in ${listPhrase(names, 3, 'nearby areas', MAX_IN_PHRASE)}`;
}

/** The on-screen form: "across the UK", "in Leeds and York", "in Leeds, York and more". */
export function shortInPhrase(c: Coverage): string {
  if (c.mode === 'uk') return 'across the UK';
  const names = spokenNames(c);
  if (names.length === 0) return 'in your area';
  return `in ${listPhrase(names, 2, 'more', MAX_SHORT_PHRASE)}`;
}

/** The voiceover form: "across the UK", "in Leeds and York", "in Leeds, York and nearby areas". */
export function spokenInPhrase(c: Coverage): string {
  if (c.mode === 'uk') return 'across the UK';
  const names = spokenNames(c);
  if (names.length === 0) return 'in your area';
  return `in ${listPhrase(names, 2, 'nearby areas', MAX_SHORT_PHRASE + 10)}`;
}

/** "Acme manages short lets across the UK." / "... in Leeds, York and Harrogate." (every chosen area). */
export function manageSentence(company: string, c: Coverage, opts: { short?: boolean } = {}): string {
  const who = clean(company) || 'Our team';
  const where = opts.short ? inAreaPhrase(c) : c.mode === 'uk' ? 'across the UK' : spokenNames(c).length > 0 ? `in ${joinNatural(spokenNames(c))}` : 'in your area';
  return `${who} manages short lets ${where}.`;
}

/** The place names of a headline, as candidates longest first (the caller fits one in 40): "Leeds and York", "Leeds, York and more", "Leeds and more", "Leeds", "your area". */
export function placeCandidates(c: Coverage): string[] {
  if (c.mode === 'uk') return ['the UK'];
  const names = spokenNames(c);
  const out: string[] = [];
  if (names.length >= 1 && names.length <= 2) out.push(joinNatural(names));
  if (names.length >= 3) out.push(`${names.slice(0, 2).join(', ')} and more`);
  if (names.length >= 2) out.push(`${names[0]} and more`);
  if (names.length >= 1) out.push(names[0]);
  out.push('your area');
  return out;
}

/** What the gate looks for, lower-case: "uk", or the first area as the ads say it ('' when there is none). */
export function offerNeedle(c: Coverage): string {
  if (c.mode === 'uk') return 'uk';
  return (spokenNames(c)[0] ?? '').toLowerCase();
}

/** True when `text` (lower-cased by the caller or not) names the coverage: the word UK, or the first area. */
export function namesCoverage(text: string, c: Coverage): boolean {
  const t = String(text ?? '').toLowerCase();
  if (c.mode === 'uk') return /\buk\b/.test(t);
  const needle = offerNeedle(c);
  return needle === '' || t.includes(needle);
}

/** The same-area look key: UK_LOOK_KEY when nationwide, else the area key the example figure comes from. */
export function lookKey(c: Coverage, figureAreaKey: string): string {
  return c.mode === 'uk' ? UK_LOOK_KEY : figureAreaKey;
}

/** Every phrase and name the ads may say about where the customer works (for the facts list). */
export function coverageFacts(c: Coverage): { names: string[]; phrases: string[] } {
  const names = c.mode === 'uk' ? [] : [...new Set([...c.areas.map(clean), ...spokenNames(c)])].filter(Boolean);
  const phrases = [...new Set([inAreaPhrase(c), shortInPhrase(c), spokenInPhrase(c), c.mode === 'uk' ? 'UK' : ''])].filter(Boolean);
  return { names, phrases };
}

/** The stored columns of a coverage: ad_packs.coverage and ad_packs.coverage_areas. */
export function coverageColumns(c: Coverage): { coverage: CoverageMode; coverageAreas: string[] } {
  return { coverage: c.mode, coverageAreas: c.mode === 'uk' ? [] : [...c.areas] };
}
