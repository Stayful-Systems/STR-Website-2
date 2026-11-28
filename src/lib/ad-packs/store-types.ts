/**
 * Batch 38: the ad pack's rows and the store interface the generator runs on.
 * The real store (store-server.ts) is over Supabase; test-store.ts is an
 * in-memory copy for the tests.
 *
 * Column mapping (supabase/schema.sql, "Batch 38: Ads A1"):
 *   ad_packs      -> PackRow       one per owner; version = n in the codes
 *   ad_pack_ads   -> PackAdRow     one per ad per version; code is unique
 *   ad_pack_runs  -> RunRow        one per generation attempt (no owner column:
 *                                  reached through its pack)
 *
 * EVERY owner-scoped method takes the owner id and filters by it, so one
 * owner's rows are never read or written under another's id. The two
 * exceptions return only what the allocation and the cap need, nothing about
 * anyone's pack: takenOperatorCodes (the set of codes in use) and
 * monthSpendPence (one sum of cost across all packs).
 *
 * Pure: no network, no database, no server-only.
 */
import type { Angle } from './codes.ts';
import type { AdFormat } from './concepts.ts';
import type { LeadFormQuestion } from './angles.ts';
import type { ChecksOutput } from './checks.ts';
import type { AdPackSettings } from './settings.ts';
import type { AdVideo } from './render-store.ts';
import type { AdRoute } from './eligibility.ts';

export const PACK_STATUSES = ['draft', 'generating', 'checks_failed', 'preview', 'approved', 'failed'] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];

export type PackRow = {
  id: string;
  ownerId: string;
  websiteId: string | null;
  status: PackStatus;
  /** Batch 55: ad_packs.route. 'academy' (Batch 38, the default) or 'leaddb' (the calculator site). Never changes after the pack is made. */
  route: AdRoute;
  operatorCode: string;
  /** The version the codes carry. Moves up only when a new version is stored. */
  version: number;
  voiceKey: string | null;
  voiceChanges: number;
  /** Free regenerations used (operator regenerates that produced a pack to look at). */
  regenCount: number;
  /** brandHash() of the last generated version. */
  brandHash: string | null;
  areaKey: string | null;
  areaLabel: string | null;
  bedrooms: number | null;
  /** The example figure(s) the last version rests on (one entry, or none). */
  figures: unknown[] | null;
  /** The operator's own photo URLs the last version used. */
  photos: string[] | null;
  checks: ChecksOutput | null;
  errorCode: string | null;
  /** Raw spend over every non-dry run, in pence. */
  costPence: number;
  generatedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** What updatePack may change (never the id, owner, operator code, route or timestamps the store keeps). */
export type PackPatch = Partial<Omit<PackRow, 'id' | 'ownerId' | 'operatorCode' | 'route' | 'createdAt' | 'updatedAt'>>;

export type NewPack = { ownerId: string; websiteId: string | null; operatorCode: string; status: PackStatus; /** Absent is 'academy'. */ route?: AdRoute };

export type AdFileRef = { name: string; path: string; width: number; height: number; contentType: string; bytes: number };
/** `video` is the 5b ad's video slot (queued, making, ready, failed, or coming for a pack from before 38b); null for the image ads. */
export type AdFiles = { images: AdFileRef[]; video: AdVideo | null };

/**
 * Batch 38b: everything the notice video needs, pinned on the 5b ad when its version is made (ad_pack_ads.texts.brand,
 * written once, never rewritten). The render worker reads ONLY this, never the live website settings, so a retry or a
 * voice change after a brand edit still makes the video the script and the images were written for. Nothing here is
 * personal data beyond what the pack already stores (the company name, the operator's own photo and logo references,
 * the area label, the figure the script quotes).
 */
export type VideoBrand = {
  company: string;
  colour: string | null;
  /** The logo's address (https) or a stored upload reference; null for a name in type only. */
  logoRef: string | null;
  /** The website's own photo: used when the pack has no photo of its own. */
  sitePhotoRef: string | null;
  /** The operator's own photos (bucket paths or addresses), at most 4, in order. */
  photos: string[];
  areaLabel: string;
  bedrooms: number | null;
  /** The operator's own fee line ("Our management fee is 12%.") or null when they set no fee. */
  feeSentence: string | null;
  /** The figure the script quotes (generate-core's figureEntry), or null. */
  figure: Record<string, unknown> | null;
};

/** Everything an operator copies. `script` is the 5b voiceover; `cardsText` is one string per image card; `brand` is the video's pinned look (never shown or copied). */
export type AdTexts = { primary: string[]; headlines: string[]; descriptions: string[]; script?: string; cardsText?: string[]; brand?: VideoBrand };

export type PackAdRow = {
  id: string;
  packId: string;
  ownerId: string;
  version: number;
  angle: Angle;
  n: number;
  code: string;
  adName: string;
  link: string;
  texts: AdTexts;
  leadForm: LeadFormQuestion[];
  files: AdFiles;
  /**
   * Batch 55 step 5 (55c A6): the ad's concept and format (concepts.ts), set on the lead database route only. Absent
   * (or null) on the Academy route, whose rows are written exactly as before.
   */
  conceptId?: string | null;
  format?: AdFormat | null;
  supersededAt: string | null;
  createdAt: string;
};

export type NewAd = Omit<PackAdRow, 'id' | 'createdAt' | 'supersededAt'>;

export type RunBy = 'operator' | 'admin';

/** What one run row says. Codes and counts only: never a text, an address or an error message. */
export type RunResult = {
  outcome: 'preview' | 'checks_failed' | 'failed';
  errorCode?: string;
  version: number;
  regenerate: boolean;
  areaKey: string | null;
  adCodes: string[];
  imageCount: number;
  checkFailures: number;
  checkWarnings: number;
};

export type NewRun = { packId: string; version: number; by: RunBy; costPence: number; result: RunResult };

export type RunRow = { id: string; packId: string; version: number; by: RunBy; dry: boolean; costPence: number; result: RunResult | null; createdAt: string };

/** Batch 55 (A8): an admin's grant of one more creative round to an owner (ad_pack_round_grants). The reason text is never read back into the app. */
export type RoundGrantRow = { id: string; ownerId: string; createdAt: string; usedAt: string | null };

/** A unique column was hit. `which` says which one. */
export class PackConflict extends Error {
  readonly which: 'owner' | 'operator_code' | 'code';
  constructor(which: 'owner' | 'operator_code' | 'code') {
    super(`conflict:${which}`);
    this.name = 'PackConflict';
    this.which = which;
  }
}

/** A read or write failed. `code` is the database's error code, never a body or an address. */
export class StoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`store:${code}`);
    this.name = 'StoreError';
    this.code = code;
  }
}

export interface AdPackStore {
  /** The owner's one pack, or null. Throws StoreError when the read fails (null must mean "none"). */
  getPack(ownerId: string): Promise<PackRow | null>;
  /** Every ad of one pack (all versions, newest version first, then angle order). */
  listAds(ownerId: string, packId: string): Promise<PackAdRow[]>;
  /** One pack ad, only if it belongs to this owner. */
  getPackAd(ownerId: string, packAdId: string): Promise<PackAdRow | null>;
  /** Operator codes already in use (every owner's; nothing else). */
  takenOperatorCodes(): Promise<Set<string>>;
  /** Insert the owner's pack. Throws PackConflict('owner') or PackConflict('operator_code'). */
  insertPack(row: NewPack): Promise<PackRow>;
  /**
   * Take the pack for a generation: status 'generating', error cleared, but
   * only when it is not generating already or the claim is older than
   * staleBeforeIso. Null when someone else holds it (or the pack is not the owner's).
   */
  beginGenerating(ownerId: string, packId: string, staleBeforeIso: string): Promise<PackRow | null>;
  /** Change the pack (optionally only from the given statuses). Null when no row matched. */
  updatePack(ownerId: string, packId: string, patch: PackPatch, guard?: { from?: readonly PackStatus[] }): Promise<PackRow | null>;
  /** Insert ads in one statement. Throws PackConflict('code') when a code is taken. */
  insertAds(ownerId: string, ads: NewAd[]): Promise<PackAdRow[]>;
  /** Remove the ads of a version that was never committed (left by an attempt that stopped half way). */
  clearAdsOfVersion(ownerId: string, packId: string, version: number): Promise<number>;
  /**
   * Set the video slot of one pack ad, keeping its images (only if the ad is the owner's). False when no row matched.
   * Used by the generator (queued, or failed when the enqueue failed), a voice change and a retry (queued), and the
   * render worker (making, failed).
   */
  setAdVideo(ownerId: string, packAdId: string, video: AdVideo): Promise<boolean>;
  /** Mark every ad of an older version superseded (their codes stay valid). */
  supersedeAds(ownerId: string, packId: string, belowVersion: number, atIso: string): Promise<number>;
  /** Record one non-dry run. Refused (null) when the pack is not the owner's. */
  insertRun(ownerId: string, run: NewRun): Promise<RunRow | null>;
  /** The pack's runs, newest first. */
  listRuns(ownerId: string, packId: string, limit?: number): Promise<RunRow[]>;
  /**
   * Raw cost of every non-dry run since the instant, all owners together; null when it cannot be read.
   * Batch 55: with a route, only the runs of packs on that route (the Academy cap passes 'academy', so lead database
   * runs never use it up; the lead database backstop passes 'leaddb'). Without one, every route.
   */
  monthSpendPence(sinceIso: string, route?: AdRoute): Promise<number | null>;
  /**
   * Batch 55 (A8): the pack's non-dry runs made BY THE OPERATOR since the instant, newest first (the round cap reads
   * these; admin and render runs are left out in the database). Refused ([]) when the pack is not the owner's.
   */
  listOperatorRunsSince(ownerId: string, packId: string, sinceIso: string): Promise<RunRow[]>;
  /** Batch 55 (A8): the owner's round grants that have not been used, oldest first. Throws StoreError when the read fails. */
  listUnusedRoundGrants(ownerId: string): Promise<RoundGrantRow[]>;
  /** Batch 55 (A8): mark one of the owner's grants used, only while it is unused. False when it was already used (or is not theirs). */
  useRoundGrant(ownerId: string, grantId: string, atIso: string): Promise<boolean>;
  readSettings(): Promise<AdPackSettings>;
}
