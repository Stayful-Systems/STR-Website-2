/**
 * Batch 38: how the admin's "Ad packs" table reads. Pure: no network, no
 * database, no server-only. The page draws these rows, so what an admin sees
 * about a pack (and the leads each ad has brought) is decided and tested here.
 *
 * Only counts and codes. No lead's name, email, phone or address is ever read
 * into this view: the link rows it takes in carry a lead-free shape
 * (owner id, pack ad id, match).
 */
import { ANGLE_LABELS } from './links.ts';
import { isAngle, type Angle } from './codes.ts';
import type { PackRow, PackStatus } from './store-types.ts';

/** The most packs the page lists. */
export const ADMIN_PACK_LIMIT = 200;

export function money(pence: number | null | undefined): string {
  if (pence === null || pence === undefined || !Number.isFinite(pence)) return '—';
  const pounds = pence / 100;
  return Number.isInteger(pounds) ? `£${pounds}` : `£${pounds.toFixed(2)}`;
}

export const STATUS_LABELS: Record<PackStatus, string> = {
  draft: 'Draft',
  generating: 'Being made',
  checks_failed: 'Checks failed',
  preview: 'Ready to look at',
  approved: 'Approved',
  failed: 'Failed',
};

/** The few fields of an ad the table needs. */
export type AdminAdInput = { id: string; packId: string; version: number; angle: string; code: string };
/** One website lead's link, with nothing that identifies the lead. */
export type AdminLinkInput = { ownerId: string; packAdId: string | null; match: string };
export type AdminOwnerInput = { company: string | null; email: string | null };

export type AdminAdRow = {
  id: string;
  code: string;
  label: string;
  version: number;
  /** Belongs to the pack's current version (older codes stay valid and still count). */
  current: boolean;
  leads: number;
};

export type AdminPackRow = {
  packId: string;
  ownerId: string;
  company: string | null;
  email: string | null;
  status: PackStatus;
  statusLabel: string;
  version: number;
  generatedAt: string | null;
  approvedAt: string | null;
  regenCount: number;
  costPence: number;
  costLabel: string;
  ads: AdminAdRow[];
  /** Leads recorded against one of this pack's ads (every version). */
  taggedLeads: number;
  /** This owner's leads with no ad: match 'none' or 'foreign_code'. */
  untagged: number;
  /** Linked to an ad that no longer exists (shown only when above zero). */
  unplaced: number;
  /** A regenerate needs a stored area, so a pack that never got one cannot be redone from here. */
  canRegenerate: boolean;
};

export type AdminTotals = { packs: number; taggedLeads: number; untagged: number; unplaced: number; costPence: number };

export type AdminView = { rows: AdminPackRow[]; totals: AdminTotals };

const TAGGED = new Set(['code', 'ad_id']);
const UNTAGGED = new Set(['none', 'foreign_code']);

/** Newest version first, then the angle order of the pack (5b, 3a, 17). */
const ANGLE_ORDER: Record<Angle, number> = { '5b': 0, '3a': 1, '17': 2 };

export function buildAdminView(input: {
  packs: PackRow[];
  owners: ReadonlyMap<string, AdminOwnerInput>;
  ads: AdminAdInput[];
  links: AdminLinkInput[];
}): AdminView {
  const packs = input.packs.slice(0, ADMIN_PACK_LIMIT);

  const perAd = new Map<string, number>();
  const untaggedBy = new Map<string, number>();
  const unplacedBy = new Map<string, number>();
  for (const l of input.links) {
    if (TAGGED.has(l.match) && l.packAdId) perAd.set(l.packAdId, (perAd.get(l.packAdId) ?? 0) + 1);
    else if (TAGGED.has(l.match)) unplacedBy.set(l.ownerId, (unplacedBy.get(l.ownerId) ?? 0) + 1);
    else if (UNTAGGED.has(l.match)) untaggedBy.set(l.ownerId, (untaggedBy.get(l.ownerId) ?? 0) + 1);
  }

  const adsOf = new Map<string, AdminAdInput[]>();
  for (const a of input.ads) {
    const list = adsOf.get(a.packId);
    if (list) list.push(a);
    else adsOf.set(a.packId, [a]);
  }

  const rows = packs.map((p): AdminPackRow => {
    const ads = (adsOf.get(p.id) ?? [])
      .filter((a) => isAngle(a.angle))
      .sort((x, y) => y.version - x.version || ANGLE_ORDER[x.angle as Angle] - ANGLE_ORDER[y.angle as Angle])
      .map((a): AdminAdRow => ({
        id: a.id,
        code: a.code,
        label: ANGLE_LABELS[a.angle as Angle],
        version: a.version,
        current: a.version === p.version,
        leads: perAd.get(a.id) ?? 0,
      }));
    const owner = input.owners.get(p.ownerId);
    return {
      packId: p.id,
      ownerId: p.ownerId,
      company: owner?.company || null,
      email: owner?.email ?? null,
      status: p.status,
      statusLabel: STATUS_LABELS[p.status] ?? p.status,
      version: p.version,
      generatedAt: p.generatedAt,
      approvedAt: p.approvedAt,
      regenCount: p.regenCount,
      costPence: p.costPence,
      costLabel: money(p.costPence),
      ads,
      taggedLeads: ads.reduce((n, a) => n + a.leads, 0),
      untagged: untaggedBy.get(p.ownerId) ?? 0,
      unplaced: unplacedBy.get(p.ownerId) ?? 0,
      canRegenerate: p.areaKey !== null && p.areaKey !== '',
    };
  });

  const owners = new Set(rows.map((r) => r.ownerId));
  const totals: AdminTotals = {
    packs: rows.length,
    taggedLeads: rows.reduce((n, r) => n + r.taggedLeads, 0),
    // Per owner, once each (an owner has one pack).
    untagged: [...owners].reduce((n, o) => n + (untaggedBy.get(o) ?? 0), 0),
    unplaced: [...owners].reduce((n, o) => n + (unplacedBy.get(o) ?? 0), 0),
    costPence: rows.reduce((n, r) => n + r.costPence, 0),
  };
  return { rows, totals };
}
