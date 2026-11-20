/**
 * Batch 36: the pack generator, as a pure engine. Everything outside it is
 * injected (the store, the clock, the image renderer, the file uploader, the
 * area's market data and the price list), so it is tested with the in-memory
 * store and no database, network or server-only. generate-server.ts wires the
 * real ones.
 *
 *   generatePack({ownerId, by, dry, input})   make (or remake) the owner's pack
 *   approvePack({ownerId})                    preview -> approved
 *   listPackForOwner(ownerId)                 the screen's read model
 *
 * ORDER of generatePack (the first refusal stops a real run; a dry run
 * reports it as `wouldBlock` and carries on, writing nothing):
 *   1  in_progress       another generation holds the pack (stale after 10 minutes)
 *   2  regen_used / no_brand_change   operator regenerate only (admin: skipped, and never counted)
 *   3  cost_cap          estimateRawPence over ad_pack_max_raw_pence   (BEFORE any paid call)
 *   4  spend_unknown / monthly_cap    this UK month's non-dry spend plus the estimate over ad_pack_monthly_cap_pence
 *   5  not_enough_data   areaFigureSource found too few reports (nothing is written)
 *   6  the pack is taken ('generating'; the operator code is allocated on the first pack),
 *      images are rendered and uploaded, runChecks runs, ads and the pack are stored,
 *      one ad_pack_runs row is written (cost, by, result summary)
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
 * Never logs an address or a body: log lines carry a pack id and a code.
 *
 * Pure: no network, no database, no server-only.
 */
import { createHash } from 'node:crypto';
import { monthStartIso } from './month.ts';
import { angleDef, renderCards, renderScript, renderTexts, type Card } from './angles.ts';
import { NET_INCLUDES_MANAGEMENT_FEE } from './area.ts';
import { runChecks, type CheckInput, type ChecksOutput } from './checks.ts';
import { ANGLES, operatorCode as allocateOperatorCode, packCode, type Angle } from './codes.ts';
import { buildFigure, type Figure, type FigureAgg } from './figures.ts';
import { adLink, adName } from './links.ts';
import { fitsCap, type AdPackSettings } from './settings.ts';
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

export type GenerateDeps = {
  store: AdPackStore;
  now: () => Date;
  renderImages: ImageRenderer;
  upload: FileUploader;
  areaFigureSource: (a: { areaKey: string; minSamples: number }) => Promise<AreaSourceResult>;
  pricing?: Pricing;
  /** Log a line: an event name, a pack id and a code. Never anything else. */
  log?: (event: string, fields: { packId?: string; code?: string }) => void;
};

// ── Pure helpers ──

/**
 * Worst-case raw cost of generating the angles, in pence. 36a: 0 (the images
 * are made in-process and cost nothing per call). 36b extends this with the
 * voice and the render sandbox.
 */
export function estimateRawPence(angles: readonly Angle[]): number {
  void angles;
  return 0;
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

function validate(req: GenerateRequest): boolean {
  const i = req?.input;
  if (!req || typeof req.ownerId !== 'string' || !UUID_RE.test(req.ownerId)) return false;
  if (req.by !== 'operator' && req.by !== 'admin') return false;
  if (!i || typeof i.areaKey !== 'string' || i.areaKey.trim() === '') return false;
  if (!Array.isArray(i.photos) || i.photos.length > MAX_PHOTOS || i.photos.some((p) => typeof p !== 'string')) return false;
  if (!i.brand || typeof i.brand.company !== 'string') return false;
  if (i.brand.feePct !== null && i.brand.feePct !== undefined && (typeof i.brand.feePct !== 'number' || !Number.isFinite(i.brand.feePct))) return false;
  if (typeof i.domain !== 'string' || !HOST_RE.test(i.domain.trim().toLowerCase())) return false;
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
};
export type GenerateDry = { ok: true; dry: true; wouldBlock: Refusal | null; plan: DryPlan | null };
export type GenerateFail = { ok: false; code: GenerateCode; message: string; packId?: string };
export type GenerateResult = GenerateOk | GenerateDry | GenerateFail;

export type ApproveResult =
  | { ok: true; activityKind: 'ad_pack_approved'; packId: string; version: number; operatorCode: string }
  | { ok: false; code: 'invalid_input' | 'no_pack' | 'not_preview' | 'store_failed'; message: string };

export type PackView = {
  pack: PackRow;
  /** The ads of the pack's current version, 5b then 3a then 17. */
  ads: PackAdRow[];
  /** True when the operator may be shown the ads (preview, approved, or a failed regenerate that kept a good version). */
  showAds: boolean;
  /** Codes of older versions: still valid, never shown as current. */
  olderCodes: string[];
  freeRegensLeft: number;
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
      // The market data is free to read, so it is resolved first: the brand hash uses the area the pack will STORE (after
      // a fall-back from a district to its postcode area), so asking for the same district again is not a "brand change".
      const source = await deps.areaFigureSource({ areaKey: input.areaKey, minSamples: settings.minAreaSamples });
      const hash = brandHash({ ...input.brand, photos: input.photos, areaKey: 'error' in source ? input.areaKey : source.areaKey });
      regenerate = pack !== null && pack.generatedAt !== null;
      version = regenerate && pack ? pack.version + 1 : 1;
      const estimate = pricing.estimate(ANGLES);

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
      const figure = buildFigure({
        area_label: source.areaLabel,
        agg: source.agg,
        feePct: input.brand.feePct ?? null,
        netIncludesFee: NET_INCLUDES_MANAGEMENT_FEE,
        minSamples: settings.minAreaSamples,
      });

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
        files: { images: imagesByAngle.get(p.angle) ?? [], video: p.video === 'coming' ? { status: 'coming' } : null } satisfies AdFiles,
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

  async function approvePack(req: { ownerId: string }): Promise<ApproveResult> {
    const no = (code: 'invalid_input' | 'no_pack' | 'not_preview' | 'store_failed', message: string): ApproveResult => ({ ok: false, code, message });
    if (!req || typeof req.ownerId !== 'string' || !UUID_RE.test(req.ownerId)) return no('invalid_input', GENERATE_MESSAGES.invalid_input);
    try {
      const pack = await store.getPack(req.ownerId);
      if (!pack) return no('no_pack', 'There is no pack to approve yet.');
      if (pack.status !== 'preview') return no('not_preview', 'Only a pack that is ready to look at can be approved.');
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
    const [all, settings] = await Promise.all([store.listAds(ownerId, pack.id), store.readSettings()]);
    const ads = all.filter((a) => a.version === pack.version);
    const showAds = pack.status === 'preview' || pack.status === 'approved' || (pack.status === 'failed' && pack.generatedAt !== null && pack.checks?.ok === true);
    return {
      pack,
      ads,
      showAds,
      olderCodes: all.filter((a) => a.version !== pack.version).map((a) => a.code),
      freeRegensLeft: Math.max(0, settings.freeRegens - pack.regenCount),
    };
  }

  return { generatePack, approvePack, listPackForOwner };
}

export type AdPackEngine = ReturnType<typeof createAdPackEngine>;
