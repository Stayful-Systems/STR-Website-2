'use server';

import { revalidatePath } from 'next/cache';
import { recordActivity } from '@/lib/activity/log';
import { LOGO_MAX_BYTES } from '@/lib/funnels/brand';
import { deleteLogoIfOurs, uploadLogo } from '@/lib/funnels/storage';
import { settingsPatchFor } from '@/lib/websites/calculator-setup';
import { saveSettings } from '@/lib/websites/store-server';
import { calculatorActor, type CalculatorActor } from './context';
import type { WebsiteState } from './actions';
import { validateAreas, validateCompany, validateContact } from './steps';

/**
 * Batch 55 (Part A), phase A5: the calculator site's brand writes.
 *
 * A calculator site (websites.mode = 'calculator') is live from creation and
 * has no page copy, approval, address or transfer, so it has none of the
 * website setup's actions (actions.ts and every other website action refuse it).
 * Its owner can change only the seven fields in CALCULATOR_EDITABLE_FIELDS:
 * company name, logo, colour, areas, fee, contact email and phone.
 *
 * Every action starts with owner() (calculatorActor): the signed-in ACCOUNT
 * OWNER, whose own calculator site is the one acted on. No action takes a
 * website, funnel or user id from its arguments or the form, so there is
 * nothing to forge. The setup's own validators (steps.ts) check each value, and
 * the save goes through settingsPatchFor, which refuses a calculator change to
 * any other field (the photo, the about text) however it got here.
 *
 * Nothing here logs a name, email, phone or address: the one activity row
 * carries the field names only.
 */

const DENIAL = {
  signed_out: 'Please sign in again.',
  not_owner: 'Only the account owner can change the calculator.',
  not_calculator: 'Your calculator has not been set up for your account yet.',
  unavailable: 'We could not do that just now. Please try again.',
} as const;

type Owner = { ok: true; actor: CalculatorActor } | { ok: false; error: string };

async function owner(): Promise<Owner> {
  const r = await calculatorActor();
  if (!r.ok) return { ok: false, error: DENIAL[r.reason] };
  return { ok: true, actor: r.actor };
}

const refresh = () => revalidatePath('/leads/setup/website', 'layout');

/** All seven fields at once: name and colour, areas and fee, contact. Each is checked by the setup's own validator first. */
export async function saveCalculatorBrandAction(_prev: WebsiteState, formData: FormData): Promise<WebsiteState> {
  const who = await owner();
  if (!who.ok) return { error: who.error };
  const { actor } = who;

  const company = validateCompany({ companyName: formData.get('companyName'), brandColour: formData.get('brandColour') });
  if (!company.ok) return { error: company.error };
  const areas = validateAreas({ areas: formData.get('areas'), fee: formData.get('fee') });
  if (!areas.ok) return { error: areas.error };
  const contact = validateContact({ email: formData.get('email'), phone: formData.get('phone') });
  if (!contact.ok) return { error: contact.error };

  const gate = settingsPatchFor(actor.site.mode, { ...company.value, ...areas.value, ...contact.value });
  if (!gate.ok) return { error: gate.message };
  const saved = await saveSettings(actor.userId, gate.patch);
  if (!saved.ok) return { error: 'We could not save that just now. Please try again.' };
  await recordActivity(actor.userId, 'funnel_setup_step', { extras: { calculator: true, fields: Object.keys(gate.patch).join(',') } });
  refresh();
  return { saved: true };
}

/** The logo: PNG or JPEG, through the existing uploadLogo path, stored against the calculator's own funnel (read from the site, never the form). */
export async function uploadCalculatorLogoAction(_prev: WebsiteState, formData: FormData): Promise<WebsiteState> {
  const who = await owner();
  if (!who.ok) return { error: who.error };
  const { actor } = who;
  // Only the logo is the calculator's. The shared upload box also posts a kind; a photo is refused.
  if (formData.get('kind') === 'photo') return { error: 'Your calculator only has a logo to upload.' };

  const file = formData.get('image');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a PNG or JPEG file to upload.' };
  if (file.size > LOGO_MAX_BYTES) return { error: `That file is too large. Images have to be under ${Math.round(LOGO_MAX_BYTES / (1024 * 1024))} MB.` };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await uploadLogo({ userId: actor.userId, funnelId: actor.site.funnelId, bytes });
  if (!result.ok || !result.url) return { error: result.error ?? 'That image could not be uploaded.' };

  const gate = settingsPatchFor(actor.site.mode, { logoUrl: result.url });
  const saved = gate.ok ? await saveSettings(actor.userId, gate.patch) : null;
  if (!saved || !saved.ok) {
    // The save failed, so the file just stored is unreferenced: take it out again.
    await deleteLogoIfOurs(result.url);
    return { error: 'We could not save that image just now. Please try again.' };
  }
  // Only once the new one is safely stored. A URL that was never ours is left alone.
  await deleteLogoIfOurs(actor.site.settings.logoUrl);
  refresh();
  return { saved: true, url: result.url };
}
