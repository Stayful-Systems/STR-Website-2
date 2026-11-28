/**
 * Batch 55 (brand on the ads screen): the one plan for a calculator site's brand save, shared by the calculator's
 * own brand screen and the lead database ads screen (/leads/ads), so both write the same way.
 *
 * The plan is settingsPatchFor (a calculator accepts only its editable fields) plus changedProfileFields (which of
 * logo, colour, areas and fee the customer really changed). The server marks those in websites.settings_edited BEFORE
 * the settings are written, so a later push from the lead database never fills them again (Fill rule, A1).
 *
 * PURE: no network, no database, no server-only, so it runs under node --test.
 */
import { changedProfileFields, type ProfileSettingField } from '../leaddb/ad-profile.ts';
import { settingsPatchFor } from './calculator-setup.ts';
import type { SiteSettings } from './page-model.ts';

export type CalculatorSavePlan = { ok: true; patch: Partial<SiteSettings>; edited: ProfileSettingField[] } | { ok: false; message: string };

export function calculatorSavePlan(mode: unknown, before: Pick<SiteSettings, ProfileSettingField>, patch: Partial<SiteSettings>): CalculatorSavePlan {
  const gate = settingsPatchFor(mode, patch);
  if (!gate.ok) return { ok: false, message: gate.message };
  return { ok: true, patch: gate.patch, edited: changedProfileFields(before, gate.patch) };
}
