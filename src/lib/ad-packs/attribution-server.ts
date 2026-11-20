import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import {
  linkLead,
  linkMissing,
  packAdLineView,
  type AttributionStore,
  type LinkCode,
  type LinkMissingResult,
  type MissingLead,
  type PackAdLineView,
  type PackAdRef,
} from './attribution.ts';

export { linkLead, linkMissing, matchLeadToAd, packAdLineView } from './attribution.ts';
export type { AttributionStore, LinkCode, LinkMissingResult, PackAdLineView } from './attribution.ts';

/**
 * Batch 36: the real database behind attribution on arrival. Service role
 * only: ad_packs, ad_pack_ads and ad_pack_lead_links have RLS on with no policy.
 *
 * Reads: leads (id, owner, created), website_reports (is it a website lead),
 * lead_sources (the ad code and utm_content), ad_packs, ad_pack_ads,
 * ad_pack_lead_links. The ONLY write is an upsert into ad_pack_lead_links.
 * Nothing here writes `leads` (`leads.status` and `leads.crm_pushed_at` mean
 * "went to your CRM"); a test pins that.
 *
 * Nothing here logs a lead: a failure logs the table's name and the
 * database's error code at most (linkLead adds the lead id).
 */

const db = () => createAdminClient();

function fail(table: string, code: string | undefined): never {
  console.error(`[ad-packs] ${table} read failed:`, code ?? 'error');
  throw new Error('db');
}

export function supabaseAttributionStore(): AttributionStore {
  return {
    async lead(leadId) {
      const { data, error } = await db().from('leads').select('id, user_id').eq('id', leadId).maybeSingle();
      if (error) fail('leads', error.code);
      if (!data) return null;
      const { data: rep, error: repError } = await db().from('website_reports').select('lead_id').eq('lead_id', leadId).maybeSingle();
      if (repError) fail('website_reports', repError.code);
      return { ownerId: (data as { user_id: string }).user_id, isWebsiteLead: Boolean(rep) };
    },

    async sources(leadId) {
      const { data, error } = await db().from('lead_sources').select('ad_code, utm_content').eq('lead_id', leadId).maybeSingle();
      if (error) fail('lead_sources', error.code);
      if (!data) return null;
      const r = data as { ad_code: string | null; utm_content: string | null };
      return { adCode: r.ad_code, utmContent: r.utm_content };
    },

    async pack(ownerId) {
      const { data, error } = await db().from('ad_packs').select('operator_code, approved_at').eq('owner_id', ownerId).maybeSingle();
      if (error) fail('ad_packs', error.code);
      if (!data) return null;
      const r = data as { operator_code: string | null; approved_at: string | null };
      return { operatorCode: r.operator_code, approvedAt: r.approved_at };
    },

    async packAds(ownerId, alsoCode) {
      const cols = 'id, code, owner_id, version';
      const rows = (r: unknown): PackAdRef[] =>
        ((r ?? []) as { id: string; code: string; owner_id: string; version: number }[]).map((a) => ({ id: a.id, code: a.code, ownerId: a.owner_id, version: a.version }));
      const own = await db().from('ad_pack_ads').select(cols).eq('owner_id', ownerId);
      if (own.error) fail('ad_pack_ads', own.error.code);
      const out = rows(own.data);
      if (alsoCode && !out.some((a) => a.code === alsoCode)) {
        // The code may be another owner's: look it up so the matcher can tell "foreign" from "unknown".
        const other = await db().from('ad_pack_ads').select(cols).eq('code', alsoCode).limit(1);
        if (other.error) fail('ad_pack_ads', other.error.code);
        out.push(...rows(other.data));
      }
      return out;
    },

    async knownMetaAdIds(ownerId) {
      const { data, error } = await db()
        .from('ad_pack_lead_links')
        .select('pack_ad_id, meta_ad_id_seen')
        .eq('owner_id', ownerId)
        .eq('match', 'code')
        .not('pack_ad_id', 'is', null)
        .not('meta_ad_id_seen', 'is', null)
        .order('linked_at', { ascending: true })
        .limit(5000);
      if (error) fail('ad_pack_lead_links', error.code);
      const out = new Map<string, string>();
      // Oldest first, so a later link wins if one Meta id was ever seen with two codes.
      for (const r of (data ?? []) as { pack_ad_id: string; meta_ad_id_seen: string }[]) out.set(r.meta_ad_id_seen, r.pack_ad_id);
      return out;
    },

    async upsertLink(row) {
      const { error } = await db().from('ad_pack_lead_links').upsert({ ...row, linked_at: new Date().toISOString() }, { onConflict: 'lead_id' });
      if (error) fail('ad_pack_lead_links', error.code);
    },

    async missingLeads({ ownerId, sinceApproved, limit }) {
      let packs = db().from('ad_packs').select('owner_id, approved_at').not('approved_at', 'is', null);
      if (ownerId) packs = packs.eq('owner_id', ownerId);
      const { data: packRows, error: packError } = await packs;
      if (packError) fail('ad_packs', packError.code);

      const out: MissingLead[] = [];
      const PAGE = 500;
      for (const p of (packRows ?? []) as { owner_id: string; approved_at: string }[]) {
        for (let page = 0; page < 20 && out.length < limit; page++) {
          let q = db()
            .from('leads')
            .select('id, website_reports!inner(lead_id)')
            .eq('user_id', p.owner_id)
            .order('created_at', { ascending: false })
            .range(page * PAGE, page * PAGE + PAGE - 1);
          if (sinceApproved) q = q.gte('created_at', p.approved_at);
          const { data: leadRows, error: leadError } = await q;
          if (leadError) fail('leads', leadError.code);
          const ids = ((leadRows ?? []) as unknown as { id: string }[]).map((l) => l.id);
          if (ids.length === 0) break;
          const { data: linked, error: linkError } = await db().from('ad_pack_lead_links').select('lead_id').in('lead_id', ids);
          if (linkError) fail('ad_pack_lead_links', linkError.code);
          const have = new Set(((linked ?? []) as { lead_id: string }[]).map((l) => l.lead_id));
          for (const id of ids) {
            if (!have.has(id) && out.length < limit) out.push({ leadId: id, ownerId: p.owner_id });
          }
          if (ids.length < PAGE) break;
        }
        if (out.length >= limit) break;
      }
      return out;
    },
  };
}

/**
 * Records which pack ad brought a website lead. Called fire-and-forget after
 * the step-1 save. NEVER THROWS, returns a code, logs a lead id and a code at
 * most. Quiet for a lead that is not a website lead and for an owner with no
 * approved pack.
 */
export async function linkLeadToPackAd(leadId: string): Promise<LinkCode | 'not_configured'> {
  try {
    if (!hasServiceRole()) return 'not_configured';
    return await linkLead(supabaseAttributionStore(), leadId);
  } catch {
    console.error('[ad-packs] attribution failed for lead', leadId);
    return 'error';
  }
}

/**
 * Phase 10's "Link missing leads": website leads of owners with an approved
 * pack, created since approval, with no link row yet. `dry` lists lead ids
 * and writes nothing. Idempotent: a linked lead no longer shows up.
 */
export async function linkMissingLeads(opts: { ownerId?: string; sinceApproved?: boolean; dry?: boolean } = {}): Promise<LinkMissingResult> {
  if (!hasServiceRole()) {
    return { ok: false, code: 'error', dry: opts.dry === true, leadIds: [], count: 0, linked: 0, untagged: 0, skipped: 0, failed: 0 };
  }
  return linkMissing(supabaseAttributionStore(), opts);
}

/**
 * The line on a lead's page. Filtered by the viewer's account owner id, so
 * another account can never see it. Hidden on any failure.
 */
export async function packAdLine(leadId: string, ownerId: string): Promise<PackAdLineView> {
  try {
    if (!hasServiceRole()) return { kind: 'hidden' };
    const admin = db();
    const { data: pack, error: packError } = await admin.from('ad_packs').select('approved_at').eq('owner_id', ownerId).maybeSingle();
    if (packError) fail('ad_packs', packError.code);
    const hasApprovedPack = Boolean((pack as { approved_at: string | null } | null)?.approved_at);
    if (!hasApprovedPack) return { kind: 'hidden' };

    const { data: link, error: linkError } = await admin
      .from('ad_pack_lead_links')
      .select('match, pack_ad_id')
      .eq('lead_id', leadId)
      .eq('owner_id', ownerId)
      .maybeSingle();
    if (linkError) fail('ad_pack_lead_links', linkError.code);
    const l = link as { match: string; pack_ad_id: string | null } | null;

    let ad: { code: string; angle: string } | null = null;
    if (l?.pack_ad_id) {
      const { data: adRow, error: adError } = await admin.from('ad_pack_ads').select('code, angle').eq('id', l.pack_ad_id).eq('owner_id', ownerId).maybeSingle();
      if (adError) fail('ad_pack_ads', adError.code);
      ad = (adRow as { code: string; angle: string } | null) ?? null;
    }
    return packAdLineView({ hasApprovedPack, link: l ? { match: l.match, packAdId: l.pack_ad_id } : null, ad });
  } catch {
    return { kind: 'hidden' };
  }
}
