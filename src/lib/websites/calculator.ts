/**
 * Batch 55 (Part A), phase A4: the calculator-only site.
 *
 * A lead database customer with no Academy and no website gets a branded
 * income calculator at a Stayful address (/s/<slug>). It is a `websites` row
 * with `mode = 'calculator'`: no page copy, no invite, no approval, no
 * domain, one page (the branded form and report). The normal site is
 * `mode = 'site'`, which is the database default, so nothing about a normal
 * site changes.
 *
 * PURE: no network, no database, no server-only, so it runs under node --test.
 * The real rows live in store-server.ts (ensureCalculatorSite).
 *
 * Rules that must not drift:
 * - A site that is not in calculator mode always serves, exactly as before.
 * - A calculator site serves unless the lead database ad route is stopped for
 *   its owner (adRouteStopped: no account, no state yet, lapsed, cancelled,
 *   a cancel date that has arrived, or no card). A PAUSED account still serves.
 * - Stopping the page never cuts off a report that is already running: the
 *   report cron works from the report row, not from this check.
 */
import { adRouteStopped, type LeadDbAdAccount } from '../leaddb/ad-account.ts';
import type { SiteCopy, SiteSettings } from './page-model.ts';

/** websites.mode for the calculator-only site. */
export const CALCULATOR_MODE = 'calculator';
/** websites.mode for the Batch 31 website (the column's default). */
export const SITE_MODE = 'site';

export const WEBSITE_MODES = [SITE_MODE, CALCULATOR_MODE] as const;
export type WebsiteMode = (typeof WEBSITE_MODES)[number];

/** True only for the calculator-only site. Anything else (null, a typo, 'site') is a normal site. */
export function isCalculatorMode(mode: unknown): boolean {
  return mode === CALCULATOR_MODE;
}

/** The mode as stored, tolerantly: anything that is not 'calculator' reads as 'site'. */
export function parseWebsiteMode(raw: unknown): WebsiteMode {
  return isCalculatorMode(raw) ? CALCULATOR_MODE : SITE_MODE;
}

/**
 * Whether the public page may be drawn. Non-calculator sites always serve (the
 * ad account is not even looked at). A calculator site serves unless the lead
 * database ad route is stopped for its owner; a paused account still serves.
 */
export function calculatorServes(site: { mode: unknown }, account: LeadDbAdAccount | null, now: Date): boolean {
  if (!isCalculatorMode(site.mode)) return true;
  return !adRouteStopped(account, now);
}

/**
 * The brand fields an owner may edit on a calculator site, by their real
 * `SiteSettings` keys (the same ones the website setup steps save): name,
 * logo, colour, areas, fee and contact details. The photo and the "about"
 * text belong to the full website and are not editable here. Phase A5 builds
 * the setup screen from this list.
 */
export const CALCULATOR_EDITABLE_FIELDS = ['companyName', 'logoUrl', 'brandColour', 'areas', 'managementFeePct', 'contactEmail', 'contactPhone'] as const satisfies readonly (keyof SiteSettings)[];
export type CalculatorEditableField = (typeof CALCULATOR_EDITABLE_FIELDS)[number];

export function isCalculatorEditableField(key: string): key is CalculatorEditableField {
  return (CALCULATOR_EDITABLE_FIELDS as readonly string[]).includes(key);
}

/** A calculator site has no page copy. The page builders read it tolerantly, so this empty copy draws the form and the privacy page from the settings alone. */
export const EMPTY_CALCULATOR_COPY: SiteCopy = {
  home: { headline: '', subheadline: '', intro: '', benefits: [] },
  areas: [],
  fees: { headline: '', body: '', includes: [] },
  about: { headline: '', body: '' },
  faq: { headline: '', items: [] },
};

/**
 * The only paths a calculator site answers: the form page ("") and the
 * privacy page (the consent tick links to it, so it cannot be a dead end).
 * Every other path (fees, about, faq, areas/...) is a 404 in this mode.
 */
export const CALCULATOR_PATHS: readonly string[] = ['', 'privacy'];

export function calculatorHasPath(path: string): boolean {
  return CALCULATOR_PATHS.includes(path);
}
