import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { getFunnel } from '../funnels';
import { renderReportPdf, pdfBrandForFunnel } from '../pdf/render';
import { isCalculatorMode } from '../websites/calculator';
import { postSigned } from './client';
import type { AdDeliverDeps, AdDeliveryRow, AdFinishPatch, AdLeadContext, AdStore, FrozenAdBilling } from './ad-deliver';
import type { AnalysisResult } from '../types';
import type { LandlordLeadRow } from '../leads/dedupe';

/**
 * The real database behind the ad lead push (Batch 55 step 2). Service role only: `leaddb_ad_deliveries` and
 * `leaddb_ad_accounts` have RLS on with no policy.
 *
 * Nothing here writes `leads.status` or `leads.crm_pushed_at` (nothing here writes `leads` at all). Log lines carry a
 * code at most.
 */

const DELIVERY_COLUMNS = 'lead_id, owner_id, ld_customer_id, attempts, phase_sent, billable, billable_reason, low_data, repeat_of_lead_id';
/** The sweep never reaches back past this. */
const SWEEP_WINDOW_DAYS = 14;

const db = () => createAdminClient();

export function supabaseAdStore(): AdStore {
  return {
    async claim(leadId, nowIso, leaseUntilIso) {
      const { data, error } = await db()
        .from('leaddb_ad_deliveries')
        .update({ lease_until: leaseUntilIso, updated_at: nowIso })
        .eq('lead_id', leadId)
        .eq('status', 'pending')
        .lte('next_attempt_at', nowIso)
        .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
        .select(DELIVERY_COLUMNS)
        .maybeSingle();
      if (error) {
        console.error('[leaddb-ad] claim failed:', error.code ?? 'error');
        return null;
      }
      return (data as AdDeliveryRow | null) ?? null;
    },

    async context(leadId): Promise<AdLeadContext | null> {
      const admin = db();
      const { data } = await admin
        .from('leads')
        .select('id, user_id, created_at, name, email, phone, address, postcode, bedrooms, result')
        .eq('id', leadId)
        .maybeSingle();
      if (!data) return null;
      const lead = data as {
        id: string; user_id: string; created_at: string; name: string | null; email: string | null; phone: string | null;
        address: string | null; postcode: string | null; bedrooms: number | null; result: AnalysisResult | null;
      };
      const { data: rep } = await admin
        .from('website_reports')
        .select('state, quality_ok, self_submit, website_id, completed_at')
        .eq('lead_id', leadId)
        .maybeSingle();
      const report = rep as { state: string; quality_ok: boolean | null; self_submit: boolean | null; website_id: string; completed_at: string | null } | null;
      let calculator = false;
      if (report) {
        const { data: siteRow } = await admin.from('websites').select('mode').eq('id', report.website_id).maybeSingle();
        calculator = isCalculatorMode((siteRow as { mode?: unknown } | null)?.mode);
      }
      return {
        leadId: lead.id,
        ownerId: lead.user_id,
        createdAt: lead.created_at,
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        address: lead.address,
        postcode: lead.postcode,
        bedrooms: lead.bedrooms,
        result: lead.result,
        calculator,
        report: report ? { state: report.state, qualityOk: report.quality_ok, selfSubmit: report.self_submit === true, completedAt: report.completed_at } : null,
      };
    },

    async account(ownerId) {
      const { data } = await db().from('leaddb_ad_accounts').select('ld_customer_id').eq('owner_id', ownerId).maybeSingle();
      const row = data as { ld_customer_id: string } | null;
      return row ? { ldCustomerId: row.ld_customer_id } : null;
    },

    async adLink(leadId) {
      const admin = db();
      const { data } = await admin.from('ad_pack_lead_links').select('match, meta_ad_id_seen, pack_ad_id').eq('lead_id', leadId).maybeSingle();
      const link = data as { match: string; meta_ad_id_seen: string | null; pack_ad_id: string | null } | null;
      if (!link) return null;
      let packAdCode: string | null = null;
      if (link.pack_ad_id) {
        const { data: ad } = await admin.from('ad_pack_ads').select('code').eq('id', link.pack_ad_id).maybeSingle();
        packAdCode = (ad as { code: string | null } | null)?.code ?? null;
      }
      return { match: link.match, metaAdIdSeen: link.meta_ad_id_seen, packAdCode };
    },

    async adLeadRows(ownerId, sinceIso): Promise<LandlordLeadRow[]> {
      const admin = db();
      const { data: rows } = await admin
        .from('leaddb_ad_deliveries')
        .select('lead_id')
        .eq('owner_id', ownerId)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(200);
      const ids = ((rows ?? []) as { lead_id: string }[]).map((r) => r.lead_id);
      if (ids.length === 0) return [];
      const { data } = await admin.from('leads').select('id, email, phone, postcode, created_at').eq('user_id', ownerId).in('id', ids);
      return (data ?? []) as LandlordLeadRow[];
    },

    async freezeBilling(leadId, billing): Promise<FrozenAdBilling | null> {
      const admin = db();
      const { error } = await admin
        .from('leaddb_ad_deliveries')
        .update({ ...billing, updated_at: new Date().toISOString() })
        .eq('lead_id', leadId)
        .is('billable', null);
      if (error) {
        console.error('[leaddb-ad] freeze failed:', error.code ?? 'error');
        return null;
      }
      // Whatever is on the row now is the answer (ours, or one frozen first by another run).
      const { data } = await admin.from('leaddb_ad_deliveries').select('billable, billable_reason, low_data, repeat_of_lead_id').eq('lead_id', leadId).maybeSingle();
      const row = data as { billable: boolean | null; billable_reason: FrozenAdBilling['billable_reason'] | null; low_data: boolean | null; repeat_of_lead_id: string | null } | null;
      if (!row || row.billable === null || row.billable_reason === null) return null;
      return { billable: row.billable, billable_reason: row.billable_reason, low_data: row.low_data === true, repeat_of_lead_id: row.repeat_of_lead_id };
    },

    async finish(leadId, patch: AdFinishPatch, claimedAttempts) {
      const { error } = await db()
        .from('leaddb_ad_deliveries')
        .update({ ...patch, lease_until: null, updated_at: new Date().toISOString() })
        .eq('lead_id', leadId)
        .eq('attempts', claimedAttempts);
      if (error) console.error('[leaddb-ad] finish failed:', error.code ?? 'error');
    },

    async due(limit, nowIso) {
      const { data, error } = await db()
        .from('leaddb_ad_deliveries')
        .select(DELIVERY_COLUMNS)
        .eq('status', 'pending')
        .lte('next_attempt_at', nowIso)
        .order('next_attempt_at', { ascending: true })
        .limit(limit);
      if (error) {
        console.error('[leaddb-ad] drain query failed:', error.code ?? 'error');
        return [];
      }
      return (data ?? []) as AdDeliveryRow[];
    },

    async enqueue(leadId, ownerId, ldCustomerId, opts) {
      const admin = db();
      const nowIso = new Date().toISOString();
      const { data: inserted } = await admin
        .from('leaddb_ad_deliveries')
        .upsert(
          { lead_id: leadId, owner_id: ownerId, ld_customer_id: ldCustomerId, status: 'pending', next_attempt_at: nowIso },
          { onConflict: 'lead_id', ignoreDuplicates: true },
        )
        .select('lead_id');
      if ((inserted ?? []).length > 0) return 'inserted';
      if (!opts.reportFinal) return 'exists';
      const { data: again } = await admin
        .from('leaddb_ad_deliveries')
        .update({ status: 'pending', attempts: 0, next_attempt_at: nowIso, lease_until: null, last_error: null, updated_at: nowIso })
        .eq('lead_id', leadId)
        .eq('status', 'sent')
        .eq('phase_sent', 'lead')
        .select('lead_id');
      return (again ?? []).length > 0 ? 'repended' : 'exists';
    },

    async sweep(limit) {
      const admin = db();
      const out: { leadId: string; ownerId: string; ldCustomerId: string; reportFinal: boolean }[] = [];
      const floor = Date.now() - SWEEP_WINDOW_DAYS * 86_400_000;

      // 1. Sent rows whose report has since finished (done or failed): the report phase is owed.
      const { data: owed } = await admin
        .from('leaddb_ad_deliveries')
        .select('lead_id, owner_id, ld_customer_id')
        .eq('status', 'sent')
        .eq('phase_sent', 'lead')
        .gte('created_at', new Date(floor).toISOString())
        .limit(limit * 4);
      const owedRows = (owed ?? []) as { lead_id: string; owner_id: string; ld_customer_id: string }[];
      if (owedRows.length > 0) {
        const { data: fin } = await admin.from('website_reports').select('lead_id').in('state', ['done', 'failed']).in('lead_id', owedRows.map((r) => r.lead_id));
        const finSet = new Set(((fin ?? []) as { lead_id: string }[]).map((r) => r.lead_id));
        for (const r of owedRows) {
          if (out.length >= limit) break;
          if (finSet.has(r.lead_id)) out.push({ leadId: r.lead_id, ownerId: r.owner_id, ldCustomerId: r.ld_customer_id, reportFinal: true });
        }
      }

      // 2. Calculator leads of owners with an ad account that have no row (a lost enqueue), from the account's creation on.
      const { data: accounts } = await admin.from('leaddb_ad_accounts').select('owner_id, ld_customer_id, created_at').limit(200);
      for (const a of (accounts ?? []) as { owner_id: string; ld_customer_id: string; created_at: string | null }[]) {
        if (out.length >= limit) break;
        const since = new Date(Math.max(floor, a.created_at ? Date.parse(a.created_at) : floor)).toISOString();
        const { data: sites } = await admin.from('websites').select('id').eq('user_id', a.owner_id).eq('mode', 'calculator');
        const siteIds = ((sites ?? []) as { id: string }[]).map((s) => s.id);
        if (siteIds.length === 0) continue;
        const { data: reps } = await admin
          .from('website_reports')
          .select('lead_id, state')
          .in('website_id', siteIds)
          .gte('created_at', since)
          .order('created_at', { ascending: true })
          .limit(limit);
        const repRows = (reps ?? []) as { lead_id: string; state: string }[];
        if (repRows.length === 0) continue;
        const { data: have } = await admin.from('leaddb_ad_deliveries').select('lead_id').in('lead_id', repRows.map((r) => r.lead_id));
        const haveSet = new Set(((have ?? []) as { lead_id: string }[]).map((r) => r.lead_id));
        for (const r of repRows) {
          if (out.length >= limit) break;
          if (!haveSet.has(r.lead_id)) out.push({ leadId: r.lead_id, ownerId: a.owner_id, ldCustomerId: a.ld_customer_id, reportFinal: r.state === 'done' || r.state === 'failed' });
        }
      }
      return out;
    },

    async pendingPackNotices(limit) {
      const { data, error } = await db().from('leaddb_ad_accounts').select('owner_id, ld_customer_id').eq('pack_notice_pending', true).limit(limit);
      if (error) {
        console.error('[leaddb-ad] pack notice query failed:', error.code ?? 'error');
        return [];
      }
      return ((data ?? []) as { owner_id: string; ld_customer_id: string }[]).map((r) => ({ ownerId: r.owner_id, ldCustomerId: r.ld_customer_id }));
    },

    async packNoticeResult(ownerId, outcome) {
      const nowIso = new Date().toISOString();
      const { error } = await db()
        .from('leaddb_ad_accounts')
        .update({ pack_notice_pending: false, ...(outcome === 'done' ? { pack_notice_sent_at: nowIso } : {}), updated_at: nowIso })
        .eq('owner_id', ownerId);
      if (error) console.error('[leaddb-ad] pack notice result failed:', error.code ?? 'error');
    },
  };
}

/** The report PDF for a calculator lead, branded as its funnel. Null on any failure. */
async function renderPdf(ctx: AdLeadContext): Promise<Uint8Array | null> {
  if (!ctx.result) return null;
  const { data } = await db().from('leads').select('funnel_id').eq('id', ctx.leadId).maybeSingle();
  const funnelId = (data as { funnel_id: string | null } | null)?.funnel_id ?? null;
  const funnel = funnelId ? await getFunnel(ctx.ownerId, funnelId) : null;
  const brand = funnel ? await pdfBrandForFunnel(funnel.brand) : undefined;
  return renderReportPdf(ctx.result, { brand, preparedFor: ctx.email ?? undefined });
}

export function supabaseAdDeps(): AdDeliverDeps {
  if (!hasServiceRole()) throw new Error('service role not configured');
  return {
    store: supabaseAdStore(),
    post: (body) => postSigned('/api/internal/si/ad-leads', body as unknown as Record<string, unknown>),
    postPackNotice: (body) => postSigned('/api/internal/si/ad-pack-generated', body),
    renderPdf,
    now: () => new Date(),
  };
}
