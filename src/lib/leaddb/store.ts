import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { getFunnel } from '../funnels';
import { renderReportPdf, pdfBrandForFunnel } from '../pdf/render';
import { leadDbPushLead } from './client';
import type { DeliveryRow, FinishPatch, LeadContext, LeadDbDeps, LeadDbStore, LinkState } from './deliver';
import { realLinkClient, type LinkDeps, type LinkRecord, type LinkStore } from './links';
import type { AnalysisResult } from '../types';

/**
 * The real database behind the lead database push (Batch 32). Service role
 * only: `leaddb_links` and `leaddb_deliveries` have RLS on with no policy.
 *
 * Nothing here writes `leads.status` or `leads.crm_pushed_at`.
 */

const DELIVERY_COLUMNS = 'lead_id, owner_id, attempts, lead_sent_at, report_sent_at, leaddb_lead_id';
/** The sweep never reaches back past this: a lead older than a fortnight is not a surprise to push. */
const SWEEP_WINDOW_DAYS = 14;

const db = () => createAdminClient();

export function supabaseStore(): LeadDbStore {
  return {
    async claim(leadId, nowIso, leaseUntilIso) {
      const { data, error } = await db()
        .from('leaddb_deliveries')
        .update({ lease_until: leaseUntilIso, updated_at: nowIso })
        .eq('lead_id', leadId)
        .eq('status', 'pending')
        .lte('next_attempt_at', nowIso)
        .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
        .select(DELIVERY_COLUMNS)
        .maybeSingle();
      if (error) {
        console.error('[leaddb] claim failed:', error.code ?? 'error');
        return null;
      }
      return (data as DeliveryRow | null) ?? null;
    },

    async context(leadId): Promise<LeadContext | null> {
      const admin = db();
      const { data } = await admin
        .from('leads')
        .select('id, user_id, status, archived_at, name, email, phone, address, postcode, bedrooms, result')
        .eq('id', leadId)
        .maybeSingle();
      if (!data) return null;
      const lead = data as {
        id: string; user_id: string; status: string | null; archived_at: string | null; name: string | null; email: string | null;
        phone: string | null; address: string | null; postcode: string | null; bedrooms: number | null; result: AnalysisResult | null;
      };
      const { data: rep } = await admin.from('website_reports').select('state, quality_ok').eq('lead_id', leadId).maybeSingle();
      const report = rep as { state: string; quality_ok: boolean | null } | null;
      return {
        leadId: lead.id,
        ownerId: lead.user_id,
        status: lead.status,
        archivedAt: lead.archived_at,
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        address: lead.address,
        postcode: lead.postcode,
        bedrooms: lead.bedrooms,
        result: lead.result,
        report: report ? { state: report.state, qualityOk: report.quality_ok } : null,
      };
    },

    async link(ownerId): Promise<LinkState | null> {
      const { data } = await db().from('leaddb_links').select('owner_id, status').eq('owner_id', ownerId).maybeSingle();
      const row = data as { owner_id: string; status: LinkState['status'] } | null;
      return row ? { ownerId: row.owner_id, status: row.status } : null;
    },

    async finish(leadId, patch: FinishPatch, claimedAttempts) {
      const { error } = await db()
        .from('leaddb_deliveries')
        .update({ ...patch, lease_until: null, updated_at: new Date().toISOString() })
        .eq('lead_id', leadId)
        .eq('attempts', claimedAttempts);
      if (error) console.error('[leaddb] finish failed:', error.code ?? 'error');
    },

    async linkResult(ownerId, result) {
      const nowIso = new Date().toISOString();
      const admin = db();
      if (result.ok) {
        await admin.from('leaddb_links').update({ last_ok_at: nowIso, last_error: null, updated_at: nowIso }).eq('owner_id', ownerId).eq('status', 'active');
        await admin.from('leaddb_links').update({ status: 'active', last_ok_at: nowIso, last_error: null, updated_at: nowIso }).eq('owner_id', ownerId).eq('status', 'error');
        return;
      }
      await admin.from('leaddb_links').update({ status: 'error', last_error: result.code, updated_at: nowIso }).eq('owner_id', ownerId).eq('status', 'active');
    },

    async due(limit, nowIso) {
      const { data, error } = await db()
        .from('leaddb_deliveries')
        .select(DELIVERY_COLUMNS)
        .eq('status', 'pending')
        .lte('next_attempt_at', nowIso)
        .order('next_attempt_at', { ascending: true })
        .limit(limit);
      if (error) {
        console.error('[leaddb] drain query failed:', error.code ?? 'error');
        return [];
      }
      return (data ?? []) as DeliveryRow[];
    },

    async enqueue(leadId, ownerId, opts) {
      const admin = db();
      const nowIso = new Date().toISOString();
      const { data: inserted } = await admin
        .from('leaddb_deliveries')
        .upsert({ lead_id: leadId, owner_id: ownerId, status: 'pending', next_attempt_at: nowIso }, { onConflict: 'lead_id', ignoreDuplicates: true })
        .select('lead_id');
      if ((inserted ?? []).length > 0) return 'inserted';
      if (!opts.reportDone) return 'exists';
      const { data: again } = await admin
        .from('leaddb_deliveries')
        .update({ status: 'pending', attempts: 0, next_attempt_at: nowIso, lease_until: null, last_error: null, updated_at: nowIso })
        .eq('lead_id', leadId)
        .eq('status', 'sent')
        .is('report_sent_at', null)
        .select('lead_id');
      return (again ?? []).length > 0 ? 'repended' : 'exists';
    },

    async unqueued(limit) {
      const admin = db();
      const { data: links } = await admin.from('leaddb_links').select('owner_id, connected_at').eq('status', 'active').limit(200);
      const out: { leadId: string; ownerId: string }[] = [];
      const floor = Date.now() - SWEEP_WINDOW_DAYS * 86_400_000;
      for (const l of (links ?? []) as { owner_id: string; connected_at: string | null }[]) {
        if (out.length >= limit) break;
        // Only leads from the connection onward: connecting must not pour the back catalogue into someone's account.
        const since = new Date(Math.max(floor, l.connected_at ? Date.parse(l.connected_at) : floor)).toISOString();
        const { data: leads } = await admin
          .from('leads')
          .select('id, website_reports!inner(state)')
          .eq('user_id', l.owner_id)
          .is('archived_at', null)
          .neq('status', 'held')
          .gte('created_at', since)
          .order('created_at', { ascending: true })
          .limit(limit);
        const ids = ((leads ?? []) as { id: string }[]).map((r) => r.id);
        if (ids.length === 0) continue;
        const { data: have } = await admin.from('leaddb_deliveries').select('lead_id').in('lead_id', ids);
        const haveSet = new Set(((have ?? []) as { lead_id: string }[]).map((r) => r.lead_id));
        for (const id of ids) if (!haveSet.has(id) && out.length < limit) out.push({ leadId: id, ownerId: l.owner_id });
      }
      return out;
    },

    async reportsOwed(limit) {
      const admin = db();
      const { data } = await admin
        .from('leaddb_deliveries')
        .select('lead_id, owner_id')
        .eq('status', 'sent')
        .is('report_sent_at', null)
        .is('last_error', null)
        .gte('created_at', new Date(Date.now() - SWEEP_WINDOW_DAYS * 86_400_000).toISOString())
        .limit(limit * 4);
      const rows = (data ?? []) as { lead_id: string; owner_id: string }[];
      if (rows.length === 0) return [];
      const { data: done } = await admin.from('website_reports').select('lead_id').eq('state', 'done').in('lead_id', rows.map((r) => r.lead_id));
      const doneSet = new Set(((done ?? []) as { lead_id: string }[]).map((r) => r.lead_id));
      return rows.filter((r) => doneSet.has(r.lead_id)).slice(0, limit).map((r) => ({ leadId: r.lead_id, ownerId: r.owner_id }));
    },
  };
}

/** The report PDF for a website lead, branded as its funnel. Null on any failure. */
async function renderPdf(ctx: LeadContext): Promise<Uint8Array | null> {
  if (!ctx.result) return null;
  const { data } = await db().from('leads').select('funnel_id').eq('id', ctx.leadId).maybeSingle();
  const funnelId = (data as { funnel_id: string | null } | null)?.funnel_id ?? null;
  const funnel = funnelId ? await getFunnel(ctx.ownerId, funnelId) : null;
  const brand = funnel ? await pdfBrandForFunnel(funnel.brand) : undefined;
  return renderReportPdf(ctx.result, { brand, preparedFor: ctx.email ?? undefined });
}

export function supabaseDeps(): LeadDbDeps {
  if (!hasServiceRole()) throw new Error('service role not configured');
  return { store: supabaseStore(), post: (body) => leadDbPushLead(body), renderPdf, now: () => new Date() };
}

// ── Links ──────────────────────────────────────────────────────────────────

const LINK_COLUMNS = 'owner_id, link_id, email, lead_type, status, connected_at, last_ok_at, last_error';

export function supabaseLinkStore(): LinkStore {
  return {
    async get(ownerId) {
      const { data } = await db().from('leaddb_links').select(LINK_COLUMNS).eq('owner_id', ownerId).maybeSingle();
      return (data as LinkRecord | null) ?? null;
    },
    async saveCodeSent(ownerId, linkId, email) {
      const nowIso = new Date().toISOString();
      await db()
        .from('leaddb_links')
        .upsert(
          { owner_id: ownerId, link_id: linkId, email, status: 'code_sent', lead_type: null, last_error: null, updated_at: nowIso },
          { onConflict: 'owner_id' },
        );
    },
    async saveActive(ownerId, leadType) {
      const nowIso = new Date().toISOString();
      await db()
        .from('leaddb_links')
        .update({ status: 'active', lead_type: leadType, connected_at: nowIso, last_ok_at: nowIso, last_error: null, updated_at: nowIso })
        .eq('owner_id', ownerId);
      // Leads that failed only because there was no link (it was revoked or never confirmed) get another go now.
      await db()
        .from('leaddb_deliveries')
        .update({ status: 'pending', attempts: 0, next_attempt_at: nowIso, lease_until: null, last_error: null, updated_at: nowIso })
        .eq('owner_id', ownerId)
        .eq('status', 'failed')
        .eq('last_error', 'not_linked');
    },
    async saveRevoked(ownerId) {
      const nowIso = new Date().toISOString();
      await db().from('leaddb_links').update({ status: 'revoked', updated_at: nowIso }).eq('owner_id', ownerId);
    },
    async saveError(ownerId, code) {
      await db().from('leaddb_links').update({ last_error: code, updated_at: new Date().toISOString() }).eq('owner_id', ownerId);
    },
  };
}

export function supabaseLinkDeps(): LinkDeps {
  if (!hasServiceRole()) throw new Error('service role not configured');
  return { store: supabaseLinkStore(), ...realLinkClient, randomId: () => crypto.randomUUID() };
}
