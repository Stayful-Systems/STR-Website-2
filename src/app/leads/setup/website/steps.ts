/**
 * Batch 31, Phase 10: the website setup's five steps, what each one asks for,
 * where someone arriving carries on from, and the preview wiring. Pure: no
 * network, no database, no server-only, so it runs under node --test and the
 * client component and the server actions share one set of rules.
 *
 *   1 Company & logo   2 Areas & fee   3 Contact   4 Photo & about (optional)
 *   5 Write, preview, edit, approve
 *
 * Everything the member types is validated here; nothing in here ever takes an
 * id: the site is always the signed-in owner's (see context.ts).
 */
import { parseHexColour } from '../../../../lib/funnels/brand.ts';
import { checkText, isEmail, isUkPhone } from '../../../../lib/websites/checks.ts';
import { MAX_AREAS, areaSlug, buildSitePages, listAreas, type PageModel, type SiteCopy, type SiteSettings } from '../../../../lib/websites/page-model.ts';
import type { SiteRef, WebsiteStatus } from '../../../../lib/websites/types.ts';

export const WEBSITE_SETUP_PATH = '/leads/setup/website';

export const WEBSITE_STEPS = [
  { step: 1, label: 'Company & logo' },
  { step: 2, label: 'Areas & fee' },
  { step: 3, label: 'Contact' },
  { step: 4, label: 'Photo & about' },
  { step: 5, label: 'Preview & approve' },
] as const;

export type WebsiteStepNo = 1 | 2 | 3 | 4 | 5;

export const stepPath = (n: WebsiteStepNo): string => `${WEBSITE_SETUP_PATH}/${n}`;

/** The step number in an address, or null for anything that is not 1 to 5. */
export function parseStepParam(raw: string | null | undefined): WebsiteStepNo | null {
  return typeof raw === 'string' && /^[1-5]$/.test(raw) ? (Number(raw) as WebsiteStepNo) : null;
}

/** The statuses a member can still edit in; live and paused sites are not edited here (Batch 36). */
export const EDITABLE_STATUSES: readonly WebsiteStatus[] = ['invited', 'setup', 'preview'];
export const isEditable = (status: WebsiteStatus): boolean => EDITABLE_STATUSES.includes(status);

// ── Where to carry on from ──

export interface ResumeFacts {
  settings: SiteSettings;
  hasPages: boolean;
  /** Step 4 has been continued from or skipped. */
  aboutDone: boolean;
}

/** What is still missing before the site can be written: company, an area and fee, a contact. */
export function missingForCopy(s: SiteSettings): string[] {
  const out: string[] = [];
  if (!s.companyName.trim()) out.push('your company name');
  if (listAreas(s.areas).length === 0) out.push('at least one area');
  if (!s.managementFeePct || s.managementFeePct <= 0) out.push('your management fee');
  if (!isEmail(s.contactEmail) || !isUkPhone(s.contactPhone)) out.push('your contact email and phone');
  return out;
}

/** The first step not yet done. */
export function resumeStep(f: ResumeFacts): WebsiteStepNo {
  const s = f.settings;
  if (!s.companyName.trim()) return 1;
  if (listAreas(s.areas).length === 0 || !s.managementFeePct) return 2;
  if (!isEmail(s.contactEmail) || !isUkPhone(s.contactPhone)) return 3;
  if (!f.hasPages && !f.aboutDone) return 4;
  return 5;
}

// ── Validation (each step's fields) ──

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The first leftover-placeholder or banned-claim problem in the member's own words, as one plain sentence. */
function ownWordsProblem(field: string, text: string): string | null {
  const p = checkText('site', field, text)[0];
  return p ? p.message : null;
}

export function validateCompany(raw: { companyName: unknown; brandColour: unknown }): Checked<Pick<SiteSettings, 'companyName' | 'brandColour'>> {
  const companyName = str(raw.companyName, 80);
  if (!companyName) return { ok: false, error: 'Add your company name.' };
  const bad = ownWordsProblem('companyName', companyName);
  if (bad) return { ok: false, error: bad };
  const colourRaw = str(raw.brandColour, 7);
  const brandColour = colourRaw ? parseHexColour(colourRaw) : null;
  if (colourRaw && !brandColour) return { ok: false, error: 'The brand colour needs to be a six-digit hex value, like #1a73e8.' };
  return { ok: true, value: { companyName, brandColour } };
}

/** Areas, one per line or comma separated; duplicates dropped; each must make a page address. */
export function parseAreas(raw: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw ?? '').split(/[\n,]+/)) {
    const name = part.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

export function validateAreas(raw: { areas: unknown; fee: unknown }): Checked<Pick<SiteSettings, 'areas' | 'managementFeePct'>> {
  const areas = parseAreas(raw.areas);
  if (areas.length === 0) return { ok: false, error: 'Add at least one area you cover.' };
  if (areas.length > MAX_AREAS) return { ok: false, error: `Add no more than ${MAX_AREAS} areas.` };
  const unusable = areas.find((a) => !areaSlug(a));
  if (unusable) return { ok: false, error: `"${unusable.slice(0, 30)}" needs some letters or numbers to make a page.` };
  for (const a of areas) {
    const bad = ownWordsProblem('areas', a);
    if (bad) return { ok: false, error: bad };
  }
  const feeText = str(raw.fee, 12).replace(/%/g, '').trim();
  const fee = feeText === '' ? NaN : Number(feeText);
  if (!Number.isFinite(fee) || fee <= 0 || fee > 100) return { ok: false, error: 'Enter your management fee as a percentage, like 15.' };
  return { ok: true, value: { areas, managementFeePct: Math.round(fee * 10) / 10 } };
}

export function validateContact(raw: { email: unknown; phone: unknown }): Checked<Pick<SiteSettings, 'contactEmail' | 'contactPhone'>> {
  const contactEmail = str(raw.email, 254);
  const contactPhone = str(raw.phone, 40);
  if (!isEmail(contactEmail)) return { ok: false, error: 'Enter a valid contact email address.' };
  if (!isUkPhone(contactPhone)) return { ok: false, error: 'Enter a valid UK phone number.' };
  return { ok: true, value: { contactEmail, contactPhone } };
}

export function validateAbout(raw: { aboutText: unknown }): Checked<Pick<SiteSettings, 'aboutText'>> {
  const aboutText = str(raw.aboutText, 2000);
  if (aboutText) {
    const bad = ownWordsProblem('aboutText', aboutText);
    if (bad) return { ok: false, error: bad };
  }
  return { ok: true, value: { aboutText: aboutText || null } };
}

// ── The copy the member edits ──

const COPY_LIMITS = { headline: 200, sub: 300, short: 120, body: 3000, item: 200, question: 300, answer: 2000, benefits: 6, includes: 12, faq: 12 } as const;

/** A stored or posted copy value as a SiteCopy: strings bounded and trimmed, lists capped, or null when the shape is wrong. */
export function sanitiseCopy(raw: unknown): SiteCopy | null {
  const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const o = obj(raw);
  const home = obj(o?.home);
  const fees = obj(o?.fees);
  const about = obj(o?.about);
  const faq = obj(o?.faq);
  if (!o || !home || !fees || !about || !faq || !Array.isArray(o.areas)) return null;
  const L = COPY_LIMITS;
  return {
    home: {
      headline: str(home.headline, L.headline),
      subheadline: str(home.subheadline, L.sub),
      intro: str(home.intro, L.body),
      benefits: arr(home.benefits)
        .slice(0, L.benefits)
        .map((b) => ({ title: str(obj(b)?.title, L.short), body: str(obj(b)?.body, L.body) })),
    },
    areas: arr(o.areas)
      .slice(0, MAX_AREAS)
      .map((a) => ({ area: str(obj(a)?.area, 60), headline: str(obj(a)?.headline, L.headline), body: str(obj(a)?.body, L.body) })),
    fees: {
      headline: str(fees.headline, L.headline),
      body: str(fees.body, L.body),
      includes: arr(fees.includes)
        .slice(0, L.includes)
        .map((i) => str(i, L.item))
        .filter(Boolean),
    },
    about: { headline: str(about.headline, L.headline), body: str(about.body, L.body) },
    faq: {
      headline: str(faq.headline, L.headline),
      items: arr(faq.items)
        .slice(0, L.faq)
        .map((q) => ({ question: str(obj(q)?.question, L.question), answer: str(obj(q)?.answer, L.answer) })),
    },
  };
}

/**
 * The copy with one block per CURRENT area, in order: a block for an area the
 * member has since removed is dropped, and one for a new area starts empty (the
 * checks then ask for it to be written, or the site rewritten).
 */
export function alignCopy(areas: readonly string[], copy: SiteCopy): SiteCopy {
  const have = new Map(copy.areas.map((a) => [a.area.toLowerCase(), a]));
  return { ...copy, areas: listAreas(areas).map((a) => have.get(a.name.toLowerCase()) ?? { area: a.name, headline: '', body: '' }) };
}

// ── The preview ──

/** The settings the preview draws: the saved ones with the member's unsaved colour on top (an invalid colour is ignored). */
export function previewSettings(saved: SiteSettings, draft: { brandColour?: string | null } = {}): SiteSettings {
  const override = draft.brandColour === undefined ? undefined : draft.brandColour === null ? null : parseHexColour(draft.brandColour);
  return override === undefined ? saved : { ...saved, brandColour: override ?? saved.brandColour };
}

/** The page model the preview and the live checks both read: the very model the public site is built from. */
export function previewPages(site: SiteRef, saved: SiteSettings, copy: SiteCopy | null, draft: { brandColour?: string | null } = {}): PageModel[] | null {
  if (!copy) return null;
  return buildSitePages({ site, settings: previewSettings(saved, draft), copy: alignCopy(saved.areas, copy) });
}
