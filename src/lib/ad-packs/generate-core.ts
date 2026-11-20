/**
 * Batch 38: the pack generator, as a pure engine. Everything outside it is
 * injected (the store, the clock, the image renderer, the file uploader, the
 * area's market data and the price list), so it is tested with the in-memory
 * store and no database, network or server-only. generate-server.ts wires the
 * real ones.
 *
 *   generatePack({ownerId, by, dry, input})   make (or remake) the owner's pack
 *   approvePack({ownerId, expectedVersion?})                  preview -> approved (only with the 5b video ready)
 *   changeVoice({ownerId, voiceKey, expectedVersion?})        another voice, same version, before approving (38b)
 *   retryVideo({ownerId, expectedVersion?})                   try a failed video render again, same version (38b)
 *   listPackForOwner(ownerId)                 the screen's read model
 *
 * ORDER of generatePack (the first refusal stops a real run; a dry run
 * reports it as `wouldBlock` and carries on, writing nothing):
 *   1  in_progress       another generation holds the pack (stale after 10 minutes)
 *   2  regen_used / no_brand_change   operator regenerate only (admin: skipped, and never counted)
 *   3  cost_cap          estimateRawPence (images + the voiceover + the render sandbox, 38b) over
 *                        ad_pack_max_raw_pence   (BEFORE any paid call)
 *   4  spend_unknown / monthly_cap    this UK month's non-dry spend plus the estimate over ad_pack_monthly_cap_pence
 *   5  not_enough_data   areaFigureSource found too few reports (nothing is written)
 *   6  the pack is taken ('generating'; the operator code is allocated on the first pack),
 *      images are rendered and uploaded, runChecks runs, ads and the pack are stored,
 *      one ad_pack_runs row is written (cost, by, result summary)
 * 7  (38b) when the pack reached 'preview': the 5b ad's video slot is {status:'queued'} (written with the ad) and the
 *      version's render is enqueued with the pack's voice. A failed enqueue never loses the pack: the slot becomes
 *      {status:'failed', code} and the screen offers retryVideo. A dry run enqueues and writes nothing.
 * A thrown error in step 6 sets the pack 'failed' with a short error_code
 * (render_failed, upload_failed, store_failed, generate_failed): never the
 * error's own message, which could carry user data.
 *
 * VERSIONS. The first pack is version 1 (codes ...-1). A regenerate is
 * version n+1 with its own codes (SI-<op>-5B-2 ...). The pack row's version,
 * brand_hash and regen_count move only when the new version is stored, so a
 * failed regenerate leaves the previous version as it was, and a repeat is
 * judged against the last version that was really made. When the new version
 * passes its checks the older versions' ads get superseded_at; their codes
 * stay valid (a lead from an old ad still matches).
 *
 * VOICE. The voice (a B3 VoiceKey) is chosen on the first generation (input.voiceKey, default DEFAULT_VOICE_KEY) and
 * stored in ad_packs.voice_key. A regenerate (operator's or admin's) KEEPS the stored voice and ignores input.voiceKey:
 * the voice changes only through changeVoice. ad_packs.voice_changes (the allowance used) is NOT reset by a regenerate:
 * the allowance is per pack, not per version.
 *
 * Never logs an address or a body: log lines carry a pack id and a code.
 *
 * Pure: no network, no database, no server-only.
 */
import { createHash } from 'node:crypto';
import { UNIT_COST_SEED } from '../credit/costs.ts';
import { monthStartIso } from './month.ts';
import { angleDef, renderCards, renderScript, renderTexts, type Card } from './angles.ts';
import { NET_INCLUDES_MANAGEMENT_FEE } from './area.ts';
import { runChecks, type CheckInput, type ChecksOutput } from './checks.ts';
import { ANGLES, operatorCode as allocateOperatorCode, packCode, type Angle } from './codes.ts';
import { cleanLines } from './captions.ts';
import { buildFigure, type Figure, type FigureAgg } from './figures.ts';
import { adLink, adName } from './links.ts';
import { isRetryableRenderCode, type AdVideo, type RenderRequeue, type RenderRow, type RenderState } from './render-store.ts';
import type { EnqueueResult } from './render-core.ts';
import { fitsCap, SANDBOX_SECONDS_CAP, type AdPackSettings } from './settings.ts';
import { estimateVoicePence, MAX_VOICE_CHARACTERS } from './voice-core.ts';
import { DEFAULT_VOICE_KEY, isVoiceKey, type VoiceKey } from './voices.ts';
import {
  PackConflict,
  StoreError,
  type AdFileRef,
  type AdFiles,
  type AdPackStore,
  type AdTexts,
  type NewAd,
  type PackAdRow,
  type PackRow,
  type PackStatus,
  type RunBy,
  type RunResult,
} from './store-types.ts';

export { monthStartIso };

// ── Constants ──

/** The operator's own photos in a pack. */
export const MAX_PHOTOS = 4;
/** A 'generating' pack older than this is taken as abandoned and may be generated again. */
export const STALE_GENERATING_MS = 10 * 60_000;

/** The three sizes every image card is made at (mirrors CARD_SIZES / SIZE_PX in images.tsx; a test pins it). */
export const IMAGE_SIZES = [
  { key: '1x1', width: 1080, height: 1080 },
  { key: '4x5', width: 1080, height: 1350 },
  { key: '9x16', width: 1080, height: 1920 },
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

// ── Codes and messages ──

export const GENERATE_CODES = [
  'invalid_input',
  'in_progress',
  'no_brand_change',
  'regen_used',
  'cost_cap',
  'monthly_cap',
  'spend_unknown',
  'not_enough_data',
  'store_failed',
  'render_failed',
  'upload_failed',
  'generate_failed',
] as const;
export type GenerateCode = (typeof GENERATE_CODES)[number];

const TRY_AGAIN = 'Something went wrong making your pack. Nothing was lost. Try again, and tell us if it keeps happening.';
export const GENERATE_MESSAGES: Record<GenerateCode, string> = {
  invalid_input: 'Something in the request was not valid, so no pack was made.',
  in_progress: 'Your pack is being made. Give it a few minutes.',
  no_brand_change: 'Your brand has not changed since the last pack. Change your logo, colour, company name, fee, photos or area first.',
  regen_used: 'You have used your free regeneration.',
  cost_cap: 'This pack would cost more than the limit for one pack, so it was not made.',
  monthly_cap: 'The limit for making packs this month has been reached. Try again next month.',
  spend_unknown: 'We could not check this month’s limit just now. Try again shortly.',
  not_enough_data: 'There is not enough data in your area yet.',
  store_failed: TRY_AGAIN,
  render_failed: TRY_AGAIN,
  upload_failed: TRY_AGAIN,
  generate_failed: TRY_AGAIN,
};

export function generateMessage(code: string): string {
  return (GENERATE_MESSAGES as Record<string, string>)[code] ?? TRY_AGAIN;
}

// ── The video: codes and plain messages (38b) ──

/** Why approve refuses because of the video (besides the 38a codes). */
export const VIDEO_APPROVE_CODES = ['video_pending', 'video_failed'] as const;
/** Why changeVoice or retryVideo refuses (besides the cost codes cost_cap, monthly_cap, spend_unknown). */
export const VIDEO_ACTION_CODES = ['invalid_input', 'no_pack', 'not_preview', 'after_approval', 'same_voice', 'voice_limit_used', 'video_running', 'not_retryable', 'store_failed'] as const;
export type VideoActionCode = (typeof VIDEO_ACTION_CODES)[number] | 'cost_cap' | 'monthly_cap' | 'spend_unknown';

export const VIDEO_MESSAGES = {
  video_pending: 'Your video is still being made. It usually takes a few minutes.',
  video_failed: 'We couldn’t make your video yet. Press “Try again” to have another go, and tell us if it keeps happening.',
  voice_unavailable: 'That voice isn’t available right now. Choose another voice and we’ll make your video again. This change doesn’t count.',
  after_approval: 'You can change the voice before you approve your ads.',
  same_voice: 'That is the voice your video already has. Choose a different one.',
  voice_limit_used: 'You have already used your voice change.',
  video_running: 'Your video is being made right now. Wait until it is finished, then change the voice.',
  not_retryable: 'There is nothing to try again right now.',
  stale: 'Your ads changed while you were looking. Please look at them again first.',
} as const;

/** The plain message for a video that could not be made (a render code in, a sentence out; never the code itself). */
export function videoFailedMessage(code: string | null | undefined): string {
  return code === 'voice_unavailable' ? VIDEO_MESSAGES.voice_unavailable : VIDEO_MESSAGES.video_failed;
}

export type Refusal = { code: GenerateCode; message: string };
const refusal = (code: GenerateCode): Refusal => ({ code, message: GENERATE_MESSAGES[code] });

class GenError extends Error {
  readonly code: GenerateCode;
  constructor(code: GenerateCode) {
    super(code);
    this.name = 'GenError';
    this.code = code;
  }
}

// ── Inputs and dependencies ──

export type GenerateBrand = {
  company: string;
  logoUrl: string | null;
  brandColour: string | null;
  feePct: number | null;
  /** The website's free-text areas. Carried for the caller; the pack's area is `areaKey`. */
  areas?: string[];
  /** The website's own photo (a fall-back for cards when the pack has no photo). */
  photoUrl: string | null;
};

export type GenerateInput = {
  /** A market area key: a district ("NG7") or a postcode area ("NG"). */
  areaKey: string;
  /** Reserved: the most common bedroom count of the area is always used (areaFigureSource). */
  bedrooms?: number | null;
  /** The operator's own photos, 4 at most. */
  photos: string[];
  brand: GenerateBrand;
  /** The operator's live bare domain, e.g. acme.co.uk. */
  domain: string;
  websiteId?: string | null;
  /** The operator chose to run the ads with their name in type only (no logo). */
  typeOnly?: boolean;
  /**
   * The voiceover (38b). Default DEFAULT_VOICE_KEY. Used on the first generation only: a regenerate keeps the pack's
   * stored voice (an unknown key is invalid_input either way). changeVoice is how the voice changes afterwards.
   */
  voiceKey?: VoiceKey;
};

export type GenerateRequest = { ownerId: string; by: RunBy; dry?: boolean; input: GenerateInput };

export type RenderedImage = { name: string; width: number; height: number; png: Uint8Array };
export type ImageRenderer = (args: {
  angle: Angle;
  cards: Card[];
  brand: { company: string; brandColour: string | null; logoUrl: string | null };
  photos: { pack: string[]; site: string | null };
}) => Promise<RenderedImage[]>;

export type FileUploader = (path: string, bytes: Uint8Array, contentType: string) => Promise<{ ok: boolean }>;

export type AreaSource = {
  areaKey: string;
  areaLabel: string;
  level: 'district' | 'area';
  fellBack: boolean;
  bedrooms: number;
  agg: FigureAgg;
  samples: number;
};
export type AreaSourceResult = AreaSource | { error: 'not_enough_data'; message?: string };

export type Pricing = {
  /** Worst-case raw pence of a generation, before any paid call. */
  estimate: (angles: readonly Angle[]) => number;
  /** What the generation really cost. */
  actual: (angles: readonly Angle[]) => number;
};

/** The render queue as the generator needs it (render-core's RenderStore and enqueueRender satisfy it; tests use a fake). */
export interface RenderQueue {
  /** Queue the version's render (insert if missing; never throws). */
  enqueue(i: { packId: string; version: number; voiceKey: VoiceKey }): Promise<EnqueueResult>;
  /** The version's render row, or null. */
  get(packId: string, version: number): Promise<RenderRow | null>;
  /** Reset the version's render to start again; null while a worker is running it. */
  requeue(i: RenderRequeue): Promise<RenderRow | null>;
}

export type GenerateDeps = {
  store: AdPackStore;
  /** The notice video's render queue (38b). */
  renders: RenderQueue;
  /** Remove stored files by path (a voice change drops the version's cached voice.mp3 and script.json). */
  deleteFiles: (paths: string[]) => Promise<{ ok: boolean }>;
  /** Raw pence per sandbox CPU-second for the cost guard (the unit_costs row); the seed when omitted or unreadable. */
  sandboxCpuSecondPence?: () => Promise<number>;
  now: () => Date;
  renderImages: ImageRenderer;
  upload: FileUploader;
  areaFigureSource: (a: { areaKey: string; minSamples: number }) => Promise<AreaSourceResult>;
  pricing?: Pricing;
  /** Log a line: an event name, a pack id and a code. Never anything else. */
  log?: (event: string, fields: { packId?: string; code?: string }) => void;
};

// ── Pure helpers ──

/** Pence per sandbox CPU-second when the live unit cost cannot be read (the seed row, mirrors schema.sql). */
export const SEED_SANDBOX_CPU_SECOND_PENCE: number = UNIT_COST_SEED.find((r) => r.provider === 'vercel' && r.unit === 'sandbox_cpu_second')?.unitCostPence ?? 0.00280889;

export type VideoEstimateInput = {
  /** The voiceover's script lines (what is sent to the voice). */
  lines: readonly string[];
  voiceKey: VoiceKey;
  /** ad_pack_render_max_seconds (the estimate prices min(this, SANDBOX_SECONDS_CAP), what the worker really allows). */
  maxSeconds: number;
  /** ad_pack_sandbox_vcpus. */
  vcpus: number;
  /** Raw pence per sandbox CPU-second; default the seed. */
  cpuSecondPence?: number;
};

/**
 * Worst-case raw cost of ONE video render attempt, in whole pence rounded up: the voiceover (B3
 * estimateVoicePence, billed per character) plus the sandbox at its time limit (vcpus x seconds x the CPU-second
 * price). Pessimistic on purpose: it prices the full time limit, not the ~30 s a render takes.
 */
export function estimateVideoPence(i: VideoEstimateInput): number {
  const voice = estimateVoicePence(i.lines, i.voiceKey);
  const unit = i.cpuSecondPence ?? SEED_SANDBOX_CPU_SECOND_PENCE;
  const seconds = Math.max(0, Math.min(i.maxSeconds, SANDBOX_SECONDS_CAP));
  const raw = Math.max(0, i.vcpus) * seconds * Math.max(0, unit);
  return voice + (raw > 0 ? Math.ceil(raw - 1e-9) : 0);
}

/**
 * Worst-case raw cost of generating the angles, in pence. The images are made in-process and cost nothing per
 * call, so without `video` it is 0 (38a). With `video` (38b) the voiceover and the render sandbox are added.
 */
export function estimateRawPence(angles: readonly Angle[], video?: VideoEstimateInput): number {
  void angles;
  return video ? estimateVideoPence(video) : 0;
}

/** The lines the 5b voiceover will say for a brand and figure (what renderScript gives, one string per line). */
function voiceLinesFor(input: GenerateInput, source: AreaSource | null, figure: Figure | null): string[] {
  const brand = { company: input.brand.company.trim(), area: source?.areaLabel ?? input.areaKey, bedrooms: source?.bedrooms ?? 3, feePct: input.brand.feePct ?? null };
  const lines = renderScript({ brand, figure }).lines;
  return lines.length > 0 ? [...lines] : ['x'.repeat(Math.min(MAX_VOICE_CHARACTERS, 600))];
}

/** The storage paths of a version's cached voiceover (mirrors render-core voicePaths; a test pins it). */
export function voiceFilePaths(ownerId: string, packId: string, version: number): string[] {
  const folder = `${ownerId}/${packId}/v${version}`;
  return [`${folder}/voice.mp3`, `${folder}/script.json`];
}

export type BrandHashInput = {
  company: string;
  logoUrl: string | null;
  brandColour: string | null;
  feePct: number | null;
  photos: readonly string[];
  areaKey: string;
};

/**
 * A stable hash of what makes a pack look the way it does: company, logo,
 * colour, fee, photos (in order) and area. Whitespace, case of the colour and
 * of the area key do not matter; anything else that changes does.
 */
export function brandHash(i: BrandHashInput): string {
  const norm = [
    String(i.company ?? '').replace(/\s+/g, ' ').trim(),
    String(i.logoUrl ?? '').trim() || null,
    String(i.brandColour ?? '').trim().toLowerCase() || null,
    typeof i.feePct === 'number' && Number.isFinite(i.feePct) ? i.feePct : null,
    (i.photos ?? []).map((p) => String(p ?? '').trim()).filter((p) => p !== ''),
    String(i.areaKey ?? '').trim().toUpperCase(),
  ];
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

/** Why an operator may not regenerate right now, or null when they may. Admin regenerates are never blocked by this. */
export function regenerateBlock(pack: PackRow | null, currentHash: string, settings: Pick<AdPackSettings, 'freeRegens'>): 'regen_used' | 'no_brand_change' | null {
  if (!pack || pack.generatedAt === null) return null;
  if (pack.regenCount >= settings.freeRegens) return 'regen_used';
  if (pack.brandHash === currentHash) return 'no_brand_change';
  return null;
}

// ── The video: pure rules (38b) ──

const NOT_PREVIEW_MESSAGE = 'Only a pack that is ready to look at can be approved.';

/** The 5b video's live state from the ad's slot and the version's render row (see VideoView). */
export function videoViewOf(slot: AdVideo | null | undefined, render: RenderRow | null, packStatus: PackStatus): VideoView {
  let status: VideoView['status'];
  let code: string | null = null;
  if (render) {
    if (render.state === 'done') status = slot?.status === 'ready' ? 'ready' : 'making';
    else if (render.state === 'running') status = 'making';
    else if (render.state === 'queued') status = 'queued';
    else {
      status = 'failed';
      code = render.errorCode ?? 'render_failed';
    }
  } else if (!slot) {
    status = 'coming';
  } else {
    status = slot.status;
    if (slot.status === 'failed') code = slot.code;
  }
  const pending = status === 'queued' || status === 'making';
  const retryable = packStatus === 'preview' || packStatus === 'checks_failed';
  const canRetry = retryable && status === 'failed' && isRetryableRenderCode(code) && (render === null || render.state === 'failed');
  return {
    status,
    code,
    message: status === 'failed' ? videoFailedMessage(code) : pending ? VIDEO_MESSAGES.video_pending : null,
    poll: pending,
    canRetry,
  };
}

/**
 * Why approvePack would refuse, or null when it would accept: the pack is in 'preview', every check passes (the
 * video check included) and the 5b video is ready. No image-only fallback: the pack is approved with all 3 ads.
 */
export function approvalBlock(pack: PackRow, slot: AdVideo | null | undefined, render: RenderRow | null): { code: ApproveCode; message: string } | null {
  if (pack.status !== 'preview') return { code: 'not_preview', message: NOT_PREVIEW_MESSAGE };
  if (!pack.checks || pack.checks.ok !== true) return { code: 'not_preview', message: NOT_PREVIEW_MESSAGE };
  const v = videoViewOf(slot, render, pack.status);
  if (v.status === 'failed') return { code: 'video_failed', message: videoFailedMessage(v.code) };
  if (v.status !== 'ready') return { code: 'video_pending', message: VIDEO_MESSAGES.video_pending };
  return null;
}

/**
 * Whether the voice can change now. `free` is true when the render ended `voice_unavailable`: the voice was never
 * heard, so the change does not use the allowance (and is allowed even when the allowance is used up).
 * `target` is the voice asked for, when there is one (the same voice is refused).
 */
export function voiceChangeState(
  pack: PackRow,
  render: RenderRow | null,
  settings: Pick<AdPackSettings, 'voiceChanges'>,
  target?: VoiceKey,
): { blocked: { code: VideoActionCode; message: string } | null; free: boolean; changesLeft: number } {
  const free = render !== null && render.state === 'failed' && render.errorCode === 'voice_unavailable';
  const changesLeft = Math.max(0, settings.voiceChanges - pack.voiceChanges);
  const block = (code: VideoActionCode, message: string) => ({ blocked: { code, message }, free, changesLeft });
  if (pack.status === 'approved') return block('after_approval', VIDEO_MESSAGES.after_approval);
  if (pack.status !== 'preview') return block('not_preview', 'Only a pack that is ready to look at can have its voice changed.');
  if (target !== undefined && target === pack.voiceKey) return block('same_voice', VIDEO_MESSAGES.same_voice);
  if (render !== null && render.state === 'running') return block('video_running', VIDEO_MESSAGES.video_running);
  if (!free && changesLeft <= 0) return block('voice_limit_used', VIDEO_MESSAGES.voice_limit_used);
  return { blocked: null, free, changesLeft };
}

function renderViewOf(render: RenderRow | null): RenderView | null {
  return render ? { state: render.state, errorCode: render.errorCode, attempts: render.attempts, voiceKey: render.voiceKey, retryable: render.state === 'failed' && isRetryableRenderCode(render.errorCode) } : null;
}

function validate(req: GenerateRequest): boolean {
  const i = req?.input;
  if (!req || typeof req.ownerId !== 'string' || !UUID_RE.test(req.ownerId)) return false;
  if (req.by !== 'operator' && req.by !== 'admin') return false;
  if (!i || typeof i.areaKey !== 'string' || i.areaKey.trim() === '') return false;
  if (!Array.isArray(i.photos) || i.photos.length > MAX_PHOTOS || i.photos.some((p) => typeof p !== 'string')) return false;
  if (!i.brand || typeof i.brand.company !== 'string') return false;
  if (i.brand.feePct !== null && i.brand.feePct !== undefined && (typeof i.brand.feePct !== 'number' || !Number.isFinite(i.brand.feePct))) return false;
  if (typeof i.domain !== 'string' || !HOST_RE.test(i.domain.trim().toLowerCase())) return false;
  if (i.voiceKey !== undefined && !isVoiceKey(i.voiceKey)) return false;
  return true;
}

/** The file names an image ad will have: 3a-card1-4x5.png (mirrors imageName in images.tsx; a test pins it). */
export function plannedImageNames(angle: Angle, cardCount: number): { name: string; width: number; height: number }[] {
  const out: { name: string; width: number; height: number }[] = [];
  for (let c = 1; c <= cardCount; c++) for (const s of IMAGE_SIZES) out.push({ name: `${angle}-card${c}-${s.key}.png`, width: s.width, height: s.height });
  return out;
}

type PlannedAd = {
  angle: Angle;
  n: number;
  code: string;
  adName: string;
  link: string;
  texts: AdTexts;
  leadForm: NewAd['leadForm'];
  cards: Card[];
  video: 'coming' | null;
};

function cardText(c: Card): string {
  return [c.headline, ...c.body, c.cta, c.big ?? ''].filter(Boolean).join('\n');
}

function planAds(a: { input: GenerateInput; source: AreaSource; figure: Figure | null; operator: string; version: number }): PlannedAd[] {
  const brand = { company: a.input.brand.company.trim(), area: a.source.areaLabel, bedrooms: a.source.bedrooms, feePct: a.input.brand.feePct ?? null };
  const domain = a.input.domain.trim().toLowerCase();
  return ANGLES.map((angle): PlannedAd => {
    const code = packCode(a.operator, angle, a.version);
    const texts: AdTexts = { ...renderTexts({ angle, brand, figure: a.figure }) };
    let cards: Card[] = [];
    if (angle === '5b') {
      texts.script = renderScript({ brand, figure: a.figure }).text;
    } else {
      cards = renderCards({ angle, brand, figure: a.figure });
      texts.cardsText = cards.map(cardText);
    }
    return {
      angle,
      n: a.version,
      code,
      adName: adName(code, angle),
      link: adLink({ domain, code, operatorCode: a.operator }),
      texts,
      leadForm: [...angleDef(angle).leadFormQuestions],
      cards,
      video: angle === '5b' ? 'coming' : null,
    };
  });
}

function checkInputOf(a: { input: GenerateInput; source: AreaSource; figure: Figure | null; operator: string; planned: PlannedAd[]; files: Map<Angle, { name: string; width: number; height: number }[]> }): CheckInput {
  return {
    brand: {
      company: a.input.brand.company.trim(),
      logoUrl: a.input.brand.logoUrl ?? null,
      brandColour: a.input.brand.brandColour ?? null,
      feePct: a.input.brand.feePct ?? null,
      areaLabel: a.source.areaLabel,
      areaKey: a.source.areaKey,
      typeOnly: a.input.typeOnly === true,
    },
    ads: a.planned.map((p) => ({
      angle: p.angle,
      code: p.code,
      adName: p.adName,
      link: p.link,
      texts: p.texts,
      script: p.texts.script,
      cardsText: p.texts.cardsText,
      files: a.files.get(p.angle) ?? [],
    })),
    figures: a.figure ? [{ areaKey: a.source.areaKey, label: a.figure.label, sentence: a.figure.sentence }] : [],
    operatorCode: a.operator,
    domain: a.input.domain.trim().toLowerCase(),
  };
}

function figureEntry(figure: Figure, source: AreaSource): Record<string, unknown> {
  return {
    areaKey: source.areaKey,
    level: source.level,
    fellBack: source.fellBack,
    samples: source.samples,
    bedrooms: figure.bedrooms,
    basis: figure.basis,
    amount: figure.amount,
    label: figure.label,
    sentence: figure.sentence,
  };
}

// ── Results ──

export type PlanAd = {
  angle: Angle;
  code: string;
  adName: string;
  link: string;
  texts: AdTexts;
  /** Planned image files (names, sizes and the storage path they would have). */
  files: { name: string; width: number; height: number; path: string }[];
  video: 'coming' | null;
};

export type DryPlan = {
  version: number;
  regenerate: boolean;
  operatorCode: string;
  brandHash: string;
  areaKey: string;
  areaLabel: string;
  bedrooms: number;
  fellBack: boolean;
  figure: Figure | null;
  /** The voice the video would be made with (the pack's own on a regenerate). */
  voiceKey: VoiceKey;
  /** Worst-case raw pence: images, the voiceover and the render sandbox. */
  estimatedCostPence: number;
  /** This UK month's spend so far, or null when it could not be read. */
  monthSpendPence: number | null;
  ads: PlanAd[];
  checks: ChecksOutput;
};

export type GenerateOk = {
  ok: true;
  dry: false;
  status: 'preview' | 'checks_failed';
  packId: string;
  version: number;
  operatorCode: string;
  regenerate: boolean;
  ads: { id: string; angle: Angle; code: string; adName: string; link: string }[];
  checks: ChecksOutput;
  costPence: number;
  regenCount: number;
  voiceKey: VoiceKey;
  /**
   * The 5b video: 'queued' (its render is waiting for the worker; poll listPackForOwner), 'failed' (it could not
   * even be queued: `code` is a short code, the pack is kept and retryVideo can try again), or 'coming' (the pack
   * failed its checks, so no video is made).
   */
  video: { status: 'queued' | 'failed' | 'coming'; code?: string };
};
export type GenerateDry = { ok: true; dry: true; wouldBlock: Refusal | null; plan: DryPlan | null };
export type GenerateFail = { ok: false; code: GenerateCode; message: string; packId?: string };
export type GenerateResult = GenerateOk | GenerateDry | GenerateFail;

export type ApproveCode = 'invalid_input' | 'no_pack' | 'not_preview' | 'store_failed' | (typeof VIDEO_APPROVE_CODES)[number];
export type ApproveResult =
  | { ok: true; activityKind: 'ad_pack_approved'; packId: string; version: number; operatorCode: string }
  | { ok: false; code: ApproveCode; message: string };

export type ChangeVoiceResult =
  | { ok: true; packId: string; version: number; voiceKey: VoiceKey; /** true when it did not use the allowance (the old voice was unavailable) */ free: boolean; changesLeft: number }
  | { ok: false; code: VideoActionCode; message: string };

export type RetryVideoResult =
  | { ok: true; packId: string; version: number; voiceKey: VoiceKey }
  | { ok: false; code: VideoActionCode; message: string };

/** The version's render row as the screen needs it (nothing but states and short codes). */
export type RenderView = { state: RenderState; errorCode: string | null; attempts: number; voiceKey: string; retryable: boolean };

/**
 * What to show for the 5b video. `status` is the live truth: it follows the render row when there is one (a worker
 * that has the row is 'making' even if the ad's slot still says 'queued'), else the ad's slot. `poll` is true
 * while the video is on its way (queued or making): ask listPackForOwner again every few seconds.
 */
export type VideoView = {
  status: 'coming' | 'queued' | 'making' | 'ready' | 'failed';
  /** A short code when failed (e.g. voice_unavailable, sandbox_failed, monthly_cap). Never shown as is. */
  code: string | null;
  /** The plain sentence for a failed video or one still being made; null otherwise. */
  message: string | null;
  poll: boolean;
  /** retryVideo would be accepted now. */
  canRetry: boolean;
};

/** Whether (and why not) the voice can be changed now, for the voice step of the screen. */
export type VoiceView = {
  /** The voice the video has (or is being made with). Null before the first pack. */
  key: VoiceKey | null;
  changesLeft: number;
  /** changeVoice (to a different voice) would be accepted now. */
  canChange: boolean;
  /** The change would not use the allowance (the current voice was unavailable). */
  free: boolean;
  /** Why not, as a code and a plain sentence; null when canChange. */
  blocked: { code: VideoActionCode; message: string } | null;
};

/** Whether approvePack would accept the pack now, and if not, why. */
export type ApprovalView = { ok: true } | { ok: false; code: ApproveCode; message: string };

export type PackView = {
  pack: PackRow;
  /** The ads of the pack's current version, 5b then 3a then 17. */
  ads: PackAdRow[];
  /** True when the operator may be shown the ads (preview, approved, or a failed regenerate that kept a good version). */
  showAds: boolean;
  /** Codes of older versions: still valid, never shown as current. */
  olderCodes: string[];
  freeRegensLeft: number;
  /** The current version's render row (38b), or null when there is none. */
  render: RenderView | null;
  /** The 5b video's live state (38b). */
  video: VideoView;
  /** The voice step (38b). */
  voice: VoiceView;
  /** What approvePack would say right now. */
  approval: ApprovalView;
};

const fail = (code: GenerateCode, packId?: string): GenerateFail => ({ ok: false, code, message: GENERATE_MESSAGES[code], ...(packId ? { packId } : {}) });

// ── The engine ──

export function createAdPackEngine(deps: GenerateDeps) {
  const { store } = deps;
  const pricing: Pricing = deps.pricing ?? { estimate: estimateRawPence, actual: estimateRawPence };
  const log = deps.log ?? (() => {});

  async function createPack(ownerId: string, websiteId: string | null): Promise<PackRow> {
    const extra = new Set<string>();
    for (let attempt = 0; attempt < 8; attempt++) {
      const taken = await store.takenOperatorCodes();
      for (const c of extra) taken.add(c);
      const code = allocateOperatorCode(ownerId, taken);
      try {
        return await store.insertPack({ ownerId, websiteId, operatorCode: code, status: 'generating' });
      } catch (e) {
        if (e instanceof PackConflict && e.which === 'operator_code') {
          extra.add(code);
          continue;
        }
        if (e instanceof PackConflict && e.which === 'owner') throw new GenError('in_progress');
        throw e;
      }
    }
    throw new GenError('store_failed');
  }

  // ── The video's helpers (38b) ──

  async function cpuSecondPence(): Promise<number> {
    try {
      const v = await deps.sandboxCpuSecondPence?.();
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    } catch {
      // the seed stands
    }
    return SEED_SANDBOX_CPU_SECOND_PENCE;
  }

  /** The most one render attempt can cost us for these lines and this voice, from the settings and the live price. */
  async function videoEstimateFor(settings: AdPackSettings, lines: readonly string[], voiceKey: VoiceKey): Promise<number> {
    return estimateVideoPence({ lines, voiceKey, maxSeconds: settings.renderMaxSeconds, vcpus: settings.sandboxVcpus, cpuSecondPence: await cpuSecondPence() });
  }

  /** The same two caps generatePack applies, for an operation that pays for one more render (a voice change, a retry). */
  async function capRefusal(settings: AdPackSettings, estimate: number): Promise<'cost_cap' | 'monthly_cap' | 'spend_unknown' | null> {
    if (estimate > settings.maxRawPence) return 'cost_cap';
    const spent = await store.monthSpendPence(monthStartIso(deps.now()));
    if (spent === null) return 'spend_unknown';
    return fitsCap(spent, estimate, settings.monthlyCapPence) ? null : 'monthly_cap';
  }

  /** The ad's video slot, best effort (the render row is the truth the screen follows). */
  async function setSlot(ownerId: string, adId: string | null, packId: string, video: AdVideo): Promise<boolean> {
    if (!adId) return false;
    try {
      return await store.setAdVideo(ownerId, adId, video);
    } catch (e) {
      log('video_slot_failed', { packId, code: e instanceof StoreError ? e.code : 'error' });
      return false;
    }
  }

  /** Enqueue a stored version's render. A failure is a code and a 'failed' slot, never a lost pack. Never throws. */
  async function queueVideo(ownerId: string, packId: string, version: number, voiceKey: VoiceKey, adId: string | null): Promise<{ ok: true } | { ok: false; code: string }> {
    let res: EnqueueResult;
    try {
      res = await deps.renders.enqueue({ packId, version, voiceKey });
      // A row for this version already exists (not expected: a version is stored once): start it again with this voice.
      if (res.ok && !res.inserted) await deps.renders.requeue({ packId, version, voiceKey });
    } catch {
      res = { ok: false, code: 'store_failed' };
    }
    if (!res.ok) {
      log('enqueue_failed', { packId, code: res.code });
      await setSlot(ownerId, adId, packId, { status: 'failed', code: res.code });
      return { ok: false, code: res.code };
    }
    return { ok: true };
  }

  async function generatePack(req: GenerateRequest): Promise<GenerateResult> {
    if (!validate(req)) return fail('invalid_input');
    const { ownerId, by, input } = req;
    const dry = req.dry === true;
    const now = deps.now();
    let held: PackRow | null = null;
    let version = 1;
    let regenerate = false;

    try {
      const pack = await store.getPack(ownerId);
      const settings = await store.readSettings();
      // The market snapshot is cached and costs nothing to read (no paid lookup runs here), so it is resolved first: the brand hash uses the area the pack will STORE (after
      // a fall-back from a district to its postcode area), so asking for the same district again is not a "brand change".
      const source = await deps.areaFigureSource({ areaKey: input.areaKey, minSamples: settings.minAreaSamples });
      const hash = brandHash({ ...input.brand, photos: input.photos, areaKey: 'error' in source ? input.areaKey : source.areaKey });
      regenerate = pack !== null && pack.generatedAt !== null;
      version = regenerate && pack ? pack.version + 1 : 1;
      // The voice: chosen on the first pack; a regenerate keeps the stored one (changeVoice is the only way to change it).
      const voiceKey: VoiceKey = pack && pack.generatedAt !== null && isVoiceKey(pack.voiceKey) ? pack.voiceKey : (input.voiceKey ?? DEFAULT_VOICE_KEY);
      const figure: Figure | null =
        'error' in source ? null : buildFigure({ area_label: source.areaLabel, agg: source.agg, feePct: input.brand.feePct ?? null, netIncludesFee: NET_INCLUDES_MANAGEMENT_FEE, minSamples: settings.minAreaSamples });
      // Worst case, before any paid call: the images (free), the voiceover and the render sandbox at its time limit.
      const estimate = pricing.estimate(ANGLES) + (await videoEstimateFor(settings, voiceLinesFor(input, 'error' in source ? null : source, figure), voiceKey));

      // 1-4: the rules and the cost guard, before any paid call.
      let block: Refusal | null = null;
      if (pack && pack.status === 'generating' && Date.parse(pack.updatedAt) > now.getTime() - STALE_GENERATING_MS) block = refusal('in_progress');
      if (!block && by === 'operator' && regenerate) {
        const rule = regenerateBlock(pack, hash, settings);
        if (rule) block = refusal(rule);
      }
      if (!block && estimate > settings.maxRawPence) block = refusal('cost_cap');
      const spent = await store.monthSpendPence(monthStartIso(now));
      if (!block) {
        if (spent === null) block = refusal('spend_unknown');
        else if (!fitsCap(spent, estimate, settings.monthlyCapPence)) block = refusal('monthly_cap');
      }
      if (block && !dry) {
        log('generate_refused', { packId: pack?.id, code: block.code });
        return fail(block.code, pack?.id);
      }

      // 5: too little market data stops cleanly with nothing written.
      if ('error' in source) {
        if (dry) return { ok: true, dry: true, wouldBlock: block ?? refusal('not_enough_data'), plan: null };
        log('generate_refused', { packId: pack?.id, code: 'not_enough_data' });
        return fail('not_enough_data', pack?.id);
      }

      // A dry run: the whole plan, nothing written, nothing rendered, nothing uploaded.
      if (dry) {
        const operator = pack?.operatorCode ?? allocateOperatorCode(ownerId, await store.takenOperatorCodes());
        const planned = planAds({ input, source, figure, operator, version });
        const files = new Map<Angle, { name: string; width: number; height: number }[]>();
        for (const p of planned) files.set(p.angle, plannedImageNames(p.angle, p.cards.length));
        const checks = runChecks(checkInputOf({ input, source, figure, operator, planned, files }));
        const prefix = `${ownerId}/${pack?.id ?? '<pack>'}/v${version}`;
        return {
          ok: true,
          dry: true,
          wouldBlock: block,
          plan: {
            version,
            regenerate,
            operatorCode: operator,
            brandHash: hash,
            areaKey: source.areaKey,
            areaLabel: source.areaLabel,
            bedrooms: source.bedrooms,
            fellBack: source.fellBack,
            figure,
            voiceKey,
            estimatedCostPence: estimate,
            monthSpendPence: spent,
            ads: planned.map((p) => ({
              angle: p.angle,
              code: p.code,
              adName: p.adName,
              link: p.link,
              texts: p.texts,
              files: (files.get(p.angle) ?? []).map((f) => ({ ...f, path: `${prefix}/${f.name}` })),
              video: p.video,
            })),
            checks,
          },
        };
      }

      // 6: take the pack, then make everything.
      if (!pack) {
        held = await createPack(ownerId, input.websiteId ?? null);
      } else {
        held = await store.beginGenerating(ownerId, pack.id, new Date(now.getTime() - STALE_GENERATING_MS).toISOString());
        if (!held) return fail('in_progress', pack.id);
      }
      const taken = held;
      const operator = taken.operatorCode;
      const planned = planAds({ input, source, figure, operator, version });

      const imagesByAngle = new Map<Angle, AdFileRef[]>();
      const checkFiles = new Map<Angle, { name: string; width: number; height: number }[]>();
      let imageCount = 0;
      for (const p of planned) {
        const refs: AdFileRef[] = [];
        if (p.cards.length > 0) {
          let rendered: RenderedImage[];
          try {
            rendered = await deps.renderImages({
              angle: p.angle,
              cards: p.cards,
              brand: { company: input.brand.company.trim(), brandColour: input.brand.brandColour ?? null, logoUrl: input.brand.logoUrl ?? null },
              photos: { pack: [...input.photos], site: input.brand.photoUrl ?? null },
            });
          } catch {
            throw new GenError('render_failed');
          }
          for (const img of rendered) {
            const path = `${ownerId}/${taken.id}/v${version}/${img.name}`;
            let up: { ok: boolean };
            try {
              up = await deps.upload(path, img.png, 'image/png');
            } catch {
              throw new GenError('upload_failed');
            }
            if (!up.ok) throw new GenError('upload_failed');
            refs.push({ name: img.name, path, width: img.width, height: img.height, contentType: 'image/png', bytes: img.png.byteLength });
          }
        }
        imagesByAngle.set(p.angle, refs);
        checkFiles.set(p.angle, refs.map((r) => ({ name: r.name, width: r.width, height: r.height })));
        imageCount += refs.length;
      }

      const checks = runChecks(checkInputOf({ input, source, figure, operator, planned, files: checkFiles }));
      const status: Extract<PackStatus, 'preview' | 'checks_failed'> = checks.ok ? 'preview' : 'checks_failed';
      const cost = pricing.actual(ANGLES);

      const newAds: NewAd[] = planned.map((p) => ({
        packId: taken.id,
        ownerId,
        version,
        angle: p.angle,
        n: p.n,
        code: p.code,
        adName: p.adName,
        link: p.link,
        texts: p.texts,
        leadForm: p.leadForm,
        // The 5b slot is 'queued' once the pack is good enough to render ('preview'), else 'coming' (no video is made for a failed pack).
        files: { images: imagesByAngle.get(p.angle) ?? [], video: p.video === 'coming' ? (status === 'preview' ? { status: 'queued' } : { status: 'coming' }) : null } satisfies AdFiles,
      }));
      await store.clearAdsOfVersion(ownerId, taken.id, version);
      const stored = await store.insertAds(ownerId, newAds);

      const nowIso = now.toISOString();
      const regenCount = taken.regenCount + (by === 'operator' && regenerate && status === 'preview' ? 1 : 0);
      const updated = await store.updatePack(
        ownerId,
        taken.id,
        {
          status,
          version,
          brandHash: hash,
          areaKey: source.areaKey,
          areaLabel: source.areaLabel,
          bedrooms: source.bedrooms,
          figures: figure ? [figureEntry(figure, source)] : [],
          photos: [...input.photos],
          checks,
          errorCode: null,
          costPence: taken.costPence + cost,
          generatedAt: nowIso,
          // Keep the FIRST approval time: the ads already running on Meta keep their old codes, and those codes must
          // keep linking leads while a new version waits to be approved.
          approvedAt: taken.approvedAt,
          regenCount,
          // voiceChanges is deliberately NOT touched: the allowance is per pack, a regenerate does not give it back.
          voiceKey,
          websiteId: input.websiteId ?? taken.websiteId,
        },
        { from: ['generating'] },
      );
      if (!updated) throw new GenError('store_failed');

      if (status === 'preview' && regenerate) {
        try {
          await store.supersedeAds(ownerId, taken.id, version, nowIso);
        } catch (e) {
          log('supersede_failed', { packId: taken.id, code: e instanceof StoreError ? e.code : 'error' });
        }
      }

      const result: RunResult = {
        outcome: status,
        version,
        regenerate,
        areaKey: source.areaKey,
        adCodes: planned.map((p) => p.code),
        imageCount,
        checkFailures: checks.failures.length,
        checkWarnings: checks.warnings.length,
      };
      try {
        await store.insertRun(ownerId, { packId: taken.id, version, by, costPence: cost, result });
      } catch (e) {
        log('run_row_failed', { packId: taken.id, code: e instanceof StoreError ? e.code : 'error' });
      }
      log('generated', { packId: taken.id, code: status });

      // 7: the video. Only a pack that passed its checks is rendered (no paid call for a pack nobody will see).
      let video: GenerateOk['video'] = { status: 'coming' };
      if (status === 'preview') {
        const q = await queueVideo(ownerId, taken.id, version, voiceKey, stored.find((a) => a.angle === '5b')?.id ?? null);
        video = q.ok ? { status: 'queued' } : { status: 'failed', code: q.code };
      }

      return {
        ok: true,
        dry: false,
        status,
        packId: taken.id,
        version,
        operatorCode: operator,
        regenerate,
        ads: stored.map((s) => ({ id: s.id, angle: s.angle, code: s.code, adName: s.adName, link: s.link })),
        checks,
        costPence: cost,
        regenCount,
        voiceKey,
        video,
      };
    } catch (e) {
      const code: GenerateCode = e instanceof GenError ? e.code : e instanceof StoreError || e instanceof PackConflict ? 'store_failed' : 'generate_failed';
      const h = held as PackRow | null;
      if (h) {
        try {
          await store.updatePack(ownerId, h.id, { status: 'failed', errorCode: code }, { from: ['generating'] });
        } catch {
          /* the pack stays 'generating' and goes stale; nothing more to do */
        }
        try {
          await store.insertRun(ownerId, {
            packId: h.id,
            version,
            by,
            costPence: 0,
            result: { outcome: 'failed', errorCode: code, version, regenerate, areaKey: null, adCodes: [], imageCount: 0, checkFailures: 0, checkWarnings: 0 },
          });
        } catch {
          /* the failure is already on the pack */
        }
      }
      log('generate_failed', { packId: h?.id, code });
      return fail(code, h?.id);
    }
  }

  async function approvePack(req: { ownerId: string; expectedVersion?: number }): Promise<ApproveResult> {
    const no = (code: ApproveCode, message: string): ApproveResult => ({ ok: false, code, message });
    if (!req || typeof req.ownerId !== 'string' || !UUID_RE.test(req.ownerId)) return no('invalid_input', GENERATE_MESSAGES.invalid_input);
    try {
      const pack = await store.getPack(req.ownerId);
      if (!pack) return no('no_pack', 'There is no pack to approve yet.');
      if (pack.status !== 'preview') return no('not_preview', 'Only a pack that is ready to look at can be approved.');
      // The version the operator was looking at: a regenerate in the meantime (an admin's, say) must not be approved unseen.
      if (req.expectedVersion !== undefined && req.expectedVersion !== pack.version) return no('not_preview', 'Your ads changed while you were looking. Please look at them again, then approve.');
      // 38b: all three ads or none. The 5b video must be ready and every check (the video's included) must pass.
      const ads = await store.listAds(req.ownerId, pack.id);
      const slot = ads.find((a) => a.angle === '5b' && a.version === pack.version)?.files.video ?? null;
      const block = approvalBlock(pack, slot, await deps.renders.get(pack.id, pack.version));
      if (block) return no(block.code, block.message);
      const updated = await store.updatePack(req.ownerId, pack.id, { status: 'approved', approvedAt: pack.approvedAt ?? deps.now().toISOString() }, { from: ['preview'] });
      if (!updated) return no('not_preview', 'Only a pack that is ready to look at can be approved.');
      log('approved', { packId: pack.id, code: 'approved' });
      return { ok: true, activityKind: 'ad_pack_approved', packId: pack.id, version: updated.version, operatorCode: updated.operatorCode };
    } catch (e) {
      log('approve_failed', { code: e instanceof StoreError ? e.code : 'error' });
      return no('store_failed', TRY_AGAIN);
    }
  }

  async function listPackForOwner(ownerId: string): Promise<PackView | null> {
    if (typeof ownerId !== 'string' || ownerId === '') return null;
    const pack = await store.getPack(ownerId);
    if (!pack) return null;
    const [all, settings, renderRow] = await Promise.all([store.listAds(ownerId, pack.id), store.readSettings(), deps.renders.get(pack.id, pack.version)]);
    const ads = all.filter((a) => a.version === pack.version);
    const showAds = pack.status === 'preview' || pack.status === 'approved' || (pack.status === 'failed' && pack.generatedAt !== null && pack.checks?.ok === true);
    const slot = ads.find((a) => a.angle === '5b')?.files.video ?? null;
    const state = voiceChangeState(pack, renderRow, settings);
    return {
      pack,
      ads,
      showAds,
      olderCodes: all.filter((a) => a.version !== pack.version).map((a) => a.code),
      freeRegensLeft: Math.max(0, settings.freeRegens - pack.regenCount),
      render: renderViewOf(renderRow),
      video: videoViewOf(slot, renderRow, pack.status),
      voice: {
        key: isVoiceKey(pack.voiceKey) ? pack.voiceKey : null,
        changesLeft: state.changesLeft,
        canChange: state.blocked === null,
        free: state.free,
        blocked: state.blocked,
      },
      approval: ((b) => (b ? { ok: false as const, ...b } : { ok: true as const }))(approvalBlock(pack, slot, renderRow)),
    };
  }

  /**
   * Another voice for the SAME version, before approving. The codes do not change, no version is made. Rules (the
   * first that fails refuses, nothing is written): owner's pack; 'preview' only (an approved pack says
   * after_approval); a different voice; no render running; the allowance (ad_pack_voice_changes) not used up, UNLESS
   * the render ended voice_unavailable (the voice was never heard: the change is free and does not count); and the
   * same cost caps as generatePack, priced for one more voiceover plus sandbox, BEFORE anything is paid.
   *
   * Effect, in an order that leaves a consistent state on a failure: (1) ad_packs.voice_key = new and
   * voice_changes + 1 (not for a free change), guarded on 'preview'; (2) the version's cached voice.mp3 and
   * script.json are deleted from the bucket; (3) the render row is reset in place (queued, attempts 0, error and
   * files cleared, voice_key = new; refused while running); (4) the 5b slot becomes {status:'queued'}. A failure at
   * (2) or (3) puts (1) back, so the old voice and the allowance are as they were.
   */
  async function changeVoice(req: { ownerId: string; voiceKey: string; expectedVersion?: number }): Promise<ChangeVoiceResult> {
    const no = (code: VideoActionCode, message: string): ChangeVoiceResult => ({ ok: false, code, message });
    if (!req || typeof req.ownerId !== 'string' || !UUID_RE.test(req.ownerId) || !isVoiceKey(req.voiceKey)) return no('invalid_input', GENERATE_MESSAGES.invalid_input);
    const voiceKey = req.voiceKey;
    let reverted: PackRow | null = null;
    try {
      const pack = await store.getPack(req.ownerId);
      if (!pack) return no('no_pack', 'There is no pack yet.');
      if (req.expectedVersion !== undefined && req.expectedVersion !== pack.version) return no('not_preview', VIDEO_MESSAGES.stale);
      const [ads, settings, render] = await Promise.all([store.listAds(req.ownerId, pack.id), store.readSettings(), deps.renders.get(pack.id, pack.version)]);
      const state = voiceChangeState(pack, render, settings, voiceKey);
      if (state.blocked) return no(state.blocked.code, state.blocked.message);

      const ad = ads.find((a) => a.angle === '5b' && a.version === pack.version) ?? null;
      const lines = cleanLines(String(ad?.texts.script ?? '').split(/\n\s*\n/));
      const cap = await capRefusal(settings, await videoEstimateFor(settings, lines.length > 0 ? lines : ['x'.repeat(Math.min(MAX_VOICE_CHARACTERS, 600))], voiceKey));
      if (cap) {
        log('voice_change_refused', { packId: pack.id, code: cap });
        return no(cap, GENERATE_MESSAGES[cap]);
      }

      const patched = await store.updatePack(req.ownerId, pack.id, { voiceKey, voiceChanges: state.free ? pack.voiceChanges : pack.voiceChanges + 1 }, { from: ['preview'] });
      if (!patched) return no('not_preview', NOT_PREVIEW_MESSAGE);
      reverted = pack;

      const gone = await deps.deleteFiles(voiceFilePaths(req.ownerId, pack.id, pack.version));
      if (!gone.ok) throw new StoreError('voice_files');
      const row = await deps.renders.requeue({ packId: pack.id, version: pack.version, voiceKey });
      if (!row) {
        await revertVoice(req.ownerId, reverted);
        return no('video_running', VIDEO_MESSAGES.video_running);
      }
      reverted = null;
      await setSlot(req.ownerId, ad?.id ?? null, pack.id, { status: 'queued' });
      log('voice_changed', { packId: pack.id, code: state.free ? 'free' : 'counted' });
      return { ok: true, packId: pack.id, version: pack.version, voiceKey, free: state.free, changesLeft: Math.max(0, settings.voiceChanges - patched.voiceChanges) };
    } catch (e) {
      if (reverted) await revertVoice(req.ownerId, reverted);
      log('voice_change_failed', { code: e instanceof StoreError ? e.code : 'error' });
      return no('store_failed', TRY_AGAIN);
    }
  }

  async function revertVoice(ownerId: string, before: PackRow): Promise<void> {
    try {
      await store.updatePack(ownerId, before.id, { voiceKey: before.voiceKey, voiceChanges: before.voiceChanges }, { from: ['preview'] });
    } catch {
      log('voice_revert_failed', { packId: before.id, code: 'store_failed' });
    }
  }

  /**
   * Try a failed video render again: the SAME version and voice, no new version, no voice change counted. Only for
   * the owner's pack in 'preview' or 'checks_failed', only when the render failed with a retryable code (not
   * voice_unavailable, which is changeVoice's job, and not bad_brief), or when it could not be queued at all
   * (slot failed, no render row). Same cost caps as generatePack, BEFORE anything is paid. Attempts start again at 0.
   */
  async function retryVideo(req: { ownerId: string; expectedVersion?: number }): Promise<RetryVideoResult> {
    const no = (code: VideoActionCode, message: string): RetryVideoResult => ({ ok: false, code, message });
    if (!req || typeof req.ownerId !== 'string' || !UUID_RE.test(req.ownerId)) return no('invalid_input', GENERATE_MESSAGES.invalid_input);
    try {
      const pack = await store.getPack(req.ownerId);
      if (!pack) return no('no_pack', 'There is no pack yet.');
      if (req.expectedVersion !== undefined && req.expectedVersion !== pack.version) return no('not_preview', VIDEO_MESSAGES.stale);
      const [ads, settings, render] = await Promise.all([store.listAds(req.ownerId, pack.id), store.readSettings(), deps.renders.get(pack.id, pack.version)]);
      const ad = ads.find((a) => a.angle === '5b' && a.version === pack.version) ?? null;
      if (pack.status === 'approved') return no('after_approval', VIDEO_MESSAGES.not_retryable);
      if (render && render.state === 'running') return no('video_running', VIDEO_MESSAGES.video_running);
      if (!videoViewOf(ad?.files.video ?? null, render, pack.status).canRetry) return no('not_retryable', VIDEO_MESSAGES.not_retryable);

      const voiceKey: VoiceKey = isVoiceKey(render?.voiceKey) ? render.voiceKey : isVoiceKey(pack.voiceKey) ? pack.voiceKey : DEFAULT_VOICE_KEY;
      const lines = cleanLines(String(ad?.texts.script ?? '').split(/\n\s*\n/));
      const cap = await capRefusal(settings, await videoEstimateFor(settings, lines.length > 0 ? lines : ['x'.repeat(Math.min(MAX_VOICE_CHARACTERS, 600))], voiceKey));
      if (cap) {
        log('video_retry_refused', { packId: pack.id, code: cap });
        return no(cap, GENERATE_MESSAGES[cap]);
      }
      const row = await deps.renders.requeue({ packId: pack.id, version: pack.version, voiceKey });
      if (!row) return no('video_running', VIDEO_MESSAGES.video_running);
      await setSlot(req.ownerId, ad?.id ?? null, pack.id, { status: 'queued' });
      log('video_retried', { packId: pack.id, code: 'queued' });
      return { ok: true, packId: pack.id, version: pack.version, voiceKey };
    } catch (e) {
      log('video_retry_failed', { code: e instanceof StoreError ? e.code : 'error' });
      return no('store_failed', TRY_AGAIN);
    }
  }

  return { generatePack, approvePack, changeVoice, retryVideo, listPackForOwner };
}

export type AdPackEngine = ReturnType<typeof createAdPackEngine>;
