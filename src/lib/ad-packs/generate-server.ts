import 'server-only';

import { createAdPackEngine, type AdPackEngine, type ApproveResult, type GenerateDeps, type GenerateRequest, type GenerateResult, type PackView } from './generate-core.ts';
import { areaFigureSource } from './area-server.ts';
import { renderAdImages } from './images';
import { createLiveStore, uploadFile } from './store-server.ts';
import { adPackFetchImage } from './files-server.ts';

export type {
  ApproveResult,
  DryPlan,
  GenerateCode,
  GenerateInput,
  GenerateRequest,
  GenerateResult,
  PackView,
  PlanAd,
} from './generate-core.ts';
export { brandHash, estimateRawPence, generateMessage, GENERATE_CODES, MAX_PHOTOS, regenerateBlock } from './generate-core.ts';

/**
 * Batch 36: the real wiring of the pack generator (generate-core.ts).
 *
 *   generatePack({ownerId, by, dry, input})   see generate-core.ts for the order and the codes
 *   approvePack({ownerId})                    preview -> approved; the Phase 8 action logs `activityKind`
 *   listPackForOwner(ownerId)                 the operator screen's read model
 *
 * Needs the font files at runtime: any route or action that calls generatePack
 * needs its own outputFileTracingIncludes entry in next.config.ts (/leads/ads
 * has one; /admin/ad-packs needs one).
 *
 * Logs carry a pack id and a code, never an address, a text or a body.
 */

function realDeps(): GenerateDeps {
  return {
    store: createLiveStore(),
    now: () => new Date(),
    areaFigureSource,
    // Phase 8: an operator's own photos are stored references (<owner>/uploads/<uuid>.jpg), read from the private bucket.
    renderImages: (a) => renderAdImages({ angle: a.angle, cards: a.cards, brand: a.brand, photos: a.photos, fetchImage: adPackFetchImage }),
    upload: uploadFile,
    log: (event, fields) => console.error(`[ad-packs] ${event}`, fields.packId ?? '-', fields.code ?? '-'),
  };
}

let engine: AdPackEngine | null = null;
function live(): AdPackEngine {
  if (!engine) engine = createAdPackEngine(realDeps());
  return engine;
}

export function generatePack(req: GenerateRequest): Promise<GenerateResult> {
  return live().generatePack(req);
}

export function approvePack(req: { ownerId: string }): Promise<ApproveResult> {
  return live().approvePack(req);
}

export function listPackForOwner(ownerId: string): Promise<PackView | null> {
  return live().listPackForOwner(ownerId);
}
