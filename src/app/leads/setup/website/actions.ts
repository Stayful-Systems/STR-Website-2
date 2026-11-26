'use server';

import { revalidatePath } from 'next/cache';
import { recordActivity } from '@/lib/activity/log';
import { LOGO_MAX_BYTES, parseHexColour } from '@/lib/funnels/brand';
import { deleteLogoIfOurs, uploadLogo } from '@/lib/funnels/storage';
import { CALCULATOR_FLOW_REFUSAL } from '@/lib/websites/calculator-setup';
import { isCalculatorMode } from '@/lib/websites/calculator';
import { goLive, goLiveMessages, type PageFetch } from '@/lib/websites/golive-server';
import { WEBSITE_REGEN_CAP, generateSiteCopy } from '@/lib/websites/copy-server';
import { sitePagesOf } from '@/lib/websites/render';
import { rollbackToPreview, saveChecks, savePages, saveSettings, setStatus } from '@/lib/websites/store-server';
import type { SiteCopy, SiteSettings } from '@/lib/websites/page-model';
import { websiteActor, type ActorDenial, type WebsiteActor } from './context';
import { alignCopy, missingForCopy, sanitiseCopy, validateAbout, validateAreas, validateCompany, validateContact, type Checked } from './steps';

/**
 * Batch 31, Phase 10: the website setup's writes.
 *
 * Every action starts with editor() (or websiteActor() for approve): the
 * signed-in ACCOUNT OWNER (ownerIdOrNull: a team member is refused), whose own
 * website row is the one acted on. No action takes a website, funnel or user id
 * from its arguments or the form: there is one site per owner and it is found
 * by who is signed in, so there is nothing to forge. The plan gate and the
 * invited-only rule live in websiteActor (context.ts).
 *
 * Each step logs funnel_setup_step with the dedupe key `website_setup_step:N`:
 * activity only. Nothing here sends a conversion event (issue #18).
 */

export interface WebsiteState {
  error?: string;
  saved?: boolean;
  /** Approve's blockers, one plain sentence each. */
  problems?: string[];
  /** The page copy after a draft. */
  copy?: SiteCopy;
  /** Rewrites still left after a draft. */
  regenLeft?: number;
  live?: boolean;
  /** The stored URL after an upload. */
  url?: string;
}

const DENIAL: Record<ActorDenial, string> = {
  signed_out: 'Please sign in again.',
  not_owner: 'Only the account owner can set up the website.',
  not_invited: 'Your website has not been set up for your account yet.',
  not_management: 'Your website has not been set up for your account yet.',
  plan_required: 'Your plan does not include a website yet.',
  unavailable: 'We could not do that just now. Please try again.',
  calculator_site: CALCULATOR_FLOW_REFUSAL,
};

type Editor = { ok: true; actor: WebsiteActor } | { ok: false; error: string };

/** The owner at work on a site that can still be edited (invited, setup or preview). */
async function editor(): Promise<Editor> {
  const r = await websiteActor();
  if (!r.ok) return { ok: false, error: DENIAL[r.reason] };
  // Batch 55: a calculator site has no website steps. websiteActor already refuses it; this keeps the rule in sight of every write.
  if (isCalculatorMode(r.actor.site.mode)) return { ok: false, error: CALCULATOR_FLOW_REFUSAL };
  if (!r.actor.editable) return { ok: false, error: 'Your website is live. It cannot be changed from the setup.' };
  return { ok: true, actor: r.actor };
}

const refresh = () => revalidatePath('/leads/setup/website', 'layout');

/** A step finished: once each, activity only. */
async function stepDone(actor: WebsiteActor, step: number, extras: Record<string, string | number | boolean> = {}): Promise<void> {
  await recordActivity(actor.userId, 'funnel_setup_step', { dedupeKey: `website_setup_step:${step}`, extras: { step, website: true, ...extras } });
}

/** invited -> setup the first time the member saves something. */
async function startSetup(actor: WebsiteActor): Promise<void> {
  if (actor.site.status === 'invited') await setStatus(actor.userId, 'setup');
}

async function saveStep<T extends Partial<SiteSettings>>(actor: WebsiteActor, step: number, checked: Checked<T>, extras?: Record<string, string | number | boolean>): Promise<WebsiteState> {
  if (!checked.ok) return { error: checked.error };
  const saved = await saveSettings(actor.userId, checked.value);
  if (!saved.ok) return { error: 'We could not save that just now. Please try again.' };
  // Areas can change under copy that is already written: keep one block per current area.
  if (saved.site.pages && 'areas' in checked.value) await savePages(actor.userId, alignCopy(saved.site.settings.areas, saved.site.pages));
  await startSetup(actor);
  await stepDone(actor, step, extras);
  refresh();
  return { saved: true };
}

// ── Steps 1 to 4 ──

/** Step 1: company name and colour (the logo goes up through uploadImageAction). */
export async function saveCompanyAction(_prev: WebsiteState, formData: FormData): Promise<WebsiteState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  return saveStep(who.actor, 1, validateCompany({ companyName: formData.get('companyName'), brandColour: formData.get('brandColour') }));
}

/** Step 2: areas covered and the management fee. */
export async function saveAreasAction(_prev: WebsiteState, formData: FormData): Promise<WebsiteState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  return saveStep(who.actor, 2, validateAreas({ areas: formData.get('areas'), fee: formData.get('fee') }));
}

/** Step 3: the contact email and phone. */
export async function saveContactAction(_prev: WebsiteState, formData: FormData): Promise<WebsiteState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  return saveStep(who.actor, 3, validateContact({ email: formData.get('email'), phone: formData.get('phone') }));
}

/** Step 4 (optional): the member's own words. "Skip" leaves them as they were and still moves on. */
export async function saveAboutAction(_prev: WebsiteState, formData: FormData): Promise<WebsiteState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  if (formData.get('skip') === '1') {
    await startSetup(who.actor);
    await stepDone(who.actor, 4, { skipped: true });
    refresh();
    return { saved: true };
  }
  return saveStep(who.actor, 4, validateAbout({ aboutText: formData.get('aboutText') }));
}

/** The colour picker on step 5: saved as it changes, so the preview and Approve read the same colour. */
export async function saveColourAction(hex: string): Promise<WebsiteState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  const brandColour = parseHexColour(hex);
  if (!brandColour) return { error: 'The brand colour needs to be a six-digit hex value, like #1a73e8.' };
  const saved = await saveSettings(who.actor.userId, { brandColour });
  return saved.ok ? { saved: true } : { error: 'We could not save that colour just now.' };
}

// ── Logo and photo ──

/**
 * Logo (step 1) or photo (step 4): through the existing uploadLogo path (PNG or
 * JPEG, sniffed, stored in the brand bucket under the owner's id). The file is
 * stored against the website's own funnel row, read from the site, never the form.
 * `kind` is a closed choice of two words.
 */
export async function uploadImageAction(_prev: WebsiteState, formData: FormData): Promise<WebsiteState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  const { actor } = who;
  const kind = formData.get('kind') === 'photo' ? 'photo' : 'logo';

  const file = formData.get('image');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a PNG or JPEG file to upload.' };
  if (file.size > LOGO_MAX_BYTES) return { error: `That file is too large. Images have to be under ${Math.round(LOGO_MAX_BYTES / (1024 * 1024))} MB.` };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await uploadLogo({ userId: actor.userId, funnelId: actor.site.funnelId, bytes });
  if (!result.ok || !result.url) return { error: result.error ?? 'That image could not be uploaded.' };

  const previous = kind === 'photo' ? actor.site.settings.photoUrl : actor.site.settings.logoUrl;
  const saved = await saveSettings(actor.userId, kind === 'photo' ? { photoUrl: result.url } : { logoUrl: result.url });
  if (!saved.ok) {
    // The save failed, so the file just stored is unreferenced: take it out again.
    await deleteLogoIfOurs(result.url);
    return { error: 'We could not save that image just now. Please try again.' };
  }
  // Only once the new one is safely stored. A URL that was never ours is left alone.
  await deleteLogoIfOurs(previous);
  refresh();
  return { saved: true, url: result.url };
}

// ── Step 5: write, edit, approve ──

/**
 * The first draft (free) or a rewrite (counted, capped at WEBSITE_REGEN_CAP).
 * Which one is decided here from the stored site, never by the page: a site
 * with no copy yet gets its free first draft, and every later call is a rewrite.
 * The draft replaces the stored copy; the member's edits to the old one are lost
 * (the page asks first).
 */
export async function generateCopyAction(): Promise<WebsiteState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  const { actor } = who;
  const { site } = actor;

  const missing = missingForCopy(site.settings);
  if (missing.length > 0) return { error: `Add ${missing.join(' and ')} first.` };

  const result = await generateSiteCopy({ websiteId: site.id, site, settings: site.settings, kind: site.pages ? 'regenerate' : 'first' });
  if (!result.ok) {
    return { error: result.message, regenLeft: result.regenCount === null ? undefined : Math.max(0, WEBSITE_REGEN_CAP - result.regenCount) };
  }
  const copy = alignCopy(site.settings.areas, result.copy);
  const saved = await savePages(actor.userId, copy);
  if (!saved.ok) return { error: 'We wrote your site but could not save it. Please try again.' };
  // invited -> setup -> preview: a drafted site is a site in preview.
  await startSetup(actor);
  if (site.status !== 'preview') await setStatus(actor.userId, 'preview');
  refresh();
  return { saved: true, copy, regenLeft: Math.max(0, WEBSITE_REGEN_CAP - result.regenCount) };
}

/** The member's edits to the copy, saved as they type. Never runs the checks: Approve does. */
export async function saveCopyAction(copyJson: string): Promise<WebsiteState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  if (typeof copyJson !== 'string' || copyJson.length > 200_000) return { error: 'That copy could not be saved.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(copyJson);
  } catch {
    return { error: 'That copy could not be saved.' };
  }
  const copy = sanitiseCopy(parsed);
  if (!copy) return { error: 'That copy could not be saved.' };
  const saved = await savePages(who.actor.userId, alignCopy(who.actor.site.settings.areas, copy));
  return saved.ok ? { saved: true } : { error: 'We could not save your changes just now.' };
}

/** Where the real page fetches go: the runtime's fetch, as given. */
const realFetch: PageFetch = (url, init) => fetch(url, init);

/**
 * Approve. Reads the site afresh (the stored copy and settings, never anything
 * posted), checks it, sets it live, fetches every public page and rolls back to
 * preview if any fails (golive-server.ts). A failed Approve is saved to the
 * site's `checks` so the page can show it again.
 */
export async function approveAction(): Promise<WebsiteState> {
  const r = await websiteActor();
  if (!r.ok) return { error: DENIAL[r.reason] };
  if (isCalculatorMode(r.actor.site.mode)) return { error: CALCULATOR_FLOW_REFUSAL };
  const { actor } = r;
  const { site } = actor;
  if (site.status === 'live') return { saved: true, live: true };
  if (site.status !== 'preview') return { error: 'Write your site first, then approve it.' };

  // One block per current area, as the public site will read it.
  const copy = site.pages ? alignCopy(site.settings.areas, site.pages) : null;
  const pages = sitePagesOf(site, site.settings, copy);

  const result = await goLive({
    site,
    settings: site.settings,
    pages,
    fetchPage: realFetch,
    markLive: async () => {
      if (copy) await savePages(actor.userId, copy);
      return (await setStatus(actor.userId, 'live')).ok;
    },
    rollback: () => rollbackToPreview(actor.userId, { approvedAt: site.approvedAt, liveAt: site.liveAt }),
    record: (kind, opts) => recordActivity(actor.userId, kind, { dedupeKey: opts.dedupeKey, extras: opts.extras }),
  });

  if (!result.ok) {
    const problems = goLiveMessages(result);
    await saveChecks(actor.userId, { at: new Date().toISOString(), ok: false, stage: result.stage, problems });
    refresh();
    return { error: 'Your website is not live yet.', problems };
  }
  await saveChecks(actor.userId, { at: new Date().toISOString(), ok: true, stage: 'live', problems: [] });
  await stepDone(actor, 5);
  refresh();
  revalidatePath('/leads');
  return { saved: true, live: true };
}
