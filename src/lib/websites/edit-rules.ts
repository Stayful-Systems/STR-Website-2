/**
 * Batch 36: the rules for editing a live customer website. Pure: no network,
 * no database, no server-only, so they run under node --test and both the edit
 * screen and the server share them.
 *
 *   changedFields       which settings differ between two sides
 *   pagesToRewrite      which pages of copy need writing again after a change
 *   filesInUse /
 *   filesToDelete       which uploaded files something still refers to
 *   rewritesLeft /
 *   takeRewrite         the monthly allowance of page rewrites for edits
 *
 * What is rewritten (the plan's rule, and nothing more):
 *   an added area                 its area page is written
 *   a removed area                its page is dropped (nothing is written)
 *   a page whose text names the OLD company name or a REMOVED area
 *                                 that page is written again
 *   a changed about text          the about page is written again
 *   fee, phone, email, logo, colour, photo
 *                                 nothing: the copy writer never sees them (the
 *                                 fee is never in the copy), so they only
 *                                 re-run the checks
 *
 * "before" and "after" are two states of the same site. The edit run passes
 * the draft as it was before a change and as it is after (for the first change
 * the "before" is the live site), so a page already rewritten is not asked for
 * again by an unrelated later change.
 */
import { listAreas, type SiteCopy, type SiteSettings } from './page-model.ts';
import type { CopyPage } from './copy-prompt.ts';

/** Page rewrites an owner may spend on edits per calendar month (Europe/London). Separate from setup's 10. */
export const WEBSITE_EDIT_REWRITES_PER_MONTH = 10;

/** Versions kept per site (the first is the approved site). */
export const WEBSITE_VERSIONS_KEPT = 10;

// ── Changed fields ──

export type SettingsField = keyof SiteSettings;

const FIELDS: readonly SettingsField[] = ['companyName', 'logoUrl', 'brandColour', 'areas', 'managementFeePct', 'contactEmail', 'contactPhone', 'photoUrl', 'aboutText'];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The settings that differ, in a fixed order. */
export function changedFields(live: SiteSettings, draft: SiteSettings): SettingsField[] {
  return FIELDS.filter((f) => !same(live[f], draft[f]));
}

// ── Which pages to write again ──

/** One page of copy. `area` is set on an area page (the area's name). */
export interface PageRef {
  page: CopyPage;
  area?: string;
}

/** A stable key for a page: "home", "fees", "about", "faq" or "area:<lowercase name>". */
export function pageRefKey(ref: PageRef): string {
  return ref.page === 'area' ? `area:${(ref.area ?? '').toLowerCase()}` : ref.page;
}

export function parsePageRefKey(key: string): PageRef | null {
  if (key === 'home' || key === 'fees' || key === 'about' || key === 'faq') return { page: key };
  if (key.startsWith('area:') && key.length > 5) return { page: 'area', area: key.slice(5) };
  return null;
}

export interface EditSide {
  settings: SiteSettings;
  /** The copy the text is scanned in: the side's own pages. Null scans nothing. */
  copy: SiteCopy | null;
}

export interface RewritePlan {
  /** Pages to write (in a stable order: home, areas, fees, about, faq). */
  rewrite: PageRef[];
  /** Area names whose page is dropped. */
  drop: string[];
}

const NONE: RewritePlan = { rewrite: [], drop: [] };

const norm = (s: string): string => s.trim().toLowerCase();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `text` names `needle` as a whole word or phrase, any case. A needle under 2 characters never matches. */
function names(text: string, needle: string): boolean {
  const n = needle.trim();
  if (n.length < 2) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Every piece of text on one page of copy, joined. */
export function copyTextOf(copy: SiteCopy, ref: PageRef): string {
  const parts: string[] = [];
  if (ref.page === 'home') {
    parts.push(copy.home.headline, copy.home.subheadline, copy.home.intro);
    for (const b of copy.home.benefits) parts.push(b.title, b.body);
  } else if (ref.page === 'area') {
    const a = copy.areas.find((x) => norm(x.area) === norm(ref.area ?? ''));
    if (a) parts.push(a.headline, a.body);
  } else if (ref.page === 'fees') {
    parts.push(copy.fees.headline, copy.fees.body, ...copy.fees.includes);
  } else if (ref.page === 'about') {
    parts.push(copy.about.headline, copy.about.body);
  } else {
    parts.push(copy.faq.headline);
    for (const q of copy.faq.items) parts.push(q.question, q.answer);
  }
  return parts.filter(Boolean).join('\n');
}

/** Every page of a copy, in order, area pages for the given area names. */
function allRefs(areaNames: readonly string[]): PageRef[] {
  return [{ page: 'home' }, ...areaNames.map((a) => ({ page: 'area' as const, area: a })), { page: 'fees' }, { page: 'about' }, { page: 'faq' }];
}

/**
 * The pages to write again (and the area pages to drop) when a site goes from
 * `before` to `after`. A change to the fee, contact details, logo, colour or
 * photo gives an empty plan.
 */
export function pagesToRewrite(before: EditSide, after: EditSide): RewritePlan {
  const b = listAreas(before.settings.areas).map((a) => a.name);
  const a = listAreas(after.settings.areas).map((x) => x.name);
  const beforeSet = new Set(b.map(norm));
  const afterSet = new Set(a.map(norm));
  const added = a.filter((n) => !beforeSet.has(norm(n)));
  const removed = b.filter((n) => !afterSet.has(norm(n)));
  const nameChanged = norm(before.settings.companyName) !== norm(after.settings.companyName);
  const aboutChanged = (before.settings.aboutText ?? '').trim() !== (after.settings.aboutText ?? '').trim();

  if (added.length === 0 && removed.length === 0 && !nameChanged && !aboutChanged) return NONE;

  const want = new Map<string, PageRef>();
  const addRef = (ref: PageRef) => want.set(pageRefKey(ref), ref);

  for (const n of added) addRef({ page: 'area', area: n });
  if (aboutChanged) addRef({ page: 'about' });

  // Pages that still name the old company or a removed area, in the text as it stands now.
  const scan = before.copy;
  if (scan && (nameChanged || removed.length > 0)) {
    const oldName = before.settings.companyName;
    const droppedKeys = new Set(removed.map((n) => pageRefKey({ page: 'area', area: n })));
    for (const ref of allRefs(scan.areas.map((x) => x.area))) {
      const key = pageRefKey(ref);
      if (droppedKeys.has(key)) continue; // its page goes, nothing to rewrite
      // A page only has a place in the new site if it is not an area the site no longer has.
      if (ref.page === 'area' && !afterSet.has(norm(ref.area ?? ''))) continue;
      const text = copyTextOf(scan, ref);
      if (!text) continue;
      if ((nameChanged && names(text, oldName)) || removed.some((n) => names(text, n))) addRef(ref);
    }
  }

  const order = (r: PageRef): number => (r.page === 'home' ? 0 : r.page === 'area' ? 1 : r.page === 'fees' ? 2 : r.page === 'about' ? 3 : 4);
  const rewrite = [...want.values()].sort((x, y) => order(x) - order(y) || (x.area ?? '').localeCompare(y.area ?? ''));
  return { rewrite, drop: removed };
}

// ── Uploaded files ──

export interface HasSettings {
  settings: Pick<SiteSettings, 'logoUrl' | 'photoUrl'> | null;
}

/** The logo and photo files something still refers to: the live site, the draft (when there is one) and every kept version. */
export function filesInUse(live: HasSettings | null, draft: HasSettings | null, versions: readonly HasSettings[]): Set<string> {
  const out = new Set<string>();
  for (const side of [live, draft, ...versions]) {
    const s = side?.settings;
    if (!s) continue;
    if (s.logoUrl) out.add(s.logoUrl);
    if (s.photoUrl) out.add(s.photoUrl);
  }
  return out;
}

/**
 * The files that were in use before and nothing refers to now: the only ones
 * that may be deleted. A replaced logo is NOT deleted while any kept version
 * still shows it (a restore would point at nothing).
 */
export function filesToDelete(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  return [...before].filter((f) => !after.has(f));
}

// ── The monthly rewrite allowance ──

/** The calendar month in Europe/London, "YYYY-MM". */
export function ukMonth(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '00';
  return `${y}-${m}`;
}

/** How many rewrites are left this month: a new month starts again at the full allowance. */
export function rewritesLeft(used: number, month: string | null, now: Date, perMonth: number = WEBSITE_EDIT_REWRITES_PER_MONTH): number {
  if (month !== ukMonth(now)) return perMonth;
  return Math.max(0, perMonth - Math.max(0, used));
}

/**
 * The counter after taking one rewrite, or null when none are left. The server
 * applies this as a conditional update (the old month and used must still be
 * what was read), so two edits at once cannot both take the last one.
 */
export function takeRewrite(used: number, month: string | null, now: Date, perMonth: number = WEBSITE_EDIT_REWRITES_PER_MONTH): { month: string; used: number } | null {
  const current = ukMonth(now);
  if (month !== current) return perMonth >= 1 ? { month: current, used: 1 } : null;
  if (used >= perMonth) return null;
  return { month: current, used: Math.max(0, used) + 1 };
}
