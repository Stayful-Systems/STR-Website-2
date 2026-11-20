/**
 * Batch 36 (Phase 5): change requests, the pure rules. A website's owner can
 * ask Stayful for a change they cannot make themselves (a new web address, a
 * new page, anything). There is no limit on how many.
 *
 *   body           1 to 2000 characters, trimmed
 *   status         new -> in_progress | done | declined
 *                  in_progress -> done | declined
 *                  done and declined are final
 *   admin notes    up to 2000 characters, optional, sent to the operator when
 *                  the request is closed
 *   screenshot     PNG or JPEG (sniffed, never the file name), under 1 MB, in
 *                  the private bucket website-requests at <owner>/<id>.<ext>;
 *                  an admin sees it through a 10-minute signed link
 *
 * Pure: no network, no database, no server-only.
 */
import { extensionFor, sniffImage, type LogoMime } from '../funnels/image.ts';

export const REQUEST_BODY_MAX = 2000;
export const REQUEST_NOTES_MAX = 2000;

/** Private bucket, made by hand in Supabase like brand-assets. */
export const REQUEST_BUCKET = 'website-requests';
/** Screenshots are refused at this size and over. */
export const SCREENSHOT_MAX_BYTES = 1024 * 1024;
/** An admin's link to a screenshot works for ten minutes. */
export const REQUEST_SIGNED_URL_SECONDS = 600;

export const REQUEST_STATUSES = ['new', 'in_progress', 'done', 'declined'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const isRequestStatus = (v: unknown): v is RequestStatus => typeof v === 'string' && (REQUEST_STATUSES as readonly string[]).includes(v);

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** What the operator typed, checked: 1 to 2000 characters once trimmed. */
export function validateRequestBody(raw: unknown): Checked<string> {
  const body = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').trim() : '';
  if (!body) return { ok: false, error: 'Tell us what you would like changed.' };
  if (body.length > REQUEST_BODY_MAX) return { ok: false, error: `Please keep your request to ${REQUEST_BODY_MAX} characters or fewer.` };
  return { ok: true, value: body };
}

/** An admin's note: optional (empty is none), up to 2000 characters. */
export function validateAdminNotes(raw: unknown): Checked<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'The note is not text.' };
  const notes = raw.replace(/\r\n?/g, '\n').trim();
  if (notes.length > REQUEST_NOTES_MAX) return { ok: false, error: `Keep the note to ${REQUEST_NOTES_MAX} characters or fewer.` };
  return { ok: true, value: notes || null };
}

// ── Status ──

const NEXT: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  new: ['in_progress', 'done', 'declined'],
  in_progress: ['done', 'declined'],
  done: [],
  declined: [],
};

/** Whether a request may move from one status to another. Staying put is not a move. */
export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return NEXT[from].includes(to);
}

/** The statuses a request in `from` can go to. */
export function nextStatuses(from: RequestStatus): readonly RequestStatus[] {
  return NEXT[from];
}

/** Done and declined are final and send the operator's email. */
export const isClosedStatus = (s: RequestStatus): s is 'done' | 'declined' => s === 'done' || s === 'declined';

/** A request that still needs someone: new or in progress. */
export const isOpenStatus = (s: RequestStatus): boolean => !isClosedStatus(s);

export function requestStatusLabel(s: RequestStatus): string {
  return s === 'new' ? 'New' : s === 'in_progress' ? 'In progress' : s === 'done' ? 'Done' : 'Not going ahead';
}

// ── Screenshot ──

export const SCREENSHOT_BUCKET_MISSING = 'Screenshots are not set up on this deployment yet, so your request was sent without one.';

/** Why a screenshot is refused, in plain words, or null when it can be stored. Size before format, as for a logo. */
export function screenshotRefusal(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return 'That screenshot is empty.';
  if (bytes.length >= SCREENSHOT_MAX_BYTES) return 'That screenshot is over 1 MB. Please use a smaller one.';
  if (!sniffImage(bytes)) return 'The screenshot needs to be a PNG or a JPEG.';
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<owner>/<request>.<ext>`: the only shape ever written. Null when an id is not a uuid. */
export function screenshotPath(ownerId: string, requestId: string, mime: LogoMime): string | null {
  if (!UUID.test(ownerId) || !UUID.test(requestId)) return null;
  return `${ownerId}/${requestId}${extensionFor(mime)}`;
}

/** Whether a stored path has the shape we write (the gate before anything is signed or removed). */
export function isOurScreenshotPath(path: unknown): path is string {
  return typeof path === 'string' && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg)$/i.test(path) && !path.includes('..');
}
