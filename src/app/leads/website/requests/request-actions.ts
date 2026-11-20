'use server';

import { revalidatePath } from 'next/cache';
import { liveRequestsEngine } from '@/lib/websites/edit-requests-store';
import { websiteActor } from '../../setup/website/context';

/**
 * Batch 36 (Phase 5): send a change request for the signed-in owner's own
 * website.
 *
 * The site and the owner are found by WHO IS SIGNED IN (websiteActor: the
 * account owner's own website; a team member is refused). The only things read
 * from the form are the text and the optional screenshot: never a website, user
 * or request id. The request text is never logged or put in a subject.
 */

export interface RequestFormState {
  error?: string;
  sent?: boolean;
  /** The text went; this says why the screenshot did not. */
  screenshotMessage?: string;
}

export async function sendRequestAction(_prev: RequestFormState, formData: FormData): Promise<RequestFormState> {
  const r = await websiteActor();
  if (!r.ok) return { error: r.reason === 'signed_out' ? 'Please sign in again.' : 'We could not do that just now. Please try again.' };

  const file = formData.get('screenshot');
  let screenshot: Uint8Array | null = null;
  // The engine checks the type and size; the bytes are only read from a real, non-empty upload.
  if (file instanceof File && file.size > 0) screenshot = new Uint8Array(await file.arrayBuffer());

  const result = await liveRequestsEngine().createRequest({ ownerId: r.actor.userId, websiteId: r.actor.site.id, body: formData.get('body'), screenshot });
  if (!result.ok) return { error: result.error };
  revalidatePath('/leads/website/requests');
  return { sent: true, ...(result.screenshotMessage ? { screenshotMessage: result.screenshotMessage } : {}) };
}
