/**
 * Batch 35 phase 4: which pack ad brought one sheet row.
 *
 * Decision, in order: the code found in the ad name, then Meta's ad id (when
 * that id was already seen WITH a code for this owner, in this run or an
 * earlier one), otherwise untagged. A code that is another operator's stays
 * foreign: the row is never imported and never linked.
 *
 * All the matching is A1's `matchLeadToAd`; this only feeds it the sheet's ad
 * name and ad id, re-runs it without the code when the code gave nothing, and
 * teaches the in-run id map. No database, no network: the import engine
 * (phase 5) loads the pack ads and the known ids and passes them in.
 *
 * Never writes `leads`; never logs a lead.
 */
import { matchLeadToAd } from '../ad-packs/attribution.ts';
import type { AttributionMatch, LinkRow, MatchResult, PackAdRef } from '../ad-packs/attribution.ts';
import { findCodeInText } from './rows.ts';
import type { Candidate } from './rows.ts';

export type AttributeContext = {
  ownerId: string;
  /** The owner's operator code, when known; a code with another operator's is foreign. */
  operatorCode: string | null;
  /**
   * The owner's pack ads (every version), plus the ad (any owner) that carries
   * a code the run will meet, so a code that is another owner's reads as foreign.
   */
  packAds: PackAdRef[];
  /**
   * Meta ad id -> pack ad id, seen with a code for THIS owner. Starts from
   * ad_pack_lead_links; this function adds to it as a run goes on.
   */
  knownMetaAdIds: Map<string, string>;
};

export type RowAttribution = {
  /** code | ad_id | none | foreign_code (the ad_pack_lead_links.match value). */
  match: AttributionMatch;
  packAdId: string | null;
  adCodeSeen: string | null;
  metaAdIdSeen: string | null;
  /** True when the code was another operator's: the row's state is foreign. */
  foreign: boolean;
  /** The row to upsert on ad_pack_lead_links once the lead id is known. */
  link(leadId: string): LinkRow;
};

export function attributeRow(
  ctx: AttributeContext,
  cand: Pick<Candidate, 'adName' | 'adId'>,
): RowAttribution {
  const code = findCodeInText(cand.adName);
  const base = {
    ownerId: ctx.ownerId,
    utmContentRaw: cand.adId,
    packAds: ctx.packAds,
    knownMetaAdIds: ctx.knownMetaAdIds,
    operatorCode: ctx.operatorCode,
  };

  let result: MatchResult = matchLeadToAd({ ...base, adCodeRaw: code });
  // No code, or one we do not know: Meta's ad id may still name the ad.
  if (code && result.match === 'none') {
    const again = matchLeadToAd({ ...base, adCodeRaw: null });
    result = { ...again, adCodeSeen: result.adCodeSeen };
  }

  // A first row carrying code + id teaches later renamed rows in the same run.
  if (result.match === 'code' && result.packAdId && result.metaAdIdSeen) {
    ctx.knownMetaAdIds.set(result.metaAdIdSeen, result.packAdId);
  }

  const { match, packAdId, adCodeSeen, metaAdIdSeen } = result;
  return {
    match,
    packAdId,
    adCodeSeen,
    metaAdIdSeen,
    foreign: match === 'foreign_code',
    link: (leadId) => ({
      lead_id: leadId,
      owner_id: ctx.ownerId,
      pack_ad_id: packAdId,
      match,
      ad_code_seen: adCodeSeen,
      meta_ad_id_seen: metaAdIdSeen,
    }),
  };
}
