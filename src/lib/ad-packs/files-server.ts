import 'server-only';

import { createAdminClient } from '../supabase/admin';
import { defaultFetchImage, type FetchImage } from './images';
import { isUploadRef } from './photos.ts';

/**
 * Batch 36 (Phase 8): the operator screen's file handling, in the private
 * `ad-packs` bucket (service role only).
 *
 *   adPackFetchImage        the image renderer's fetch: a stored photo reference
 *                           (`<owner>/uploads/<uuid>.jpg`) is read from the
 *                           bucket; anything else is a web address and goes
 *                           through the renderer's own https-only fetch
 *   countUploads(owner)     how many files the owner already has in uploads/
 *   signedPreviewUrls       one-hour links for showing the owner's own files
 *                           (preview images, photo thumbnails): NOT downloads,
 *                           and only for paths inside the owner's own folder
 *
 * Downloads of finished ad files stay in store-server.ts (signedDownloadUrl,
 * owner-checked against the pack ad). Nothing here logs a path, a body or an
 * address: a failure logs a short code.
 */

const BUCKET = 'ad-packs';
/** How long a preview link works: long enough to look at the screen, short enough not to be shared. */
export const PREVIEW_SECONDS = 3600;

/** The bytes of one stored upload, or null. Only a well-formed upload reference is read. */
async function readUpload(ref: string): Promise<Uint8Array | null> {
  if (!isUploadRef(ref)) return null;
  try {
    const { data, error } = await createAdminClient().storage.from(BUCKET).download(ref);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  } catch {
    return null;
  }
}

/** The renderer's fetch: stored photos from the bucket, everything else as before (https only). */
export const adPackFetchImage: FetchImage = async (ref) => {
  if (isUploadRef(ref)) {
    const bytes = await readUpload(ref);
    if (!bytes) throw new Error('upload not found');
    return { bytes, contentType: null };
  }
  return defaultFetchImage(ref);
};

/** Files in the owner's uploads folder, or null when it cannot be read. */
export async function countUploads(ownerId: string): Promise<number | null> {
  try {
    const { data, error } = await createAdminClient().storage.from(BUCKET).list(`${ownerId.toLowerCase()}/uploads`, { limit: 100 });
    if (error) {
      console.error('[ad-packs] uploads list failed');
      return null;
    }
    return (data ?? []).length;
  } catch {
    return null;
  }
}

/**
 * One-hour view links, by path. Only paths inside `<ownerId>/` (and without
 * `..`) are signed; any other path is left out of the result.
 */
export async function signedPreviewUrls(ownerId: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const prefix = `${ownerId.toLowerCase()}/`;
  const own = [...new Set(paths)].filter((p) => typeof p === 'string' && p.toLowerCase().startsWith(prefix) && !p.includes('..'));
  if (own.length === 0) return out;
  try {
    const { data, error } = await createAdminClient().storage.from(BUCKET).createSignedUrls(own, PREVIEW_SECONDS);
    if (error || !data) {
      console.error('[ad-packs] preview links failed');
      return out;
    }
    for (const row of data) if (row.path && row.signedUrl) out.set(row.path, row.signedUrl);
  } catch {
    console.error('[ad-packs] preview links failed');
  }
  return out;
}

/** One preview link for one of the owner's own files, or null. */
export async function signedPreviewUrl(ownerId: string, path: string): Promise<string | null> {
  return (await signedPreviewUrls(ownerId, [path])).get(path) ?? null;
}
