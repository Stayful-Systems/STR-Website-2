/**
 * Batch 55 (Part A), phase A5: what the setup shows and saves for a
 * calculator-only site.
 *
 * A calculator site is live from creation and has no page copy, no approval,
 * no web address of its own, no invite and no transfer. Its owner may change
 * only the brand and contact fields in CALCULATOR_EDITABLE_FIELDS (name, logo,
 * colour, areas, fee, contact email and phone). This module is the one place
 * that says which panels a mode shows and which saved fields a mode accepts,
 * so the page and the server actions cannot drift apart.
 *
 * PURE: no network, no database, no server-only, so it runs under node --test.
 * The normal site (mode 'site') is untouched: every panel shows and every
 * field saves, exactly as before.
 */
import { CALCULATOR_EDITABLE_FIELDS, isCalculatorEditableField, isCalculatorMode, type CalculatorEditableField } from './calculator.ts';
import type { SiteSettings } from './page-model.ts';

/** The parts of the website area an owner can reach, by name. */
export const SETUP_PANELS = [
  'company_logo_colour',
  'areas_fee',
  'contact',
  'photo_about',
  'page_copy',
  'edit_requests',
  'approval',
  'go_live',
  'domain',
  'transfer',
  'grace',
] as const;
export type SetupPanel = (typeof SETUP_PANELS)[number];

/** What a calculator site shows: the three groups of brand and contact fields, nothing else. */
export const CALCULATOR_SETUP_PANELS = ['company_logo_colour', 'areas_fee', 'contact'] as const satisfies readonly SetupPanel[];

/** The saved fields each panel edits. The panels with no fields (copy, approval and so on) edit none. */
export const PANEL_FIELDS: Record<SetupPanel, readonly (keyof SiteSettings)[]> = {
  company_logo_colour: ['companyName', 'logoUrl', 'brandColour'],
  areas_fee: ['areas', 'managementFeePct'],
  contact: ['contactEmail', 'contactPhone'],
  photo_about: ['photoUrl', 'aboutText'],
  page_copy: [],
  edit_requests: [],
  approval: [],
  go_live: [],
  domain: [],
  transfer: [],
  grace: [],
};

/** The panels this site mode shows. A normal site shows all of them; a calculator site only its three. */
export function visibleSetupPanels(mode: unknown): readonly SetupPanel[] {
  return isCalculatorMode(mode) ? CALCULATOR_SETUP_PANELS : SETUP_PANELS;
}

export function setupPanelVisible(mode: unknown, panel: SetupPanel): boolean {
  return visibleSetupPanels(mode).includes(panel);
}

/** The saved fields this site mode lets an owner change: every one on a normal site, the seven brand and contact fields on a calculator site. */
export function editableFieldsFor(mode: unknown): readonly (keyof SiteSettings)[] {
  return isCalculatorMode(mode) ? CALCULATOR_EDITABLE_FIELDS : (Object.keys(PANEL_FIELDS) as SetupPanel[]).flatMap((p) => PANEL_FIELDS[p]);
}

/** Said when a calculator owner tries to change something that is not theirs to change. */
export const CALCULATOR_FIELD_REFUSAL = 'Your calculator only lets you change your company name, logo, colour, areas, fee and contact details.';
/** Said when a calculator owner reaches for the website steps (writing pages, approving, an address, moving the site). */
export const CALCULATOR_FLOW_REFUSAL = 'Your calculator does not have website pages to set up. You can change your company name, logo, colour, areas, fee and contact details.';

export type CalculatorPatchResult =
  | { ok: true; patch: Partial<Pick<SiteSettings, CalculatorEditableField>> }
  | { ok: false; refused: string[]; message: string };

/**
 * A settings change for a calculator site, checked. Every field with a value
 * must be one of CALCULATOR_EDITABLE_FIELDS; a field left undefined is "not
 * changed" and is dropped. Any other field (the photo, the about text, anything
 * unknown) refuses the WHOLE change, so nothing is half-saved. The values are
 * not checked here: the setup's own validators (steps.ts) do that first.
 */
export function calculatorFieldPatch(patch: Record<string, unknown>): CalculatorPatchResult {
  const kept: Record<string, unknown> = {};
  const refused: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isCalculatorEditableField(key)) kept[key] = value;
    else refused.push(key);
  }
  if (refused.length > 0) return { ok: false, refused, message: CALCULATOR_FIELD_REFUSAL };
  return { ok: true, patch: kept as Partial<Pick<SiteSettings, CalculatorEditableField>> };
}

/**
 * The one gate a settings save goes through, for either mode. A normal site's
 * change passes through untouched; a calculator site's is run through
 * calculatorFieldPatch.
 */
export function settingsPatchFor(mode: unknown, patch: Partial<SiteSettings>): { ok: true; patch: Partial<SiteSettings> } | { ok: false; message: string } {
  if (!isCalculatorMode(mode)) return { ok: true, patch };
  const checked = calculatorFieldPatch(patch);
  return checked.ok ? { ok: true, patch: checked.patch } : { ok: false, message: checked.message };
}
