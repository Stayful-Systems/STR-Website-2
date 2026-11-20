'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { ownerIdOrNull } from '@/lib/leads/scope';
import { isAdminEmail } from '@/lib/admin';
import { recordActivity } from '@/lib/activity/log';
import { packEligibility } from '@/lib/ad-packs/eligibility-server';
import { areaPreview } from '@/lib/ad-packs/area-server';
import { approvePack, generatePack, listPackForOwner } from '@/lib/ad-packs/generate-server';
import { createLiveStore, signedDownloadUrl, uploadFile } from '@/lib/ad-packs/store-server';
import { countUploads, signedPreviewUrl } from '@/lib/ad-packs/files-server';
import { PHOTO_MAX_BYTES, PHOTO_MESSAGES } from '@/lib/ad-packs/photos';
import { approveOp, areaPreviewOp, copyOp, downloadOp, generateOp, uploadPhotoOp, type AdsDeps, type AdsState, type DownloadState, type Session, type UploadState } from './ops';
import { ADS_PATH, type AreaPreviewView } from './view';

/**
 * Batch 36 (Phase 8): the ad pack screen's server actions. Each one is a few
 * lines over ops.ts, which holds (and tests) the rules: the owner is always the
 * signed-in account owner's id, the browser only ever sends lookup keys and
 * choices, and a key that is not the owner's is refused before anything happens.
 */

async function session(): Promise<Session> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'signed_out' };
  const ownerId = await ownerIdOrNull(user);
  if (!ownerId) return { ok: false, reason: 'member' };
  return { ok: true, ownerId, email: user.email ?? null, admin: isAdminEmail(user.email) };
}

function liveDeps(): AdsDeps {
  return {
    session,
    eligibility: (userId, opts) => packEligibility(userId, opts),
    areaPreview: (areaKey) => areaPreview({ areaKey }),
    listPack: listPackForOwner,
    generate: generatePack,
    approve: approvePack,
    getAd: (ownerId, packAdId) => createLiveStore().getPackAd(ownerId, packAdId),
    signDownload: signedDownloadUrl,
    upload: uploadFile,
    countUploads,
    previewUrl: signedPreviewUrl,
    record: (ownerId, kind, opts) => recordActivity(ownerId, kind, { extras: opts.extras, ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}) }),
    newId: randomUUID,
  };
}

const text = (v: FormDataEntryValue | null): string | null => (typeof v === 'string' ? v : null);

/** "Generate" and "Regenerate": the area, the photos (references from the upload action) and the type-only tick box. */
export async function generatePackAction(_prev: AdsState, formData: FormData): Promise<AdsState> {
  const out = await generateOp(liveDeps(), {
    packId: text(formData.get('packId')),
    areaKey: text(formData.get('areaKey')),
    photoRefs: formData.getAll('photoRef').filter((v): v is string => typeof v === 'string'),
    typeOnly: text(formData.get('typeOnly')) === 'on',
  });
  // Whether it worked or not the pack may have moved (made, failed, checks failed): the page reads it again.
  revalidatePath(ADS_PATH);
  return out;
}

export async function approvePackAction(_prev: AdsState, formData: FormData): Promise<AdsState> {
  const out = await approveOp(liveDeps(), { packId: text(formData.get('packId')), version: text(formData.get('version')) });
  revalidatePath(ADS_PATH);
  return out;
}

/** A short signed link to one file of one of the owner's ads. */
export async function downloadFileAction(adId: string, fileName: string): Promise<DownloadState> {
  return downloadOp(liveDeps(), { adId, fileName });
}

/**
 * Copy pressed on a text: logs `ad_text_copied` with the ad code and the kind
 * of text. The browser has already put the text on the clipboard; nothing here
 * ever receives the text itself.
 */
export async function recordCopyAction(adId: string, kind: string, index: number): Promise<void> {
  await copyOp(liveDeps(), { adId, kind, index });
}

/** One photo, JPEG or PNG up to 5 MB, into the owner's private uploads folder. */
export async function uploadPhotoAction(formData: FormData): Promise<UploadState> {
  const file = formData.get('photo');
  if (!(file instanceof File)) return { ok: false, error: PHOTO_MESSAGES.type };
  if (file.size > PHOTO_MAX_BYTES) return { ok: false, error: PHOTO_MESSAGES.too_big };
  return uploadPhotoOp(liveDeps(), { bytes: new Uint8Array(await file.arrayBuffer()), declaredType: file.type || null });
}

/** The bedroom size and area an ad will use, for the area pick list. */
export async function areaPreviewAction(areaKey: string): Promise<AreaPreviewView> {
  return areaPreviewOp(liveDeps(), { areaKey });
}
