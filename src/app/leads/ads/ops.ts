/**
 * Batch 38 (Phase 8): what each server action of the ad pack screen does, with
 * everything outside it injected (the session, eligibility, the generator, the
 * store, storage, the activity log), so the rules are tested without a session,
 * a database or storage. actions.ts wires the real ones.
 *
 * THE RULE for every operation here: the owner is the signed-in account
 * owner's id from the session (`deps.session()`), never anything the browser
 * sends. What the browser sends is only a lookup key (a pack id, an ad id, a
 * file name, a photo reference) and a choice (an area, a photo, a tick box),
 * and every key is checked to belong to that owner BEFORE anything is read,
 * signed, approved or logged:
 *
 *   generate   the brand, the domain and the website come from the owner's own
 *              website (eligibility); a pack id, if sent, must be the owner's pack;
 *              photo references must be inside the owner's own uploads folder
 *   approve    the pack id must be the owner's pack
 *   download   the pack ad must be the owner's, and have that file (signedDownloadUrl)
 *   copy       the pack ad must be the owner's, and have that text; the log gets the
 *              ad code, the kind of text and its position, NEVER the text
 *   upload     the owner's own folder only; type, size and first bytes are checked here
 *   voice      (38b) changeVoice / retryVideo: the pack id must be the owner's pack and the version on screen
 *              is pinned; eligibility is checked (they can cost money); the generator's refusals become one
 *              plain sentence (videoActionMessage)
 *   poll       (38b) read only: the pack id must be the owner's; answers with the video, approve and voice
 *              fields of view.ts (PollView) and nothing else: no id, no code, no path, no secret
 *   video url  (38b) a one-hour view link for a file of the owner's own READY video (or its poster) only
 *
 * Nothing here returns a database field, an internal code or a raw error: every
 * refusal is one plain sentence.
 *
 * Pure: no network, no database, no server-only.
 */
import type { ApproveResult, ChangeVoiceResult, GenerateRequest, GenerateResult, PackView, RetryVideoResult } from '../../../lib/ad-packs/generate-core.ts';
import { parseAreaKey } from '../../../lib/ad-packs/area.ts';
import { plainReason, type EligibilityReason } from '../../../lib/ad-packs/eligibility.ts';
import { checkPhoto, cleanPhotoRefs, MAX_UPLOADS_PER_OWNER, PHOTO_MESSAGES, uploadRef } from '../../../lib/ad-packs/photos.ts';
import type { PackAdRow } from '../../../lib/ad-packs/store-types.ts';
import { isVoiceKey, type VoiceKey } from '../../../lib/ad-packs/voices.ts';
import { areaPreviewView, brandOfSettings, brandProblemText, copyTargetExists, isCopyKind, LOGO_REFUSAL, pollViewOf, videoActionMessage, isVideoFileName, VIDEO_POSTER_NAME, type AreaPreviewInput, type AreaPreviewView, type CopyKind, type PollView, type SiteBrandInput } from './view.ts';

export type AdsState = { ok?: boolean; error?: string; notice?: string };
export type UploadState = { ok: true; ref: string; previewUrl: string | null } | { ok: false; error: string };
export type DownloadState = { ok: true; url: string } | { ok: false; error: string };
/** The answer to a poll: the lightweight video / approve / voice fields, or nothing (signed out, not the owner's pack). */
export type PollState = ({ ok: true } & PollView) | { ok: false };

export const MESSAGES = {
  signed_out: 'Please sign in again.',
  member: 'Only the account owner can set up the ad pack.',
  not_found: 'We could not find that pack. Please reload the page and try again.',
  area: 'Please choose your area from the list.',
  photos: 'Those photos could not be used. Please add them again.',
  try_again: 'Something went wrong. Please try again.',
  download: 'We could not make that download link. Please try again.',
  not_eligible: 'The ad pack is not available for this account yet.',
  voice: 'Please choose one of the three voices.',
} as const;

export type Session = { ok: true; ownerId: string; email: string | null; admin: boolean } | { ok: false; reason: 'signed_out' | 'member' };

export type EligibilityFacts = {
  eligible: boolean;
  reasons: EligibilityReason[];
  website?: { id: string; settings: SiteBrandInput };
  /** The live bare domain, only when it is live. */
  domain?: string;
};

export type AreaPreviewDep = AreaPreviewInput;

export interface AdsDeps {
  /** The signed-in account owner (ownerIdOrNull of the session's user); never from the browser. */
  session(): Promise<Session>;
  eligibility(userId: string, opts: { admin: boolean }): Promise<EligibilityFacts>;
  areaPreview(areaKey: string): Promise<AreaPreviewDep>;
  listPack(ownerId: string): Promise<PackView | null>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  approve(req: { ownerId: string; expectedVersion?: number }): Promise<ApproveResult>;
  /** 38b: another voice for the same version, before approving. */
  changeVoice(req: { ownerId: string; voiceKey: string; expectedVersion?: number }): Promise<ChangeVoiceResult>;
  /** 38b: try a failed video again. */
  retryVideo(req: { ownerId: string; expectedVersion?: number }): Promise<RetryVideoResult>;
  /** One pack ad, only if it is the owner's. */
  getAd(ownerId: string, packAdId: string): Promise<PackAdRow | null>;
  /** A short signed download link, only for the owner's ad and a file it has; null otherwise. */
  signDownload(ownerId: string, packAdId: string, fileName: string): Promise<string | null>;
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ ok: boolean }>;
  countUploads(ownerId: string): Promise<number | null>;
  /** A view link for one of the owner's own files, or null. */
  previewUrl(ownerId: string, path: string): Promise<string | null>;
  /** Records activity. Resolves when written; never rejects. */
  record(ownerId: string, kind: 'ad_pack_approved' | 'ad_text_copied', opts: { extras: Record<string, string | number>; dedupeKey?: string }): Promise<void>;
  newId(): string;
}

const sessionError = (s: Extract<Session, { ok: false }>): string => MESSAGES[s.reason];

const eligibilityError = (e: EligibilityFacts): string => (e.reasons.length > 0 ? plainReason(e.reasons[0]) : MESSAGES.not_eligible);

/** The owner's own pack, only when `packId` (if sent) names it. */
async function ownPack(deps: AdsDeps, ownerId: string, packId: unknown): Promise<{ ok: true; view: PackView | null } | { ok: false }> {
  const view = await deps.listPack(ownerId);
  if (packId === undefined || packId === null || packId === '') return { ok: true, view };
  if (typeof packId !== 'string' || !view || view.pack.id !== packId || view.pack.ownerId !== ownerId) return { ok: false };
  return { ok: true, view };
}

// ── Generate ──

export type GenerateInput = { packId?: unknown; areaKey?: unknown; photoRefs?: unknown; typeOnly?: unknown; voiceKey?: unknown };

/** Make (or remake) the owner's pack. */
export async function generateOp(deps: AdsDeps, input: GenerateInput): Promise<AdsState> {
  const s = await deps.session();
  if (!s.ok) return { error: sessionError(s) };
  const elig = await deps.eligibility(s.ownerId, { admin: s.admin });
  if (!elig.eligible || !elig.website || !elig.domain) return { error: eligibilityError(elig) };

  const mine = await ownPack(deps, s.ownerId, input.packId);
  if (!mine.ok) return { error: MESSAGES.not_found };

  if (typeof input.areaKey !== 'string' || parseAreaKey(input.areaKey) === null) return { error: MESSAGES.area };
  const photos = cleanPhotoRefs(s.ownerId, input.photoRefs);
  if (photos === null) return { error: MESSAGES.photos };

  const { brand, problems } = brandOfSettings(elig.website.settings);
  if (problems.length > 0) return { error: brandProblemText(problems[0]) };
  const typeOnly = input.typeOnly === true || input.typeOnly === 'on' || input.typeOnly === 'true';
  if (brand.logoUrl === null && !typeOnly) return { error: LOGO_REFUSAL };
  // 38b: the voice for the video. Absent (a regenerate keeps the pack's voice) is fine; anything else must be one of the three.
  const voiceSent = input.voiceKey !== undefined && input.voiceKey !== null && input.voiceKey !== '';
  if (voiceSent && !isVoiceKey(input.voiceKey)) return { error: MESSAGES.voice };
  const voiceKey: VoiceKey | undefined = voiceSent && isVoiceKey(input.voiceKey) ? input.voiceKey : undefined;

  const result = await deps.generate({
    ownerId: s.ownerId,
    by: 'operator',
    input: {
      areaKey: input.areaKey.trim().toUpperCase(),
      photos,
      brand: { company: brand.company, logoUrl: brand.logoUrl, brandColour: brand.brandColour, feePct: brand.feePct, areas: brand.areas, photoUrl: brand.photoUrl },
      domain: elig.domain,
      websiteId: elig.website.id,
      typeOnly: brand.logoUrl === null && typeOnly,
      ...(voiceKey ? { voiceKey } : {}),
    },
  });
  if (!result.ok) return { error: result.message };
  // A dry run is never asked for here; a checks_failed pack is shown by the page, which re-reads it.
  return { ok: true };
}

// ── Approve ──

export async function approveOp(deps: AdsDeps, input: { packId?: unknown; version?: unknown }): Promise<AdsState> {
  const s = await deps.session();
  if (!s.ok) return { error: sessionError(s) };
  const elig = await deps.eligibility(s.ownerId, { admin: s.admin });
  if (!elig.eligible) return { error: eligibilityError(elig) };

  // Approving needs the pack id the screen showed: it is only a lookup key, and it must be this owner's pack.
  if (typeof input.packId !== 'string' || input.packId === '') return { error: MESSAGES.not_found };
  const mine = await ownPack(deps, s.ownerId, input.packId);
  if (!mine.ok || !mine.view) return { error: MESSAGES.not_found };

  // The version on screen when the button was pressed; a non-number means the form did not send one, so it is not pinned.
  const expectedVersion = typeof input.version === 'string' && /^[0-9]{1,6}$/.test(input.version) ? Number(input.version) : undefined;
  const out = await deps.approve({ ownerId: s.ownerId, expectedVersion });
  if (!out.ok) return { error: out.message };
  // Record only what the generator says happened; the version, never anything the owner wrote.
  await deps.record(s.ownerId, out.activityKind, { extras: { version: out.version }, dedupeKey: `ad_pack_approved:${out.packId}:v${out.version}` });
  return { ok: true, notice: 'Approved. Your files and texts are ready below.' };
}

// ── Download ──

export async function downloadOp(deps: AdsDeps, input: { adId?: unknown; fileName?: unknown }): Promise<DownloadState> {
  const s = await deps.session();
  if (!s.ok) return { ok: false, error: sessionError(s) };
  if (typeof input.adId !== 'string' || input.adId === '' || typeof input.fileName !== 'string' || input.fileName === '') return { ok: false, error: MESSAGES.download };
  const url = await deps.signDownload(s.ownerId, input.adId, input.fileName);
  return url ? { ok: true, url } : { ok: false, error: MESSAGES.download };
}

// ── Copy ──

/**
 * Log that an operator copied one text. The browser sends which ad, which kind
 * of text and which one; it never sends the text, and the log never holds it:
 * only the ad code, the angle, the kind and the position.
 */
export async function copyOp(deps: AdsDeps, input: { adId?: unknown; kind?: unknown; index?: unknown }): Promise<{ ok: boolean }> {
  const s = await deps.session();
  if (!s.ok) return { ok: false };
  if (typeof input.adId !== 'string' || input.adId === '' || !isCopyKind(input.kind) || typeof input.index !== 'number') return { ok: false };
  const ad = await deps.getAd(s.ownerId, input.adId);
  if (!ad || ad.ownerId !== s.ownerId) return { ok: false };
  const kind: CopyKind = input.kind;
  if (!copyTargetExists(ad, kind, input.index)) return { ok: false };
  await deps.record(s.ownerId, 'ad_text_copied', { extras: { ad: ad.code, angle: ad.angle, kind, n: input.index + 1 } });
  return { ok: true };
}

// ── Photos ──

export async function uploadPhotoOp(deps: AdsDeps, input: { bytes: Uint8Array | null; declaredType: string | null }): Promise<UploadState> {
  const s = await deps.session();
  if (!s.ok) return { ok: false, error: sessionError(s) };
  const elig = await deps.eligibility(s.ownerId, { admin: s.admin });
  if (!elig.eligible) return { ok: false, error: eligibilityError(elig) };

  const checked = checkPhoto(input.bytes, input.declaredType);
  if (!checked.ok) return { ok: false, error: checked.message };
  const kept = await deps.countUploads(s.ownerId);
  if (kept === null) return { ok: false, error: PHOTO_MESSAGES.failed };
  if (kept >= MAX_UPLOADS_PER_OWNER) return { ok: false, error: PHOTO_MESSAGES.full };

  const ref = uploadRef(s.ownerId, deps.newId(), checked.ext);
  const stored = await deps.upload(ref, input.bytes as Uint8Array, checked.contentType);
  if (!stored.ok) return { ok: false, error: PHOTO_MESSAGES.failed };
  return { ok: true, ref, previewUrl: await deps.previewUrl(s.ownerId, ref) };
}

// ── The area step ──

export async function areaPreviewOp(deps: AdsDeps, input: { areaKey?: unknown }): Promise<AreaPreviewView> {
  const s = await deps.session();
  if (!s.ok) return { ok: false, bedrooms: null, text: sessionError(s) };
  const elig = await deps.eligibility(s.ownerId, { admin: s.admin });
  if (!elig.eligible) return { ok: false, bedrooms: null, text: eligibilityError(elig) };
  if (typeof input.areaKey !== 'string' || parseAreaKey(input.areaKey) === null) return { ok: false, bedrooms: null, text: MESSAGES.area };
  return areaPreviewView(await deps.areaPreview(input.areaKey));
}

// ── The video (38b): change voice, try again, poll, view link ──

/** The version the screen showed, as a number: the new actions need it (a pack that moved on is never changed unseen). */
const shownVersion = (v: unknown): number | undefined => (typeof v === 'string' && /^[0-9]{1,6}$/.test(v) ? Number(v) : typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1_000_000 ? v : undefined);

/** The owner's own pack, only when `packId` names it; a missing pack id is not a pack. */
async function mustOwnPack(deps: AdsDeps, ownerId: string, packId: unknown): Promise<PackView | null> {
  if (typeof packId !== 'string' || packId === '') return null;
  const mine = await ownPack(deps, ownerId, packId);
  return mine.ok ? mine.view : null;
}

export async function changeVoiceOp(deps: AdsDeps, input: { packId?: unknown; voiceKey?: unknown; version?: unknown }): Promise<AdsState> {
  const s = await deps.session();
  if (!s.ok) return { error: sessionError(s) };
  const elig = await deps.eligibility(s.ownerId, { admin: s.admin });
  if (!elig.eligible) return { error: eligibilityError(elig) };
  if (!(await mustOwnPack(deps, s.ownerId, input.packId))) return { error: MESSAGES.not_found };
  if (!isVoiceKey(input.voiceKey)) return { error: MESSAGES.voice };
  const expectedVersion = shownVersion(input.version);
  if (expectedVersion === undefined) return { error: MESSAGES.not_found };

  const out = await deps.changeVoice({ ownerId: s.ownerId, voiceKey: input.voiceKey, expectedVersion });
  if (!out.ok) return { error: videoActionMessage(out.code, out.message) };
  return { ok: true, notice: out.free ? 'Your video is being made again with the new voice. This change was free.' : 'Your video is being made again with the new voice. It usually takes 3 to 6 minutes.' };
}

export async function retryVideoOp(deps: AdsDeps, input: { packId?: unknown; version?: unknown }): Promise<AdsState> {
  const s = await deps.session();
  if (!s.ok) return { error: sessionError(s) };
  const elig = await deps.eligibility(s.ownerId, { admin: s.admin });
  if (!elig.eligible) return { error: eligibilityError(elig) };
  if (!(await mustOwnPack(deps, s.ownerId, input.packId))) return { error: MESSAGES.not_found };
  const expectedVersion = shownVersion(input.version);
  if (expectedVersion === undefined) return { error: MESSAGES.not_found };

  const out = await deps.retryVideo({ ownerId: s.ownerId, expectedVersion });
  if (!out.ok) return { error: videoActionMessage(out.code, out.message) };
  return { ok: true, notice: 'Trying again. Your video usually takes 3 to 6 minutes.' };
}

/**
 * The screen asks every few seconds while the video is being made. Read only, so no eligibility lookup (it would
 * repeat every few seconds): the pack read is already the session owner's, and the pack id must be theirs.
 */
export async function pollPackOp(deps: AdsDeps, input: { packId?: unknown }): Promise<PollState> {
  const s = await deps.session();
  if (!s.ok) return { ok: false };
  const view = await mustOwnPack(deps, s.ownerId, input.packId);
  if (!view) return { ok: false };
  return { ok: true, ...pollViewOf(view) };
}

/**
 * A one-hour view link (not a download) for one file of the owner's own READY video, or its poster: the player asks
 * when its first link has run out. Only the three video names and the poster are ever signed.
 */
export async function videoUrlOp(deps: AdsDeps, input: { adId?: unknown; fileName?: unknown }): Promise<DownloadState> {
  const s = await deps.session();
  if (!s.ok) return { ok: false, error: sessionError(s) };
  if (typeof input.adId !== 'string' || input.adId === '' || typeof input.fileName !== 'string') return { ok: false, error: MESSAGES.download };
  if (!isVideoFileName(input.fileName) && input.fileName !== VIDEO_POSTER_NAME) return { ok: false, error: MESSAGES.download };
  const ad = await deps.getAd(s.ownerId, input.adId);
  if (!ad || ad.ownerId !== s.ownerId || !ad.files.video || ad.files.video.status !== 'ready') return { ok: false, error: MESSAGES.download };
  const file = [...ad.files.video.videos, ad.files.video.poster].find((f) => f.name === input.fileName);
  if (!file || !file.path.startsWith(`${s.ownerId}/`) || file.path.includes('..')) return { ok: false, error: MESSAGES.download };
  const url = await deps.previewUrl(s.ownerId, file.path);
  return url ? { ok: true, url } : { ok: false, error: MESSAGES.download };
}
