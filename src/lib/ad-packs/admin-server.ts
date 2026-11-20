import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { createSupabaseServerClient } from '../supabase/server';
import { domainIsLiveFor, domainOfSite } from '../domains/store-server';
import { ownSite, parseSiteSettings, siteById } from '../websites/store-server';
import { linkMissingLeads } from './attribution-server';
import { generatePack } from './generate-server';
import { adPackAdminRunner, type AdPackAdminRunner, type RegenSource } from './admin-run.ts';
import { ADMIN_PACK_LIMIT, buildAdminView, type AdminAdInput, type AdminLinkInput, type AdminOwnerInput, type AdminView } from './admin-view.ts';
import { PACK_COLUMNS, toPackRow } from './rows.ts';
import type { PackRow } from './store-types.ts';

/**
 * Batch 36: what /admin/ad-packs shows and does. Service role only.
 *
 * Reads (light, limited): ad_packs (newest first, 200 at most), the owners'
 * email (profiles) and company name (websites.settings), the packs' ads
 * (id, pack, version, angle, code) and the link rows of those owners
 * (owner, pack ad, match only: never a lead's id or contact details).
 *
 * Writes: none here. The actions go through generatePack (by:'admin') and
 * linkMissingLeads, which write only the pack, its ads and files, its run
 * rows and ad_pack_lead_links. Nothing writes `leads`.
 *
 * Logs carry a table name and an error code, never a lead, a text or an address.
 */

export type AdPacksAdminData = { available: boolean; readError: string | null; view: AdminView; linksTruncated: boolean };

const EMPTY: AdminView = { rows: [], totals: { packs: 0, taggedLeads: 0, untagged: 0, unplaced: 0, costPence: 0 } };

const PAGE = 1000;
/** Link rows read in all (20 pages). The table's own counts say so when it is cut off. */
const MAX_LINK_PAGES = 20;

export async function loadAdPacksAdmin(): Promise<AdPacksAdminData> {
  if (!hasServiceRole()) return { available: false, readError: null, view: EMPTY, linksTruncated: false };
  const db = createAdminClient();
  const packsRes = await db.from('ad_packs').select(PACK_COLUMNS).order('created_at', { ascending: false }).limit(ADMIN_PACK_LIMIT);
  if (packsRes.error) {
    console.error('[ad-packs] admin packs read failed:', packsRes.error.code ?? 'error');
    return { available: true, readError: 'Could not read the packs just now.', view: EMPTY, linksTruncated: false };
  }
  const packs: PackRow[] = ((packsRes.data ?? []) as unknown as Record<string, unknown>[]).map(toPackRow);
  if (packs.length === 0) return { available: true, readError: null, view: EMPTY, linksTruncated: false };

  const ownerIds = [...new Set(packs.map((p) => p.ownerId))];
  const packIds = packs.map((p) => p.id);
  const [profiles, sites, adsRes] = await Promise.all([
    db.from('profiles').select('id, email').in('id', ownerIds),
    db.from('websites').select('user_id, settings').in('user_id', ownerIds),
    db.from('ad_pack_ads').select('id, pack_id, version, angle, code').in('pack_id', packIds).limit(5000),
  ]);

  let readError: string | null = null;
  for (const [name, res] of [['profiles', profiles], ['websites', sites], ['ad_pack_ads', adsRes]] as const) {
    if (res.error) {
      console.error(`[ad-packs] admin ${name} read failed:`, res.error.code ?? 'error');
      readError = 'Some details could not be read just now.';
    }
  }

  const owners = new Map<string, AdminOwnerInput>();
  for (const id of ownerIds) owners.set(id, { company: null, email: null });
  for (const r of (profiles.data ?? []) as { id: string; email: string | null }[]) {
    const o = owners.get(r.id);
    if (o) o.email = r.email ?? null;
  }
  for (const r of (sites.data ?? []) as { user_id: string; settings: unknown }[]) {
    const o = owners.get(r.user_id);
    if (o) o.company = parseSiteSettings(r.settings).companyName || null;
  }
  const ads = ((adsRes.data ?? []) as { id: string; pack_id: string; version: number; angle: string; code: string }[]).map(
    (a): AdminAdInput => ({ id: a.id, packId: a.pack_id, version: a.version, angle: a.angle, code: a.code }),
  );

  // Link rows, a page at a time (the database returns 1000 at most). Only owner, ad and match.
  const links: AdminLinkInput[] = [];
  let linksTruncated = false;
  for (let page = 0; page < MAX_LINK_PAGES; page++) {
    const { data, error } = await db
      .from('ad_pack_lead_links')
      .select('owner_id, pack_ad_id, match')
      .in('owner_id', ownerIds)
      .order('lead_id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      console.error('[ad-packs] admin links read failed:', error.code ?? 'error');
      readError = 'The lead counts could not be read just now.';
      break;
    }
    const rows = (data ?? []) as { owner_id: string; pack_ad_id: string | null; match: string }[];
    for (const r of rows) links.push({ ownerId: r.owner_id, packAdId: r.pack_ad_id, match: r.match });
    if (rows.length < PAGE) break;
    if (page === MAX_LINK_PAGES - 1) linksTruncated = true;
  }

  return { available: true, readError, view: buildAdminView({ packs, owners, ads, links }), linksTruncated };
}

/**
 * The inputs of an admin regenerate, read afresh each time: the owner's
 * CURRENT website settings (company, logo, colour, fee, areas, photo), their
 * live domain, and the pack's stored area key and photos.
 */
export async function readRegenSource(packId: string): Promise<RegenSource> {
  if (!hasServiceRole()) return { ok: false, code: 'unreadable' };
  const { data, error } = await createAdminClient().from('ad_packs').select(PACK_COLUMNS).eq('id', packId).maybeSingle();
  if (error) {
    console.error('[ad-packs] admin pack read failed:', error.code ?? 'error');
    return { ok: false, code: 'unreadable' };
  }
  if (!data) return { ok: false, code: 'no_pack' };
  const pack = toPackRow(data as unknown as Record<string, unknown>);
  if (!pack.areaKey) return { ok: false, code: 'no_area' };

  const site = (pack.websiteId ? await siteById(pack.websiteId) : null) ?? (await ownSite(pack.ownerId));
  if (!site || site.userId !== pack.ownerId) return { ok: false, code: 'no_site' };
  const domain = await domainOfSite(site.id);
  if (!domain || domain.status !== 'live' || !(await domainIsLiveFor(site.id, domain.name))) return { ok: false, code: 'no_domain' };

  const s = site.settings;
  return {
    ok: true,
    ownerId: pack.ownerId,
    company: s.companyName,
    wasApproved: pack.approvedAt !== null,
    input: {
      // The stored area key is what the last version was checked against (after any fall-back it is the postcode area).
      areaKey: pack.areaKey,
      photos: pack.photos ?? [],
      brand: { company: s.companyName, logoUrl: s.logoUrl, brandColour: s.brandColour, feePct: s.managementFeePct, areas: s.areas, photoUrl: s.photoUrl },
      domain: domain.name,
      websiteId: site.id,
      // A pack with no logo can only have been made with the name in type only.
      typeOnly: s.logoUrl === null,
    },
  };
}

/** The runner over the real wiring: the verified session user, the generator and attribution. */
export function liveAdPackAdminRunner(): AdPackAdminRunner {
  return adPackAdminRunner({
    currentUser: async () => {
      const supabase = await createSupabaseServerClient();
      const { data } = await supabase.auth.getUser();
      return data.user ?? null;
    },
    readRegenSource,
    generate: (req) => generatePack(req),
    linkMissing: (opts) => linkMissingLeads(opts),
    audit: (line) => console.info(`[admin] ad-packs: ${line}`),
  });
}
