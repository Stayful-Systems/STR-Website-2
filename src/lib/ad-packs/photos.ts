/**
 * Batch 38 (Phase 8): the operator's own photos for a pack, as pure rules.
 *
 * A photo is uploaded through a server action into the private `ad-packs`
 * bucket under `<owner id>/uploads/<uuid>.<jpg|png>` (files-server.ts). That
 * path IS the photo's reference everywhere after: `ad_packs.photos` stores it,
 * `brandHash` hashes it (so it is stable: a signed URL would change on every
 * look and make every regenerate look like a brand change), and the image
 * renderer fetches it through `adPackFetchImage` (files-server.ts), which reads
 * the bytes from the bucket. Nothing outside the owner's own folder is ever a
 * valid reference.
 *
 * Checked server-side, never trusted from the browser: the declared type, the
 * size (5 MB) and the first bytes (a JPEG or a PNG; not WebP, GIF, SVG or HEIC).
 *
 * Pure: no network, no database, no server-only.
 */

/** The most one photo may be. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** The most photos a pack uses (mirrors MAX_PHOTOS in generate-core.ts; a test pins it). */
export const MAX_PACK_PHOTOS = 4;
/** The most files an owner may keep in their uploads folder (unused ones are never deleted by this batch). */
export const MAX_UPLOADS_PER_OWNER = 24;

export type PhotoKind = 'jpeg' | 'png';

/** The kind of photo from its first bytes, or null. */
export function sniffPhoto(bytes: Uint8Array | null | undefined): PhotoKind | null {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

export const PHOTO_MESSAGES = {
  empty: 'That photo is empty. Please choose another.',
  too_big: 'That photo is bigger than 5 MB. Please choose a smaller one.',
  type: 'Please choose a JPG or PNG photo.',
  full: 'You have already uploaded a lot of photos. Please use the ones you have, or get in touch.',
  limit: 'A pack can use up to 4 photos.',
  failed: 'We could not save that photo just now. Please try again.',
} as const;

export type PhotoCheck = { ok: true; kind: PhotoKind; ext: 'jpg' | 'png'; contentType: 'image/jpeg' | 'image/png' } | { ok: false; message: string };

/**
 * Whether a file may be kept as a pack photo. `declaredType` is the browser's
 * claim (File.type): it must say JPEG or PNG AND the bytes must agree.
 */
export function checkPhoto(bytes: Uint8Array | null | undefined, declaredType?: string | null): PhotoCheck {
  if (!bytes || bytes.length === 0) return { ok: false, message: PHOTO_MESSAGES.empty };
  if (bytes.length > PHOTO_MAX_BYTES) return { ok: false, message: PHOTO_MESSAGES.too_big };
  const kind = sniffPhoto(bytes);
  if (!kind) return { ok: false, message: PHOTO_MESSAGES.type };
  const declared = String(declaredType ?? '').toLowerCase().trim();
  const declaredKind = declared === 'image/jpeg' || declared === 'image/jpg' ? 'jpeg' : declared === 'image/png' ? 'png' : null;
  if (declaredKind !== kind) return { ok: false, message: PHOTO_MESSAGES.type };
  return kind === 'png' ? { ok: true, kind, ext: 'png', contentType: 'image/png' } : { ok: true, kind, ext: 'jpg', contentType: 'image/jpeg' };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UPLOAD_REF = new RegExp(`^(${UUID})/uploads/(${UUID})\\.(jpg|png)$`, 'i');

/** The storage path (and reference) of one uploaded photo. */
export function uploadRef(ownerId: string, photoId: string, ext: 'jpg' | 'png'): string {
  return `${ownerId.toLowerCase()}/uploads/${photoId.toLowerCase()}.${ext}`;
}

/** True for any well-formed upload reference (whoever's). The renderer's fetch uses this to tell a stored photo from a web address. */
export function isUploadRef(ref: unknown): ref is string {
  return typeof ref === 'string' && UPLOAD_REF.test(ref);
}

/** True only for an upload reference inside THIS owner's own uploads folder. */
export function ownUploadRef(ownerId: string, ref: unknown): ref is string {
  if (typeof ownerId !== 'string' || typeof ref !== 'string') return false;
  const m = UPLOAD_REF.exec(ref);
  return m !== null && m[1].toLowerCase() === ownerId.toLowerCase();
}

/**
 * The photo references a form may submit, cleaned: only the owner's own, no
 * repeats, in order, at most MAX_PACK_PHOTOS. Null when any reference is not
 * the owner's or there are too many (the whole request is then refused).
 */
export function cleanPhotoRefs(ownerId: string, refs: unknown): string[] | null {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs)) return null;
  const out: string[] = [];
  for (const r of refs) {
    if (!ownUploadRef(ownerId, r)) return null;
    const ref = r.toLowerCase();
    if (!out.includes(ref)) out.push(ref);
  }
  return out.length > MAX_PACK_PHOTOS ? null : out;
}
