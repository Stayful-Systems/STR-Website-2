/**
 * Batch 31: the data for every public page of a customer website, built from
 * the member's site settings and the copy (hand-written or AI drafted). The
 * templates (Phase 8) render it and the checks (checks.ts) read the very same
 * object, so what is checked is what is shown.
 *
 *   SiteSettings   what the member told us (company, logo, colour, areas, fee,
 *                  contact, optional photo and about text)
 *   SiteCopy       the per-page copy blocks (never a figure: the management
 *                  fee comes from the settings and is put in by buildSitePages)
 *   buildSitePages -> PageModel[]: home, one page per area, fees, about, faq,
 *                  privacy. Every link is built with siteHref.
 *
 * The consent wording is `consentText` from funnels/brand.ts, the same text the
 * funnel form shows, so the privacy page and the form cannot drift apart.
 *
 * Pure: no network, no database, no server-only.
 */
import { EMPTY_BRAND, consentText, parseHexColour, parseLogoUrl, readableOn } from '../funnels/brand.ts';
import { normaliseMobile } from '../credit/abuse.ts';
import { siteDomain, siteHref } from './urls.ts';
import type { SiteRef } from './types.ts';

// ── What the member gives us ──

export interface SiteSettings {
  companyName: string;
  /** https PNG/JPEG, as for a funnel logo. */
  logoUrl: string | null;
  /** #rrggbb. Null falls back to the template's own colour. */
  brandColour: string | null;
  /** Areas covered, in the order shown. One page each. */
  areas: string[];
  /** Management fee as a percentage, e.g. 15. */
  managementFeePct: number | null;
  contactEmail: string;
  contactPhone: string;
  /** Optional: a photo of the member or team (https). */
  photoUrl: string | null;
  /** Optional: the member's own words about themselves. */
  aboutText: string | null;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface SiteCopy {
  home: { headline: string; subheadline: string; intro: string; benefits: { title: string; body: string }[] };
  /** One block per area, matched to SiteSettings.areas by name. */
  areas: { area: string; headline: string; body: string }[];
  fees: { headline: string; body: string; includes: string[] };
  about: { headline: string; body: string };
  faq: { headline: string; items: FaqItem[] };
  privacy?: { intro?: string };
}

export const MAX_AREAS = 12;

// ── What a page is ──

export const PAGE_KEYS = ['home', 'area', 'fees', 'about', 'faq', 'privacy'] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export interface Section {
  id: string;
  heading: string | null;
  paragraphs: string[];
  items: string[];
}

export interface NavLink {
  label: string;
  href: string;
}

/** Step-1 field limits. The lead API (Phase 6) truncates to the same lengths. */
export const STEP1_FIELDS = [
  { name: 'name', label: 'Your name', type: 'text', autocomplete: 'name', maxLength: 120, required: true },
  { name: 'email', label: 'Email address', type: 'email', autocomplete: 'email', maxLength: 254, required: true },
  { name: 'phone', label: 'Phone number', type: 'tel', autocomplete: 'tel', maxLength: 40, required: true },
] as const;

export interface LeadFormField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel';
  autocomplete: string;
  maxLength: number;
  required: boolean;
}

/** Step 1 of the two-step landlord form. Step 2 (the address) is asked after this saves. */
export interface LeadFormDescriptor {
  step: 1;
  /** The lead API the form posts to (Phase 6). */
  action: string;
  fields: LeadFormField[];
  /** The checkbox's field name in the post body. */
  consentField: 'consent';
  consentText: string;
  submitLabel: string;
  privacyHref: string;
  /** Batch 33: the site is on its own domain, where the bot-check widget is not used (the server decides again). */
  skipBotCheck?: boolean;
}

export interface SiteIdentity {
  companyName: string;
  logoUrl: string | null;
  /** A valid #rrggbb or null. */
  primary: string | null;
  /** Readable text colour on `primary` (funnels/brand readableOn), or null with no primary. */
  onPrimary: string | null;
  contactEmail: string;
  contactPhone: string;
  /** tel: number (+44...), null when the phone is not a number we can dial. */
  phoneTel: string | null;
  photoUrl: string | null;
}

export interface PageModel {
  key: PageKey;
  /** Inside the site: "" (home), "fees", "areas/<slug>". */
  path: string;
  /** siteHref(site, path). */
  href: string;
  /** Set on an area page. */
  area: { name: string; slug: string } | null;
  title: string;
  heading: string;
  intro: string;
  sections: Section[];
  faq: FaqItem[];
  /** The lead form, or null on a page that has none (privacy). */
  form: LeadFormDescriptor | null;
  nav: NavLink[];
  areaLinks: NavLink[];
  footer: NavLink[];
  site: SiteIdentity;
}

// ── Small helpers ──

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Blank-line separated paragraphs. */
export function paragraphsOf(text: unknown): string[] {
  return clean(text)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** An area's path segment: lowercase a-z0-9 and hyphens. Empty when nothing usable is left. */
export function areaSlug(name: string): string {
  return clean(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** The areas with a unique slug each, capped at MAX_AREAS; blank or unusable names are dropped. */
export function listAreas(areas: readonly string[]): { name: string; slug: string }[] {
  const out: { name: string; slug: string }[] = [];
  const seen = new Set<string>();
  for (const raw of areas ?? []) {
    const name = clean(raw).slice(0, 60);
    const base = areaSlug(name);
    if (!name || !base) continue;
    let slug = base;
    for (let n = 2; seen.has(slug); n++) slug = `${base}-${n}`;
    seen.add(slug);
    out.push({ name, slug });
    if (out.length >= MAX_AREAS) break;
  }
  return out;
}

const section = (id: string, heading: string | null, paragraphs: string[] = [], items: string[] = []): Section => ({ id, heading, paragraphs, items });

function identityOf(s: SiteSettings): SiteIdentity {
  const primary = parseHexColour(s.brandColour);
  const tel = normaliseMobile(s.contactPhone);
  return {
    companyName: clean(s.companyName),
    logoUrl: s.logoUrl ? parseLogoUrl(s.logoUrl) : null,
    primary,
    onPrimary: primary ? readableOn(primary) : null,
    contactEmail: clean(s.contactEmail),
    contactPhone: clean(s.contactPhone),
    phoneTel: tel && tel.startsWith('+44') ? tel : null,
    photoUrl: clean(s.photoUrl) || null,
  };
}

/** The step-1 form for this site. */
export function leadFormFor(site: SiteRef, companyName: string): LeadFormDescriptor {
  return {
    step: 1,
    action: `/api/s/${encodeURIComponent(site.slug)}/lead`,
    fields: STEP1_FIELDS.map((f) => ({ ...f })),
    consentField: 'consent',
    consentText: consentText({ ...EMPTY_BRAND, companyName: clean(companyName) || null }),
    submitLabel: 'Get my free estimate',
    privacyHref: siteHref(site, 'privacy'),
    ...(siteDomain(site) ? { skipBotCheck: true } : {}),
  };
}

/** The fee as the site shows it ("15%"), or null when it is not set. */
export function feeLabel(pct: number | null | undefined): string | null {
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) return null;
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(1))}%`;
}

// ── The pages ──

/** Every public page of a site, in navigation order: home, areas, fees, about, faq, privacy. */
export function buildSitePages(input: { site: SiteRef; settings: SiteSettings; copy: SiteCopy }): PageModel[] {
  const { site, settings, copy } = input;
  const identity = identityOf(settings);
  const company = identity.companyName;
  const areas = listAreas(settings.areas);
  const form = leadFormFor(site, company);

  const nav: NavLink[] = [
    { label: 'Home', href: siteHref(site, '') },
    { label: 'Fees', href: siteHref(site, 'fees') },
    { label: 'About', href: siteHref(site, 'about') },
    { label: 'FAQ', href: siteHref(site, 'faq') },
  ];
  const areaLinks: NavLink[] = areas.map((a) => ({ label: a.name, href: siteHref(site, `areas/${a.slug}`) }));
  const footer: NavLink[] = [{ label: 'Privacy', href: siteHref(site, 'privacy') }];

  const page = (p: Omit<PageModel, 'href' | 'title' | 'nav' | 'areaLinks' | 'footer' | 'site' | 'faq' | 'area'> & { faq?: FaqItem[]; area?: PageModel['area'] }): PageModel => ({
    faq: [],
    area: null,
    ...p,
    href: siteHref(site, p.path),
    title: [p.heading, company].filter(Boolean).join(' | '),
    nav,
    areaLinks,
    footer,
    site: identity,
  });

  const pages: PageModel[] = [];

  // Home
  const home = copy?.home;
  pages.push(
    page({
      key: 'home',
      path: '',
      heading: clean(home?.headline),
      intro: clean(home?.subheadline),
      sections: [
        ...(paragraphsOf(home?.intro).length ? [section('intro', null, paragraphsOf(home?.intro))] : []),
        ...(home?.benefits ?? []).map((b, i) => section(`benefit-${i + 1}`, clean(b?.title) || null, paragraphsOf(b?.body))),
        ...(areas.length ? [section('areas', 'Areas we cover', [], areas.map((a) => a.name))] : []),
      ],
      form,
    }),
  );

  // One page per area
  for (const a of areas) {
    const block = (copy?.areas ?? []).find((x) => clean(x?.area).toLowerCase() === a.name.toLowerCase());
    pages.push(
      page({
        key: 'area',
        path: `areas/${a.slug}`,
        area: { name: a.name, slug: a.slug },
        heading: clean(block?.headline),
        intro: '',
        sections: [section('body', null, paragraphsOf(block?.body))],
        form,
      }),
    );
  }

  // Fees: the figure is the member's setting, never the copy's
  const fee = feeLabel(settings.managementFeePct);
  const feeBody = paragraphsOf(copy?.fees?.body);
  pages.push(
    page({
      key: 'fees',
      path: 'fees',
      heading: clean(copy?.fees?.headline),
      intro: '',
      sections: [
        section('fee', 'Our management fee', fee ? [`Our management fee is ${fee}.`] : []),
        ...(feeBody.length ? [section('body', null, feeBody)] : []),
        ...((copy?.fees?.includes ?? []).map(clean).filter(Boolean).length
          ? [section('includes', 'What is included', [], (copy.fees.includes ?? []).map(clean).filter(Boolean))]
          : []),
      ],
      form,
    }),
  );

  // About: the copy, then the member's own words if they gave some
  const aboutOwn = paragraphsOf(settings.aboutText);
  pages.push(
    page({
      key: 'about',
      path: 'about',
      heading: clean(copy?.about?.headline),
      intro: '',
      sections: [
        section('body', null, paragraphsOf(copy?.about?.body)),
        ...(aboutOwn.length ? [section('owner', `From ${company || 'us'}`, aboutOwn)] : []),
      ],
      form,
    }),
  );

  // FAQ
  pages.push(
    page({
      key: 'faq',
      path: 'faq',
      heading: clean(copy?.faq?.headline),
      intro: '',
      sections: [],
      faq: (copy?.faq?.items ?? []).map((q) => ({ question: clean(q?.question), answer: clean(q?.answer) })),
      form,
    }),
  );

  // Privacy: the operator is the data controller, Stayful the processor
  const consent = form.consentText;
  const who = company || 'the company running this site';
  pages.push(
    page({
      key: 'privacy',
      path: 'privacy',
      heading: 'Privacy',
      intro: clean(copy?.privacy?.intro),
      sections: [
        section('controller', 'Who is responsible for your details', [
          `${who} is the data controller for the details you give on this site. Stayful Intelligence processes them on its behalf to produce your estimate and does not use them for anything else.`,
        ]),
        section('collect', 'What we collect', [], ['Your name, email address and phone number.', 'The address of the property you ask about.']),
        section('consent', 'What you agree to', [consent]),
        section('contact', 'Contact', [
          [identity.contactEmail && `Email ${identity.contactEmail}`, identity.contactPhone && `phone ${identity.contactPhone}`].filter(Boolean).join(' or ') ||
            '',
        ].filter(Boolean)),
      ],
      form: null,
    }),
  );

  return pages;
}

/** The page at `path` ("" for home), or null. */
export function pageAt(pages: readonly PageModel[], path: string): PageModel | null {
  const p = clean(path).replace(/^\/+|\/+$/g, '');
  return pages.find((x) => x.path === p) ?? null;
}

// ── Reading a page as text ──

export interface PageField {
  /** A stable name for the field, e.g. "heading", "section:fee.paragraph", "faq.2.answer". */
  field: string;
  text: string;
}

/** Every piece of text a visitor can read on the page, named. The checks scan exactly these. */
export function pageFields(page: PageModel): PageField[] {
  const out: PageField[] = [
    { field: 'title', text: page.title },
    { field: 'heading', text: page.heading },
    { field: 'intro', text: page.intro },
  ];
  for (const s of page.sections) {
    if (s.heading) out.push({ field: `section:${s.id}.heading`, text: s.heading });
    s.paragraphs.forEach((t, i) => out.push({ field: `section:${s.id}.paragraph${i + 1}`, text: t }));
    s.items.forEach((t, i) => out.push({ field: `section:${s.id}.item${i + 1}`, text: t }));
  }
  page.faq.forEach((q, i) => {
    out.push({ field: `faq.${i + 1}.question`, text: q.question });
    out.push({ field: `faq.${i + 1}.answer`, text: q.answer });
  });
  if (page.form) {
    out.push({ field: 'form.consent', text: page.form.consentText });
    out.push({ field: 'form.submit', text: page.form.submitLabel });
  }
  return out;
}

/** The site's own details, as text, for the same scan. */
export function identityFields(id: SiteIdentity): PageField[] {
  return [
    { field: 'companyName', text: id.companyName },
    { field: 'contactEmail', text: id.contactEmail },
    { field: 'contactPhone', text: id.contactPhone },
  ];
}
