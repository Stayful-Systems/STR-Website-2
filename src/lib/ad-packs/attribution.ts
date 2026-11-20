/**
 * Batch 36: attribution on arrival. A website lead arrives with the ad code
 * (?ad=<CODE>, kept in lead_sources.ad_code) and, when Meta filled it in, the
 * Meta ad id (utm_content = {{ad.id}}). This works out which pack ad brought it.
 *
 *   code      the code parses and its ad belongs to this owner: linked, even
 *             when the ad has been superseded (an old version's code keeps
 *             linking) or renamed in Meta (the code rides in the link).
 *   ad_id     no code at all, but Meta's ad id was already seen WITH a code for
 *             this same owner: linked to that ad.
 *   foreign   a code that is another operator's: stored untagged and counted
 *             as untagged. Never linked.
 *   none      no code, a code that does not parse, or an unknown code.
 *
 * The cleaned Meta ad id (digits, 30 at most) is always kept when valid.
 *
 * Also the injectable core of the link (`linkLead`, `linkMissing`): every
 * outside effect arrives through `AttributionStore`, so it all runs under
 * `node --test` with a fake. The real store is attribution-server.ts.
 *
 * ⚠️ This never writes `leads` (`leads.status` and `leads.crm_pushed_at` mean
 * "went to your CRM"); its only write is `ad_pack_lead_links`.
 * ⚠️ Nothing here logs a lead: a log line carries a lead id and a code at most.
 *
 * Pure: no network, no database, no server-only.
 */
import { parseCode, normaliseCode } from './codes.ts';
import { ANGLE_LABELS, cleanMetaAdId } from './links.ts';
import type { Angle } from './codes.ts';

/** lead_sources.ad_code and ad_pack_lead_links.ad_code_seen are varchar(40). */
export const AD_CODE_SEEN_MAX = 40;

export type AttributionMatch = 'code' | 'ad_id' | 'none' | 'foreign_code';

export interface PackAdRef {
  id: string;
  code: string;
  ownerId: string;
  version: number;
}

export interface MatchInput {
  ownerId: string;
  adCodeRaw: string | null | undefined;
  utmContentRaw: string | null | undefined;
  packAds: PackAdRef[];
  /** Meta ad ids previously seen with a code for THIS owner -> the pack ad that code named. */
  knownMetaAdIds: ReadonlyMap<string, string>;
  /** This owner's operator code, when known (a code with another operator's is foreign). Derived from packAds when omitted. */
  operatorCode?: string | null;
}

export interface MatchResult {
  match: AttributionMatch;
  packAdId: string | null;
  adCodeSeen: string | null;
  metaAdIdSeen: string | null;
}

function seen(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return t ? t.slice(0, AD_CODE_SEEN_MAX) : null;
}

function ownOperatorCode(input: MatchInput): string | null {
  if (input.operatorCode) return String(input.operatorCode).toUpperCase();
  for (const ad of input.packAds) {
    if (ad.ownerId !== input.ownerId) continue;
    const p = parseCode(ad.code);
    if (p) return p.operatorCode;
  }
  return null;
}

export function matchLeadToAd(input: MatchInput): MatchResult {
  const metaAdIdSeen = cleanMetaAdId(input.utmContentRaw);
  const adCodeSeen = seen(input.adCodeRaw);
  const base = { adCodeSeen, metaAdIdSeen };

  // A code came in.
  if (adCodeSeen !== null) {
    const code = normaliseCode(input.adCodeRaw);
    const parsed = code ? parseCode(code) : null;
    if (!code || !parsed) return { match: 'none', packAdId: null, ...base };

    const ad = input.packAds.find((a) => normaliseCode(a.code) === code);
    if (ad) {
      if (ad.ownerId !== input.ownerId) return { match: 'foreign_code', packAdId: null, ...base };
      return { match: 'code', packAdId: ad.id, ...base };
    }
    // Not a known ad. Another operator's code is foreign; an unknown one of ours is just unknown.
    const own = ownOperatorCode(input);
    if (own && parsed.operatorCode !== own) return { match: 'foreign_code', packAdId: null, ...base };
    return { match: 'none', packAdId: null, ...base };
  }

  // No code at all: Meta's ad id, only if it was already seen with a code for this owner.
  if (metaAdIdSeen) {
    const known = input.knownMetaAdIds.get(metaAdIdSeen);
    if (known && input.packAds.some((a) => a.id === known && a.ownerId === input.ownerId)) {
      return { match: 'ad_id', packAdId: known, ...base };
    }
  }
  return { match: 'none', packAdId: null, ...base };
}

// ── The injectable core ───────────────────────────────────────────────────

export interface AttributionLead {
  ownerId: string;
  /** A website lead has a website report row. Others are skipped. */
  isWebsiteLead: boolean;
}

export interface AttributionPack {
  operatorCode: string | null;
  approvedAt: string | null;
}

export interface LinkRow {
  lead_id: string;
  owner_id: string;
  pack_ad_id: string | null;
  match: AttributionMatch;
  ad_code_seen: string | null;
  meta_ad_id_seen: string | null;
}

export interface MissingLead {
  leadId: string;
  ownerId: string;
}

export interface AttributionStore {
  lead(leadId: string): Promise<AttributionLead | null>;
  sources(leadId: string): Promise<{ adCode: string | null; utmContent: string | null } | null>;
  pack(ownerId: string): Promise<AttributionPack | null>;
  /** The owner's pack ads (every version), plus the ad (any owner) that carries `alsoCode`, when there is one. */
  packAds(ownerId: string, alsoCode: string | null): Promise<PackAdRef[]>;
  /** Meta ad ids seen with a 'code' match for this owner. */
  knownMetaAdIds(ownerId: string): Promise<Map<string, string>>;
  /** The only write: upsert on lead_id. */
  upsertLink(row: LinkRow): Promise<void>;
  /** Website leads of owners with an approved pack, created since approval (when `sinceApproved`), with no link row. */
  missingLeads(opts: { ownerId?: string; sinceApproved: boolean; limit: number }): Promise<MissingLead[]>;
}

export type LinkCode = 'linked' | 'untagged' | 'skipped_not_found' | 'skipped_not_website_lead' | 'skipped_no_approved_pack' | 'error';

/**
 * Records which pack ad brought one website lead. NEVER THROWS: returns a
 * code. Idempotent (an upsert on the lead id). Quiet for a lead that is not a
 * website lead and for an owner with no approved pack ("Ad unknown" only
 * shows once there is a pack).
 */
export async function linkLead(store: AttributionStore, leadId: string): Promise<LinkCode> {
  try {
    const lead = await store.lead(leadId);
    if (!lead) return 'skipped_not_found';
    if (!lead.isWebsiteLead) return 'skipped_not_website_lead';
    const pack = await store.pack(lead.ownerId);
    if (!pack || !pack.approvedAt) return 'skipped_no_approved_pack';

    const src = (await store.sources(leadId)) ?? { adCode: null, utmContent: null };
    const parsed = parseCode(src.adCode);
    const [packAds, known] = await Promise.all([
      store.packAds(lead.ownerId, parsed ? normaliseCode(src.adCode) : null),
      store.knownMetaAdIds(lead.ownerId),
    ]);
    const m = matchLeadToAd({
      ownerId: lead.ownerId,
      adCodeRaw: src.adCode,
      utmContentRaw: src.utmContent,
      packAds,
      knownMetaAdIds: known,
      operatorCode: pack.operatorCode,
    });
    await store.upsertLink({
      lead_id: leadId,
      owner_id: lead.ownerId,
      pack_ad_id: m.packAdId,
      match: m.match,
      ad_code_seen: m.adCodeSeen,
      meta_ad_id_seen: m.metaAdIdSeen,
    });
    return m.packAdId ? 'linked' : 'untagged';
  } catch {
    console.error('[ad-packs] attribution failed for lead', leadId);
    return 'error';
  }
}

export interface LinkMissingResult {
  ok: boolean;
  code: 'ok' | 'error';
  dry: boolean;
  /** Lead ids only. Dry: the leads that would be linked. Otherwise: the leads that were tried. */
  leadIds: string[];
  count: number;
  linked: number;
  untagged: number;
  skipped: number;
  failed: number;
}

/** The most one run looks at (the admin button can be pressed again for the rest). */
export const LINK_MISSING_LIMIT = 500;

export async function linkMissing(
  store: AttributionStore,
  opts: { ownerId?: string; sinceApproved?: boolean; dry?: boolean; limit?: number } = {},
): Promise<LinkMissingResult> {
  const dry = opts.dry === true;
  const empty: LinkMissingResult = { ok: false, code: 'error', dry, leadIds: [], count: 0, linked: 0, untagged: 0, skipped: 0, failed: 0 };
  try {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? LINK_MISSING_LIMIT)), LINK_MISSING_LIMIT);
    const missing = await store.missingLeads({ ownerId: opts.ownerId, sinceApproved: opts.sinceApproved !== false, limit });
    const leadIds = missing.map((m) => m.leadId);
    const out: LinkMissingResult = { ...empty, ok: true, code: 'ok', leadIds, count: leadIds.length };
    if (dry) return out;
    for (const id of leadIds) {
      const c = await linkLead(store, id);
      if (c === 'linked') out.linked++;
      else if (c === 'untagged') out.untagged++;
      else if (c === 'error') out.failed++;
      else out.skipped++;
    }
    return out;
  } catch {
    console.error('[ad-packs] link missing leads failed');
    return empty;
  }
}

// ── Lead detail line ──────────────────────────────────────────────────────

export type PackAdLineView =
  | { kind: 'hidden' }
  | { kind: 'unknown'; text: 'Ad unknown' }
  | { kind: 'matched'; text: string };

/**
 * What the lead page shows. Nothing without an approved pack; "Ad: <code> ·
 * <angle>" when the link names an ad (the code already carries the angle's
 * number, and the ad name is code · label, so the label is shown once);
 * "Ad unknown" for none / foreign_code / no link row.
 */
export function packAdLineView(input: {
  hasApprovedPack: boolean;
  link: { match: string; packAdId: string | null } | null;
  ad: { code: string; angle: string } | null;
}): PackAdLineView {
  if (!input.hasApprovedPack) return { kind: 'hidden' };
  const { link, ad } = input;
  if (link && (link.match === 'code' || link.match === 'ad_id') && link.packAdId && ad) {
    const label = ANGLE_LABELS[ad.angle as Angle] ?? ad.angle;
    return { kind: 'matched', text: `Ad: ${ad.code} · ${label}` };
  }
  return { kind: 'unknown', text: 'Ad unknown' };
}
