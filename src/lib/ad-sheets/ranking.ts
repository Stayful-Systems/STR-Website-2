/**
 * Batch 35 (Phase 9): "Your ads". Which of the operator's pack ads brought the
 * leads that went on to a meeting and to signing, worked out only from the
 * operator's own leads and the link rows that say which ad brought each one.
 *
 *   - Per pack ad: leads (count), meetings (a lead with meeting_reached_at),
 *     signed (leads currently at stage signed). Counts only: no spend, no cost
 *     per lead, no benchmark, no percentage.
 *   - A lead with no pack-ad link (none, a foreign code, no link row) is
 *     "Ad unknown" (`packAdLineView`'s words): it counts in the TOTALS and never
 *     in the ranking.
 *   - Ads with at least `ad_sheet_min_leads` leads are ranked by signed, then
 *     meetings, then leads (a stable tiebreak on the ad's label, then its id).
 *     Ads below the minimum are listed under "Not enough data yet", unranked.
 *   - A note, "Outcomes aren't being marked", when under `ad_sheet_outcome_pct`
 *     percent of the leads older than `ad_sheet_outcome_age_days` days are past
 *     New. No lead that old, no note.
 *   - Every row is checked against the owner here as well as in the store, so a
 *     store that returned another operator's rows still could not show them.
 *     Archived leads are never counted.
 *
 * ⚠️ Nothing here logs a lead, and every figure in the copy comes from the
 * settings, never typed.
 *
 * Pure: no network, no database, no server-only. The real store is
 * ranking-server.ts.
 */
import { packAdLineView } from '../ad-packs/attribution.ts';
import type { SheetSettings } from './settings.ts';

const DAY_MS = 86_400_000;

export interface RankLead {
  id: string;
  ownerId: string;
  /** leads.stage */
  stage: string;
  /** leads.meeting_reached_at, null until a lead first reached a meeting. */
  meetingReachedAt: string | null;
  createdAt: string;
  archived: boolean;
}

export interface RankLink {
  leadId: string;
  ownerId: string;
  packAdId: string | null;
  /** 'code' | 'ad_id' | 'none' | 'foreign_code' */
  match: string;
  /** The code the lead carried, kept as a label for an ad this screen no longer lists. */
  adCodeSeen: string | null;
}

/** One of the owner's pack ads (the pack on screen). */
export interface RankAdRef {
  id: string;
  ownerId: string;
  code: string;
  angle: string;
}

export interface RankingStore {
  /** The owner's leads. The real one filters by owner; the engine checks again. */
  leads(ownerId: string): Promise<RankLead[]>;
  /** The owner's pack-ad link rows. */
  links(ownerId: string): Promise<RankLink[]>;
  settings(): Promise<SheetSettings>;
}

export type Counts = { leads: number; meetings: number; signed: number };

export type AdRankRow = Counts & { adId: string; label: string };
export type RankedRow = AdRankRow & { rank: number };

export interface OutcomeNote {
  title: string;
  text: string;
  href: string;
}

export interface RankingView {
  /** Every lead in scope, tagged or not. */
  totals: Counts;
  /** Leads with no pack-ad link. They are in `totals` only. */
  untagged: Counts & { label: string };
  ranked: RankedRow[];
  notEnough: AdRankRow[];
  minLeads: number;
  /** What the "Not enough data yet" and ranking copy says; figures come from settings. */
  rankingNote: string;
  outcomeNote: OutcomeNote | null;
  /** No lead was brought by a pack ad: show the plain empty state. */
  empty: boolean;
  emptyText: string;
}

const UNKNOWN_LABEL = packAdLineView({ hasApprovedPack: true, link: null, ad: null });

export const AD_UNKNOWN_LABEL = UNKNOWN_LABEL.kind === 'unknown' ? UNKNOWN_LABEL.text : 'Ad unknown';
export const NOT_ENOUGH_TITLE = 'Not enough data yet';
export const OUTCOME_NOTE_TITLE = "Outcomes aren't being marked";
export const LEADS_LIST_HREF = '/leads';
export const EMPTY_TEXT = 'No leads have come from your ads yet. When they do, you will see here which ad brought the meetings and the signed landlords.';

const zero = (): Counts => ({ leads: 0, meetings: 0, signed: 0 });

function add(c: Counts, l: RankLead): void {
  c.leads += 1;
  if (l.meetingReachedAt) c.meetings += 1;
  if (l.stage === 'signed') c.signed += 1;
}

/** Whether a link row names one of the owner's ads (the same rule `packAdLineView` applies). */
function isTagged(link: RankLink | undefined): link is RankLink & { packAdId: string } {
  return Boolean(link && (link.match === 'code' || link.match === 'ad_id') && link.packAdId);
}

/** Highest signed, then meetings, then leads; the label and id break a tie so the order never shuffles. */
export function compareRows(a: AdRankRow, b: AdRankRow): number {
  return b.signed - a.signed || b.meetings - a.meetings || b.leads - a.leads || a.label.localeCompare(b.label) || a.adId.localeCompare(b.adId);
}

/** The label for an ad: its code and angle, as the lead page shows it (without the "Ad: " lead-in). */
export function adLabel(ad: RankAdRef | undefined, codeSeen: string | null): string {
  if (ad) {
    const v = packAdLineView({ hasApprovedPack: true, link: { match: 'code', packAdId: ad.id }, ad: { code: ad.code, angle: ad.angle } });
    if (v.kind === 'matched') return v.text.replace(/^Ad: /, '');
  }
  return codeSeen ? codeSeen : 'An earlier ad';
}

/** Whether the outcomes note shows: leads older than the age, and under the percentage of them past New. */
export function outcomesUnmarked(leads: readonly RankLead[], settings: Pick<SheetSettings, 'outcomePct' | 'outcomeAgeDays'>, now: Date): boolean {
  const cutoff = now.getTime() - settings.outcomeAgeDays * DAY_MS;
  let old = 0;
  let pastNew = 0;
  for (const l of leads) {
    const t = Date.parse(l.createdAt);
    if (Number.isNaN(t) || t >= cutoff) continue;
    old += 1;
    if (l.stage !== 'new') pastNew += 1;
  }
  if (old === 0) return false;
  return pastNew * 100 < old * settings.outcomePct;
}

export interface RankingInput {
  ownerId: string;
  leads: readonly RankLead[];
  links: readonly RankLink[];
  ads: readonly RankAdRef[];
  settings: SheetSettings;
  now: Date;
}

/** The whole screen's numbers. Another owner's rows, and archived leads, are dropped here. */
export function buildRankingView(input: RankingInput): RankingView {
  const { ownerId, settings } = input;
  const leads = input.leads.filter((l) => l.ownerId === ownerId && !l.archived);
  const leadIds = new Set(leads.map((l) => l.id));
  const linkOf = new Map<string, RankLink>();
  for (const k of input.links) if (k.ownerId === ownerId && leadIds.has(k.leadId)) linkOf.set(k.leadId, k);
  const adsById = new Map(input.ads.filter((a) => a.ownerId === ownerId).map((a) => [a.id, a]));

  const totals = zero();
  const untagged = zero();
  const perAd = new Map<string, Counts & { codeSeen: string | null }>();
  // The ads on screen are listed even with no lead yet (they show under "Not enough data yet").
  for (const a of adsById.values()) perAd.set(a.id, { ...zero(), codeSeen: null });

  for (const l of leads) {
    add(totals, l);
    const link = linkOf.get(l.id);
    if (!isTagged(link)) {
      add(untagged, l);
      continue;
    }
    let row = perAd.get(link.packAdId);
    if (!row) {
      row = { ...zero(), codeSeen: link.adCodeSeen };
      perAd.set(link.packAdId, row);
    }
    add(row, l);
  }

  const rows: AdRankRow[] = [...perAd.entries()].map(([adId, c]) => ({
    adId,
    label: adLabel(adsById.get(adId), c.codeSeen),
    leads: c.leads,
    meetings: c.meetings,
    signed: c.signed,
  }));
  const eligible = rows.filter((r) => r.leads >= settings.minLeads).sort(compareRows);
  const ranked: RankedRow[] = eligible.map((r, i) => ({ ...r, rank: i + 1 }));
  const notEnough = rows.filter((r) => r.leads < settings.minLeads).sort(compareRows);

  const tagged = totals.leads - untagged.leads;
  const outcomeNote: OutcomeNote | null = outcomesUnmarked(leads, settings, input.now)
    ? {
        title: OUTCOME_NOTE_TITLE,
        text: `Fewer than ${settings.outcomePct}% of your leads older than ${settings.outcomeAgeDays} days have moved past New, so this ranking may not show the real picture. Tap what happened on each lead.`,
        href: LEADS_LIST_HREF,
      }
    : null;

  return {
    totals,
    untagged: { ...untagged, label: AD_UNKNOWN_LABEL },
    ranked,
    notEnough,
    minLeads: settings.minLeads,
    rankingNote: `An ad is ranked once it has brought ${settings.minLeads} or more leads. Ranked by landlords signed, then meetings, then leads.`,
    outcomeNote,
    empty: tagged === 0,
    emptyText: EMPTY_TEXT,
  };
}

/** Reads the three things from the store (owner-scoped) and builds the view. */
export async function readRanking(store: RankingStore, ownerId: string, ads: readonly RankAdRef[], now: Date): Promise<RankingView> {
  const [leads, links, settings] = await Promise.all([store.leads(ownerId), store.links(ownerId), store.settings()]);
  return buildRankingView({ ownerId, leads, links, ads, settings, now });
}
