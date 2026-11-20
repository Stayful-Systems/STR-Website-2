/**
 * Batch 38: which stored file an owner may download, as pure logic. The bucket
 * is private; an operator gets a short signed link, and only for a pack ad
 * that is theirs and a file name that ad really has.
 *
 * Pure: no network, no database, no server-only. The signer is injected.
 */
import type { AdPackStore } from './store-types.ts';

/** How long a download link works. */
export const DOWNLOAD_SECONDS = 300;

export type Signer = (path: string, expiresInSeconds: number, downloadName: string) => Promise<string | null>;

/**
 * The storage path of `fileName` on one of the owner's pack ads, or null:
 * not the owner's ad, no such file, or a path outside the owner's own folder.
 * `fileName` is an image name, or for the 5b ad (video ready) notice-9x16.mp4,
 * notice-4x5.mp4, notice-1x1.mp4 or notice-poster.png. The voice files in the
 * bucket (voice.mp3, script.json) are never offered.
 */
export async function downloadPath(store: Pick<AdPackStore, 'getPackAd'>, ownerId: string, packAdId: string, fileName: string): Promise<string | null> {
  if (typeof ownerId !== 'string' || ownerId === '' || typeof packAdId !== 'string' || packAdId === '' || typeof fileName !== 'string' || fileName === '') return null;
  const ad = await store.getPackAd(ownerId, packAdId);
  if (!ad || ad.ownerId !== ownerId) return null;
  const video = ad.files.video && ad.files.video.status === 'ready' ? ad.files.video : null;
  // Images, and (5b, once ready) the three MP4s and the poster. Nothing else is ever signed.
  const file = [...ad.files.images, ...(video ? [...video.videos, video.poster] : [])].find((f) => f.name === fileName);
  if (!file) return null;
  if (!file.path.startsWith(`${ownerId}/`) || file.path.includes('..')) return null;
  return file.path;
}

/** A short-lived signed link to one file of the owner's pack ad, or null. */
export async function signedDownloadUrlWith(store: Pick<AdPackStore, 'getPackAd'>, sign: Signer, ownerId: string, packAdId: string, fileName: string): Promise<string | null> {
  const path = await downloadPath(store, ownerId, packAdId, fileName);
  if (!path) return null;
  return sign(path, DOWNLOAD_SECONDS, fileName);
}
