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
 *              website (eligibility); on the lead database route (Batch 55) the website
 *              is the owner's calculator site and the domain is this app's own host,
 *              with the ads linking to /s/<slug>; a pack id, if sent, must be the owner's pack;
 *              photo references must be inside the owner's own uploads folder
 *   approve    the pack id must be the owner's pack
 *   download   the pack ad must be the owner's, and have that file (signedDownloadUrl)
 *   copy       the pack ad must be the owner's, and have that text; the log gets the
 *              ad code, the kind of text and its position, NEVER the text
 *   upload     the owner's own folder only; type, size and first bytes are checked here
 *   voice      (38b) changeVoice / retryVideo: the pack id must be the owner's pack and the version on screen
 *              is pinned; eligibility is checked (they can cost money); the generator's refusals become one
 *              plain sentence (plainRefusal)
 *   poll       (38b) read only: the pack id must be the owner's; answers with the video, approve and voice
 *              fields of view.ts (PollView) and nothing else: no id, no code, no path, no secret
 *   video url  (38b) a one-hour view link for a file of the owner's own READY video (or its poster) only
 *   brand      (Batch 55, lead database route only) the company name and colour sent with Make my ads are checked
 *              here (name 1 to 80 characters, colour #RRGGBB) and saved to the owner's OWN calculator site
 *              (deps.saveBrand, the calculator's own save path) before the ads are made; the Academy route ignores them
 *   logo       (Batch 55, lead database route only) a PNG or JPEG under 1 MB, saved as the owner's own calculator
 *              logo (deps.uploadBrandLogo, the calculator's own upload path)
 *
 * Nothing here returns a database field, an internal code or a raw error: every
 * refusal is one plain sentence.
 *
 * Pure: no network, no database, no server-only.
 */
import type { ApproveResult, ChangeVoiceResult, GenerateRequest, GenerateResult, PackView, RetryVideoResult } from '../../../lib/ad-packs/generate-core.ts';
import { busiestArea, parseAreaKey, type AreaOption } from '../../../lib/ad-packs/area.ts';
import { MAX_COVERAGE_AREAS, makeCoverage, type Coverage } from '../../../lib/ad-packs/coverage.ts';
import type { AdRoute, PackEligibilityReason } from '../../../lib/ad-packs/eligibility.ts';
import { checkPhoto, cleanPhotoRefs, MAX_UPLOADS_PER_OWNER, PHOTO_MESSAGES, uploadRef } from '../../../lib/ad-packs/photos.ts';
import type { PackAdRow } from '../../../lib/ad-packs/store-types.ts';
import { isVoiceKey, type VoiceKey } from '../../../lib/ad-packs/voices.ts';
import { validateCompany } from '../setup/website/steps.ts';
import { areaPreviewView, brandOfSettings, brandProblemText, BRAND_COLOUR_MISSING, BRAND_LOGO_FAILED, BRAND_LOGO_MAX_BYTES, BRAND_LOGO_TOO_BIG, BRAND_NAME_MISSING, BRAND_NAME_REFUSED, BRAND_NAME_TOO_LONG, BRAND_SAVE_FAILED, copyTargetExists, eligibilitySentence, isCopyKind, LOGO_REFUSAL, plainRefusal, pollViewOf, isVideoFileName, VIDEO_POSTER_NAME, type AreaPreviewInput, type AreaPreviewView, type CopyKind, type PollView, type SiteBrandInput } from './view.ts';

export type AdsState = { ok?: boolean; error?: string; notice?: string };
export type UploadState = { ok: true; ref: string; previewUrl: string | null } | { ok: false; error: string };
export type DownloadState = { ok: true; url: string } | { ok: false; error: string };
/** The answer to a poll: the lightweight video / approve / voice fields, or nothing (signed out, not the owner's pack). */
export type PollState = ({ ok: true } & PollView) | { ok: false };
/** The brand card's logo upload: the saved logo's address (shown back to the owner only), or one plain sentence. */
export type LogoState = { ok: true; url: string } | { ok: false; error: string };

export { BRAND_LOGO_MAX_BYTES };

export const MESSAGES = {
  signed_out: 'Please sign in again.',
  member: 'Only the account owner can make the ads.',
  not_found: 'We could not find your ads. Please reload the page and try again.',
  area: 'Please choose a place from the list.',
  photos: 'Those photos could not be used. Please add them again.',
  try_again: 'Something went wrong. Please try again.',
  download: 'We could not make that download link. Please try again.',
  not_eligible: 'Your Facebook ads are not available for this account yet.',
  voice: 'Please choose one of the three voices.',
  coverage: 'Please choose Anywhere in the UK, or choose your areas.',
  coverage_none: 'Please choose at least one place, or pick Anywhere in the UK.',
  coverage_many: `You can choose up to ${MAX_COVERAGE_AREAS} places.`,
  brand_name: BRAND_NAME_MISSING,
  brand_name_long: BRAND_NAME_TOO_LONG,
  brand_name_refused: BRAND_NAME_REFUSED,
  brand_colour: BRAND_COLOUR_MISSING,
  brand_save: BRAND_SAVE_FAILED,
  logo_too_big: BRAND_LOGO_TOO_BIG,
  logo_failed: BRAND_LOGO_FAILED,
} as const;

export type Session = { ok: true; ownerId: string; email: string | null; admin: boolean } | { ok: false; reason: 'signed_out' | 'member' };

export type EligibilityFacts = {
  eligible: boolean;
  reasons: PackEligibilityReason[];
  website?: { id: string; settings: SiteBrandInput };
  /** The live bare domain, only when it is live. On the lead database route: this app's own host. */
  domain?: string;
  /** Batch 55: which way in. Absent is the Academy route, exactly as before. */
  route?: AdRoute;
  /** The lead database route only: the calculator site's slug, so the ads link to /s/<slug>. */
  sitePath?: string;
};

export type AreaPreviewDep = AreaPreviewInput;

export interface AdsDeps {
  /** The signed-in account owner (ownerIdOrNull of the session's user); never from the browser. */
  session(): Promise<Session>;
  eligibility(userId: string, opts: { admin: boolean }): Promise<EligibilityFacts>;
  /** `bedrooms`: Batch 55 step 5, the lead database route's preferred count (absent on the Academy route). */
  areaPreview(areaKey: string, opts?: { bedrooms?: number }): Promise<AreaPreviewDep>;
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
  /**
   * Batch 55 step 5 (55c A1), the lead database route only: the bedroom count the pack prefers (the lowest in the
   * customer's pushed range, or null) and the pick-list key of their main area (the first of their calculator areas,
   * or null). Optional: absent, the lead database route behaves as before.
   */
  leadDbPackHints?(ownerId: string, areas: readonly string[]): Promise<{ bedrooms: number | null; mainAreaKey: string | null }>;
  /**
   * Batch 55 step 5 (Phase 3), the lead database route only: the place list the start screen offers (listDistricts).
   * The chosen keys are checked against it and their names taken from it. Optional: absent, the lead database route
   * takes one area as before.
   */
  areaOptions?(): Promise<AreaOption[]>;
  /**
   * Batch 55 (brand on the ads screen), the lead database route only: save the company name and colour to the owner's
   * own calculator site through the calculator's own save path (which marks changed fields edited first, so the lead
   * database push never overwrites them). Optional: absent, a brand change is refused.
   */
  saveBrand?(ownerId: string, brand: { companyName: string; brandColour: string }): Promise<{ ok: boolean }>;
  /** The same route only: store a checked PNG or JPEG as the owner's own calculator logo; its address, or not ok. */
  uploadBrandLogo?(ownerId: string, bytes: Uint8Array): Promise<{ ok: true; url: string } | { ok: false }>;
}

const sessionError = (s: Extract<Session, { ok: false }>): string => MESSAGES[s.reason];

const eligibilityError = (e: EligibilityFacts): string => (e.reasons.length > 0 ? eligibilitySentence(e.reasons[0]) : MESSAGES.not_eligible);

/** The owner's own pack, only when `packId` (if sent) names it. */
async function ownPack(deps: AdsDeps, ownerId: string, packId: unknown): Promise<{ ok: true; view: PackView | null } | { ok: false }> {
  const view = await deps.listPack(ownerId);
  if (packId === undefined || packId === null || packId === '') return { ok: true, view };
  if (typeof packId !== 'string' || !view || view.pack.id !== packId || view.pack.ownerId !== ownerId) return { ok: false };
  return { ok: true, view };
}

// ── Generate ──

/**
 * `coverage` ('uk' | 'areas') and `coverageAreas` (the chosen keys, in order) are read on the lead database route only
 * (Phase 3); the Academy route ignores them.
 */
export type GenerateInput = { packId?: unknown; areaKey?: unknown; photoRefs?: unknown; typeOnly?: unknown; voiceKey?: unknown; coverage?: unknown; coverageAreas?: unknown; companyName?: unknown; brandColour?: unknown };

export type BrandChoice = { ok: true; companyName: string; brandColour: string } | { ok: false; error: string };

/**
 * Batch 55 (brand on the ads screen): the brand card's company name (1 to 80 characters, the setup's own word rule)
 * and colour (#RRGGBB, kept lower case), checked. Pure.
 */
export function checkBrandInput(input: { companyName?: unknown; brandColour?: unknown }): BrandChoice {
  const name = typeof input.companyName === 'string' ? input.companyName.replace(/\s+/g, ' ').trim() : '';
  if (name === '') return { ok: false, error: MESSAGES.brand_name };
  if (name.length > 80) return { ok: false, error: MESSAGES.brand_name_long };
  const colour = typeof input.brandColour === 'string' ? input.brandColour.trim() : '';
  if (!/^#[0-9a-f]{6}$/i.test(colour)) return { ok: false, error: MESSAGES.brand_colour };
  const checked = validateCompany({ companyName: name, brandColour: colour });
  if (!checked.ok || !checked.value.brandColour) return { ok: false, error: MESSAGES.brand_name_refused };
  return { ok: true, companyName: checked.value.companyName, brandColour: checked.value.brandColour };
}

export type CoverageChoice = { ok: true; areaKey: string; coverage: Coverage } | { ok: false; error: string };

/**
 * Batch 55 step 5 (Phase 3): the lead database start screen's choice, checked. "Anywhere in the UK" (or nothing sent)
 * is nationwide, with the example figure from the customer's main area, else the place with the most reports.
 * "Choose areas" needs 1 to MAX_COVERAGE_AREAS keys from the place list; the first is where the figure comes from and
 * the names the ads say are the list's own. An older form that sends only `areaKey` is that one area.
 */
export function chooseCoverage(input: { coverage?: unknown; coverageAreas?: unknown; areaKey?: unknown }, options: readonly AreaOption[], mainAreaKey: string | null): CoverageChoice {
  const sentKeys = Array.isArray(input.coverageAreas) ? input.coverageAreas : typeof input.coverageAreas === 'string' && input.coverageAreas !== '' ? [input.coverageAreas] : [];
  const legacy = typeof input.areaKey === 'string' && input.areaKey.trim() !== '' ? input.areaKey : null;
  const mode = input.coverage === undefined || input.coverage === null || input.coverage === '' ? (legacy ? 'areas' : 'uk') : input.coverage;
  if (mode === 'uk') {
    const byKey = new Map(options.map((o) => [o.areaKey, o]));
    const main = mainAreaKey && byKey.has(mainAreaKey) ? mainAreaKey : null;
    const areaKey = main ?? busiestArea(options)?.areaKey ?? null;
    if (!areaKey) return { ok: false, error: MESSAGES.try_again };
    return { ok: true, areaKey, coverage: { mode: 'uk', areas: [] } };
  }
  if (mode !== 'areas') return { ok: false, error: MESSAGES.coverage };
  const keys: string[] = [];
  for (const k of input.coverage === undefined || input.coverage === null || input.coverage === '' ? [legacy] : sentKeys) {
    if (typeof k !== 'string' || parseAreaKey(k) === null) return { ok: false, error: MESSAGES.area };
    const key = k.trim().toUpperCase();
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length === 0) return { ok: false, error: MESSAGES.coverage_none };
  if (keys.length > MAX_COVERAGE_AREAS) return { ok: false, error: MESSAGES.coverage_many };
  const byKey = new Map(options.map((o) => [o.areaKey, o]));
  const names: string[] = [];
  for (const k of keys) {
    const o = byKey.get(k);
    if (!o) return { ok: false, error: MESSAGES.area };
    names.push(o.adLabel);
  }
  const coverage = makeCoverage('areas', names);
  if (!coverage) return { ok: false, error: MESSAGES.area };
  return { ok: true, areaKey: keys[0], coverage };
}

/** Make (or remake) the owner's pack. */
export async function generateOp(deps: AdsDeps, input: GenerateInput): Promise<AdsState> {
  const s = await deps.session();
  if (!s.ok) return { error: sessionError(s) };
  const elig = await deps.eligibility(s.ownerId, { admin: s.admin });
  if (!elig.eligible || !elig.website || !elig.domain) return { error: eligibilityError(elig) };
  // The lead database route needs the calculator site's slug as well; everything else about the Academy route is as it was.
  const leadDbRoute = elig.route === 'leaddb';
  if (leadDbRoute && !elig.sitePath) return { error: MESSAGES.not_eligible };

  const mine = await ownPack(deps, s.ownerId, input.packId);
  if (!mine.ok) return { error: MESSAGES.not_found };

  // Batch 55 (brand on the ads screen): on the lead database route the brand card sends the company name and colour
  // with the form. They are checked now, used for these ads, and saved (below, once everything else is checked) only
  // when they differ from what is stored. The Academy route never reads them.
  let settings = elig.website.settings;
  let brandToSave: { companyName: string; brandColour: string } | null = null;
  if (leadDbRoute && (input.companyName !== undefined || input.brandColour !== undefined)) {
    const sent = checkBrandInput(input);
    if (!sent.ok) return { error: sent.error };
    const storedColour = String(settings.brandColour ?? '').trim().toLowerCase();
    if (sent.companyName !== String(settings.companyName ?? '').trim() || sent.brandColour !== storedColour) brandToSave = { companyName: sent.companyName, brandColour: sent.brandColour };
    settings = { ...settings, companyName: sent.companyName, brandColour: sent.brandColour };
  }
  const { brand, problems } = brandOfSettings(settings);
  // Batch 55 step 5: on the lead database route, no area picked means the customer's main area, and the figure rests on
  // the lowest bedroom count they take. The Academy route reads neither.
  const hints = leadDbRoute && deps.leadDbPackHints ? await deps.leadDbPackHints(s.ownerId, brand.areas ?? []) : null;
  // Phase 3: on the lead database route, where to find landlords (anywhere in the UK, or the chosen areas).
  let coverage: Coverage | null = null;
  let areaKey: unknown;
  if (leadDbRoute && deps.areaOptions) {
    const choice = chooseCoverage(input, await deps.areaOptions(), hints?.mainAreaKey ?? null);
    if (!choice.ok) return { error: choice.error };
    coverage = choice.coverage;
    areaKey = choice.areaKey;
  } else {
    const picked = typeof input.areaKey === 'string' && input.areaKey.trim() !== '' ? input.areaKey : null;
    areaKey = picked ?? (leadDbRoute ? (hints?.mainAreaKey ?? null) : input.areaKey);
  }
  if (typeof areaKey !== 'string' || parseAreaKey(areaKey) === null) return { error: MESSAGES.area };
  const photos = cleanPhotoRefs(s.ownerId, input.photoRefs);
  if (photos === null) return { error: MESSAGES.photos };

  if (problems.length > 0) return { error: brandProblemText(problems[0], leadDbRoute ? 'leaddb' : 'academy') };
  // A lead database customer is never asked to tick a box: no logo simply means the company name is shown instead.
  const typeOnly = leadDbRoute || input.typeOnly === true || input.typeOnly === 'on' || input.typeOnly === 'true';
  if (brand.logoUrl === null && !typeOnly) return { error: LOGO_REFUSAL };
  // 38b: the voice for the video. Absent (a regenerate keeps the pack's voice) is fine; anything else must be one of the three.
  const voiceSent = input.voiceKey !== undefined && input.voiceKey !== null && input.voiceKey !== '';
  if (voiceSent && !isVoiceKey(input.voiceKey)) return { error: MESSAGES.voice };
  const voiceKey: VoiceKey | undefined = voiceSent && isVoiceKey(input.voiceKey) ? input.voiceKey : undefined;

  // Everything is checked: the brand card's changes are saved to the owner's own calculator site, then the ads are made.
  if (brandToSave) {
    const saved = deps.saveBrand ? await deps.saveBrand(s.ownerId, brandToSave) : { ok: false };
    if (!saved.ok) return { error: MESSAGES.brand_save };
  }

  const result = await deps.generate({
    ownerId: s.ownerId,
    by: 'operator',
    input: {
      areaKey: areaKey.trim().toUpperCase(),
      photos,
      brand: { company: brand.company, logoUrl: brand.logoUrl, brandColour: brand.brandColour, feePct: brand.feePct, areas: brand.areas, photoUrl: brand.photoUrl },
      domain: elig.domain,
      websiteId: elig.website.id,
      ...(leadDbRoute && elig.sitePath ? { route: 'leaddb' as const, sitePath: elig.sitePath } : {}),
      ...(leadDbRoute && typeof hints?.bedrooms === 'number' ? { bedrooms: hints.bedrooms } : {}),
      ...(leadDbRoute && coverage ? { coverage } : {}),
      typeOnly: brand.logoUrl === null && typeOnly,
      ...(voiceKey ? { voiceKey } : {}),
    },
  });
  if (!result.ok) return { error: plainRefusal(result.code, result.message) };
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
  if (!out.ok) return { error: plainRefusal(out.code, out.message) };
  // Record only what the generator says happened; the version, never anything the owner wrote.
  await deps.record(s.ownerId, out.activityKind, { extras: { version: out.version }, dedupeKey: `ad_pack_approved:${out.packId}:v${out.version}` });
  return { ok: true, notice: 'Done. Your ads are ready to put on Facebook.' };
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

// ── The brand card's logo (Batch 55, lead database route only) ──

const isPngOrJpeg = (b: Uint8Array): boolean => (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff);

export async function brandLogoOp(deps: AdsDeps, input: { bytes: Uint8Array | null }): Promise<LogoState> {
  const s = await deps.session();
  if (!s.ok) return { ok: false, error: sessionError(s) };
  const elig = await deps.eligibility(s.ownerId, { admin: s.admin });
  if (!elig.eligible) return { ok: false, error: eligibilityError(elig) };
  // The Academy route's logo is its website's: only the lead database route sets one here.
  if (elig.route !== 'leaddb') return { ok: false, error: MESSAGES.not_eligible };
  const bytes = input.bytes;
  if (!bytes || bytes.length === 0) return { ok: false, error: MESSAGES.logo_failed };
  if (bytes.length > BRAND_LOGO_MAX_BYTES) return { ok: false, error: MESSAGES.logo_too_big };
  if (!isPngOrJpeg(bytes)) return { ok: false, error: MESSAGES.logo_failed };
  if (!deps.uploadBrandLogo) return { ok: false, error: MESSAGES.logo_failed };
  const out = await deps.uploadBrandLogo(s.ownerId, bytes);
  return out.ok ? { ok: true, url: out.url } : { ok: false, error: MESSAGES.logo_failed };
}

// ── The area step ──

export async function areaPreviewOp(deps: AdsDeps, input: { areaKey?: unknown }): Promise<AreaPreviewView> {
  const s = await deps.session();
  if (!s.ok) return { ok: false, bedrooms: null, text: sessionError(s) };
  const elig = await deps.eligibility(s.ownerId, { admin: s.admin });
  if (!elig.eligible) return { ok: false, bedrooms: null, text: eligibilityError(elig) };
  if (typeof input.areaKey !== 'string' || parseAreaKey(input.areaKey) === null) return { ok: false, bedrooms: null, text: MESSAGES.area };
  // Batch 55 step 5: the lead database route previews the bedroom count the pack will really use.
  if (elig.route === 'leaddb' && deps.leadDbPackHints) {
    const hints = await deps.leadDbPackHints(s.ownerId, []);
    if (typeof hints.bedrooms === 'number') return areaPreviewView(await deps.areaPreview(input.areaKey, { bedrooms: hints.bedrooms }));
  }
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
  if (!out.ok) return { error: plainRefusal(out.code, out.message) };
  return { ok: true, notice: out.free ? 'Your video is being made again with the new voice. This change was free.' : 'Your video is being made again with the new voice. This takes about 5 to 10 minutes, and we will email you when it is ready.' };
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
  if (!out.ok) return { error: plainRefusal(out.code, out.message) };
  return { ok: true, notice: 'Trying again. This takes about 5 to 10 minutes, and we will email you when it is ready.' };
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
