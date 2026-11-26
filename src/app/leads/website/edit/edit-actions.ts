'use server';

import { revalidatePath } from 'next/cache';
import { LOGO_MAX_BYTES } from '@/lib/funnels/brand';
import { editRunFor } from '@/lib/websites/edit-server';
import type { EditRun, Failed } from '@/lib/websites/edit-run';
import { switchOnSite } from '@/lib/websites/grace-server';
import { websiteActor, type ActorDenial } from '../../setup/website/context';
import { validateAbout, validateAreas, validateCompany, validateContact } from '../../setup/website/steps';

/**
 * Batch 36 (Phase 4): the edit screen's writes.
 *
 * Every action starts with editor(), which is websiteActor(): the signed-in
 * ACCOUNT OWNER (a team member is refused, as in setup), whose own website is
 * the one acted on. No action reads a website, user, funnel or version id
 * from the form or its arguments. The two things that arrive from the screen
 * besides text are a page key ("about", "area:york": parsed and checked by the
 * edit run, never an id) and a version NUMBER (a whole number, looked up only
 * among this owner's own site's versions).
 *
 * The run itself (edit-run.ts) needs the site to be live and not switched
 * off: a paused site is told "Your website is paused."
 *
 * Field validation is the setup's own (steps.ts), so a company name, area,
 * fee, contact or about text is held to the same rules as at setup.
 */

export interface EditState {
  error?: string;
  /** Saved or done. */
  ok?: boolean;
  message?: string;
  /** Publish's blockers, one plain sentence each. */
  problems?: string[];
  /** The new file's URL after an upload. */
  url?: string;
  /** Rewrites left this month after a write. */
  left?: number;
  /** The new version number after a publish or restore. */
  versionNo?: number;
}

const DENIAL: Record<ActorDenial, string> = {
  signed_out: 'Please sign in again.',
  not_owner: 'Only the account owner can edit the website.',
  not_invited: 'Your website has not been set up for your account yet.',
  not_management: 'Your website has not been set up for your account yet.',
  plan_required: 'Your plan does not include a website yet.',
  unavailable: 'We could not do that just now. Please try again.',
  calculator_site: 'Your calculator does not have website pages to edit. You can change your company name, logo, colour, areas, fee and contact details in your setup.',
};

type Editor = { ok: true; ownerId: string; run: EditRun } | { ok: false; error: string };

/** The owner at work on their own website, with its edit run. */
async function editor(): Promise<Editor> {
  const r = await websiteActor();
  if (!r.ok) return { ok: false, error: DENIAL[r.reason] };
  const run = await editRunFor(r.actor.userId);
  if (!run) return { ok: false, error: DENIAL.unavailable };
  return { ok: true, ownerId: r.actor.userId, run };
}

const refresh = () => revalidatePath('/leads/website', 'layout');

const failed = (f: Failed): EditState => ({ error: f.message, ...(f.problems && f.problems.length > 0 ? { problems: f.problems } : {}) });

/** The setup's own fields, saved to the DRAFT: the live site does not change until Publish. */
export async function saveChangesAction(_prev: EditState, formData: FormData): Promise<EditState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  const company = validateCompany({ companyName: formData.get('companyName'), brandColour: formData.get('brandColour') });
  if (!company.ok) return { error: company.error };
  const areas = validateAreas({ areas: formData.get('areas'), fee: formData.get('fee') });
  if (!areas.ok) return { error: areas.error };
  const contact = validateContact({ email: formData.get('email'), phone: formData.get('phone') });
  if (!contact.ok) return { error: contact.error };
  const about = validateAbout({ aboutText: formData.get('aboutText') });
  if (!about.ok) return { error: about.error };

  const r = await who.run.saveDraftFields({ ...company.value, ...areas.value, ...contact.value, ...about.value });
  if (!r.ok) return failed(r);
  refresh();
  const toWrite = r.plan.rewrite.length;
  return { ok: true, message: toWrite > 0 ? 'Saved to your draft. Some pages need writing again before you can publish.' : 'Saved to your draft.' };
}

/** A new logo or photo, into the draft. `kind` is a closed choice of two words. */
export async function uploadImageAction(_prev: EditState, formData: FormData): Promise<EditState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  const kind = formData.get('kind') === 'photo' ? 'photo' : 'logo';
  const file = formData.get('image');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a PNG or JPEG file to upload.' };
  if (file.size > LOGO_MAX_BYTES) return { error: `That file is too large. Images have to be under ${Math.round(LOGO_MAX_BYTES / (1024 * 1024))} MB.` };
  const r = await who.run.uploadDraftImage(kind, new Uint8Array(await file.arrayBuffer()));
  if (!r.ok) return failed(r);
  refresh();
  return { ok: true, url: r.url, message: 'Saved to your draft.' };
}

/** Write the pages that need writing: takes one of this month's rewrites, given back if it fails. */
export async function rewritePendingAction(): Promise<EditState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  const r = await who.run.rewritePending();
  if (!r.ok) return failed(r);
  refresh();
  return { ok: true, left: r.left, message: 'The pages are written. Read each one, change anything you like, then approve it.' };
}

/** Approve one rewritten page. `key` is a page key ("about", "area:york"), checked by the run. */
export async function approvePageAction(key: string): Promise<EditState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  const r = await who.run.approvePage(String(key));
  if (!r.ok) return failed(r);
  refresh();
  return { ok: true };
}

/** The operator's own edits to the copy (the whole copy as JSON, sanitised by the run). */
export async function savePagesAction(copyJson: string): Promise<EditState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  if (typeof copyJson !== 'string' || copyJson.length > 200_000) return { error: 'That copy could not be saved.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(copyJson);
  } catch {
    return { error: 'That copy could not be saved.' };
  }
  const r = await who.run.editPage(parsed);
  if (!r.ok) return failed(r);
  refresh();
  return { ok: true, message: 'Saved to your draft.' };
}

/** Publish the draft: the same checks as going live, every page fetched, the previous version put back if one fails. */
export async function publishAction(): Promise<EditState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  const r = await who.run.publish();
  if (!r.ok) return failed(r);
  refresh();
  revalidatePath('/leads');
  return { ok: true, versionNo: r.versionNo, message: 'Your changes are live.' };
}

/** Restore an earlier version as a new one. `versionNo` is a whole number, looked up among this owner's own versions. */
export async function restoreAction(versionNo: number): Promise<EditState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  const r = await who.run.restore(Number(versionNo));
  if (!r.ok) return failed(r);
  refresh();
  revalidatePath('/leads');
  return { ok: true, versionNo: r.versionNo, message: 'That version is live again.' };
}

/** Throw the draft away. */
export async function discardAction(): Promise<EditState> {
  const who = await editor();
  if (!who.ok) return { error: who.error };
  const r = await who.run.discardDraft();
  if (!r.ok) return failed(r);
  refresh();
  return { ok: true, message: 'Your draft was discarded.' };
}

/** "Switch back on", for a website that was switched off and not yet deleted (the grace server checks all of that). */
export async function switchOnAction(): Promise<EditState> {
  const r = await websiteActor();
  if (!r.ok) return { error: DENIAL[r.reason] };
  const result = await switchOnSite(r.actor.userId);
  if (!result.ok) return { error: result.messages[0] ?? DENIAL.unavailable, problems: result.messages.slice(1) };
  refresh();
  revalidatePath('/leads');
  return { ok: true, message: 'Your website is back on.' };
}
