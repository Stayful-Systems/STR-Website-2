import 'server-only';

import { createAdPackEngine, type AdPackEngine, type ApproveResult, type ChangeVoiceResult, type GenerateDeps, type GenerateRequest, type GenerateResult, type PackView, type RetryVideoResult } from './generate-core.ts';
import { enqueueRender } from './render-core.ts';
import { createLiveRenderStore, readSandboxCpuSecondPence } from './render-store-server.ts';
import { areaFigureSource } from './area-server.ts';
import { renderAdImages } from './images';
import { createLiveStore, deleteFiles, uploadFile } from './store-server.ts';
import { adPackFetchImage } from './files-server.ts';
import { markPackNoticePending } from '../leaddb/ad-account-server';

export type {
  ApproveCode,
  ApproveResult,
  ApprovalView,
  ChangeVoiceResult,
  DryPlan,
  RenderView,
  RetryVideoResult,
  VideoActionCode,
  VideoView,
  VoiceView,
  GenerateCode,
  GenerateInput,
  GenerateRequest,
  GenerateResult,
  PackView,
  PlanAd,
} from './generate-core.ts';
export { brandHash, estimateRawPence, estimateVideoPence, generateMessage, GENERATE_CODES, MAX_PHOTOS, regenerateBlock, VIDEO_ACTION_CODES, VIDEO_APPROVE_CODES, VIDEO_MESSAGES, videoFailedMessage } from './generate-core.ts';

/**
 * Batch 38: the real wiring of the pack generator (generate-core.ts).
 *
 *   generatePack({ownerId, by, dry, input})   see generate-core.ts for the order and the codes
 *   approvePack({ownerId, expectedVersion?})  preview -> approved (only with the 5b video ready); the Phase 8 action logs `activityKind`
 *   changeVoice({ownerId, voiceKey, expectedVersion?})   another voice for the same version, before approving (38b)
 *   retryVideo({ownerId, expectedVersion?})   try a failed video render again, same version (38b)
 *   listPackForOwner(ownerId)                 the operator screen's read model (PackView, with the video, voice and approval state)
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
    // 38b: the video is queued for the cron worker (/api/internal/ad-pack-renders). Imported from the store, not from
    // render-server.ts, so the sandbox SDK stays out of the screens' bundle.
    renders: (() => {
      const renders = createLiveRenderStore();
      return {
        enqueue: (i) => enqueueRender(renders, i),
        get: (packId, version) => renders.getRender(packId, version),
        requeue: (i) => renders.requeueRender(i),
      };
    })(),
    deleteFiles: (paths) => deleteFiles(paths),
    sandboxCpuSecondPence: readSandboxCpuSecondPence,
    log: (event, fields) => console.error(`[ad-packs] ${event}`, fields.packId ?? '-', fields.code ?? '-'),
    // Batch 55 step 2: the lead database is told once that this customer made ads (sent by /api/internal/leaddb-deliveries).
    onLeadDbPackGenerated: (ownerId) => markPackNoticePending(ownerId),
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

export function approvePack(req: { ownerId: string; expectedVersion?: number }): Promise<ApproveResult> {
  return live().approvePack(req);
}

export function changeVoice(req: { ownerId: string; voiceKey: string; expectedVersion?: number }): Promise<ChangeVoiceResult> {
  return live().changeVoice(req);
}

export function retryVideo(req: { ownerId: string; expectedVersion?: number }): Promise<RetryVideoResult> {
  return live().retryVideo(req);
}

export function listPackForOwner(ownerId: string): Promise<PackView | null> {
  return live().listPackForOwner(ownerId);
}
