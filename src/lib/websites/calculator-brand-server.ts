import 'server-only';

import { deleteLogoIfOurs, uploadLogo } from '@/lib/funnels/storage';
import { markCalculatorFieldsEdited } from '@/lib/leaddb/ad-profile-server';
import { calculatorSavePlan } from './calculator-brand';
import type { SiteSettings } from './page-model';
import { saveSettings, type WebsiteRow } from './store-server';

/**
 * Batch 55 (brand on the ads screen): the calculator site's brand writes, shared by the calculator's brand screen
 * (calculator-actions.ts) and the lead database ads screen (/leads/ads actions.ts). The caller has already found the
 * signed-in account owner's own calculator site (calculatorActor); nothing here takes an id from a form.
 *
 * Fields the customer changed are marked edited before the settings are written (calculatorSavePlan), so the lead
 * database push never overwrites the customer's choice. Nothing is logged here but codes: never a name, colour or
 * logo address.
 */

export type CalculatorOwner = { userId: string; site: Pick<WebsiteRow, 'mode' | 'settings' | 'funnelId'> };

export async function saveCalculatorPatch(actor: CalculatorOwner, patch: Partial<SiteSettings>): Promise<{ ok: true } | { ok: false; message: string | null }> {
  const plan = calculatorSavePlan(actor.site.mode, actor.site.settings, patch);
  if (!plan.ok) return { ok: false, message: plan.message };
  await markCalculatorFieldsEdited(actor.userId, plan.edited);
  const saved = await saveSettings(actor.userId, plan.patch);
  return saved.ok ? { ok: true } : { ok: false, message: null };
}

/**
 * A new logo (PNG or JPEG bytes, already size-checked by the caller) through the existing uploadLogo path, against the
 * calculator's own funnel, then saved as the logo. A failed save takes the new file out again; the old logo is removed
 * only once the new one is safely stored.
 */
export async function storeCalculatorLogo(actor: CalculatorOwner, bytes: Uint8Array): Promise<{ ok: true; url: string } | { ok: false; error: string | null; stage: 'upload' | 'save' }> {
  const result = await uploadLogo({ userId: actor.userId, funnelId: actor.site.funnelId, bytes });
  if (!result.ok || !result.url) return { ok: false, error: result.error ?? null, stage: 'upload' };
  const saved = await saveCalculatorPatch(actor, { logoUrl: result.url });
  if (!saved.ok) {
    await deleteLogoIfOurs(result.url);
    return { ok: false, error: null, stage: 'save' };
  }
  await deleteLogoIfOurs(actor.site.settings.logoUrl);
  return { ok: true, url: result.url };
}
