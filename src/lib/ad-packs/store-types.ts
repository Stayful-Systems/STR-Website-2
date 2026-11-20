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
import type { LeadFormQuestion } from './angles.ts';
import type { ChecksOutput } from './checks.ts';
import type { AdPackSettings } from './settings.ts';

export const PACK_STATUSES = ['draft', 'generating', 'checks_failed', 'preview', 'approved', 'failed'] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];

export type PackRow = {
  id: string;
  ownerId: string;
  websiteId: string | null;
  status: PackStatus;
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

/** What updatePack may change (never the id, owner, operator code or timestamps the store keeps). */
export type PackPatch = Partial<Omit<PackRow, 'id' | 'ownerId' | 'operatorCode' | 'createdAt' | 'updatedAt'>>;

export type NewPack = { ownerId: string; websiteId: string | null; operatorCode: string; status: PackStatus };

export type AdFileRef = { name: string; path: string; width: number; height: number; contentType: string; bytes: number };
/** `video` is {status:'coming'} for the 5b ad in 38a (38b fills it); null for the image ads. */
export type AdFiles = { images: AdFileRef[]; video: { status: 'coming' } | null };

/** Everything an operator copies. `script` is the 5b voiceover; `cardsText` is one string per image card. */
export type AdTexts = { primary: string[]; headlines: string[]; descriptions: string[]; script?: string; cardsText?: string[] };

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
  /** Mark every ad of an older version superseded (their codes stay valid). */
  supersedeAds(ownerId: string, packId: string, belowVersion: number, atIso: string): Promise<number>;
  /** Record one non-dry run. Refused (null) when the pack is not the owner's. */
  insertRun(ownerId: string, run: NewRun): Promise<RunRow | null>;
  /** The pack's runs, newest first. */
  listRuns(ownerId: string, packId: string, limit?: number): Promise<RunRow[]>;
  /** Raw cost of every non-dry run since the instant, all owners together; null when it cannot be read. */
  monthSpendPence(sinceIso: string): Promise<number | null>;
  readSettings(): Promise<AdPackSettings>;
}
