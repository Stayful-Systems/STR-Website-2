import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { getFunnel } from '../funnels';
import { renderReportPdf, pdfBrandForFunnel } from '../pdf/render';
import { leadDbConfig, leadDbPushLead } from './client';
import { leadDbBadge } from './messages';
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
      // Batch 35: a lead read from a Facebook lead-form sheet has no report; it goes lead-only.
      let sheetLead = false;
      if (!report) {
        const { data: sheetRow } = await admin.from('ad_sheet_rows').select('lead_id').eq('lead_id', leadId).limit(1).maybeSingle();
        sheetLead = Boolean(sheetRow);
      }
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
        ...(sheetLead ? { sheetLead: true } : {}),
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

// ── What the screens read ──────────────────────────────────────────────────

export interface LeadDbPanelData {
  /** False when SI_LEAD_PUSH_SECRET or LEADDB_API_URL is unset or too weak: the panel says "not available yet". */
  available: boolean;
  link: {
    status: 'code_sent' | 'active' | 'revoked' | 'error';
    email: string;
    leadType: 'management' | 'guaranteed_rent' | null;
    lastError: string | null;
    connectedAt: string | null;
  } | null;
}

export async function leadDbPanelData(ownerId: string): Promise<LeadDbPanelData> {
  const available = leadDbConfig() !== null;
  if (!hasServiceRole()) return { available, link: null };
  const rec = await supabaseLinkStore().get(ownerId);
  return {
    available,
    link: rec ? { status: rec.status, email: rec.email, leadType: rec.lead_type, lastError: rec.last_error, connectedAt: rec.connected_at } : null,
  };
}

/** The badge text for each of these leads that went to the lead database (others are absent). One query. */
export async function leadDbBadges(leadIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (leadIds.length === 0 || !hasServiceRole()) return out;
  const { data } = await db().from('leaddb_deliveries').select('lead_id, status, lead_sent_at, report_sent_at, last_error').in('lead_id', leadIds);
  for (const r of (data ?? []) as { lead_id: string; status: 'pending' | 'sent' | 'failed'; lead_sent_at: string | null; report_sent_at: string | null; last_error: string | null }[]) {
    const badge = leadDbBadge({ deliveryStatus: r.status, leadSent: r.lead_sent_at !== null, reportSent: r.report_sent_at !== null, noReport: r.last_error === 'no_report_figures' });
    if (badge) out.set(r.lead_id, badge);
  }
  return out;
}

// ── Admin ──────────────────────────────────────────────────────────────────

export interface LeadDbProblem {
  leadId: string;
  ownerId: string;
  ownerEmail: string | null;
  status: 'pending' | 'failed';
  attempts: number;
  code: string | null;
  updatedAt: string;
}

/** Failed or stuck pushes from the last 14 days: ids, the error CODE and attempts. Never a lead's details. */
export async function leadDbProblems(): Promise<LeadDbProblem[]> {
  if (!hasServiceRole()) return [];
  const admin = db();
  const since = new Date(Date.now() - SWEEP_WINDOW_DAYS * 86_400_000).toISOString();
  const stuckBefore = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data } = await admin
    .from('leaddb_deliveries')
    .select('lead_id, owner_id, status, attempts, last_error, updated_at, next_attempt_at')
    .gte('updated_at', since)
    .or(`status.eq.failed,and(status.eq.pending,next_attempt_at.lt.${stuckBefore})`)
    .order('updated_at', { ascending: false })
    .limit(200);
  const rows = (data ?? []) as { lead_id: string; owner_id: string; status: 'pending' | 'failed'; attempts: number; last_error: string | null; updated_at: string }[];
  const owners = [...new Set(rows.map((r) => r.owner_id))];
  const { data: profiles } = owners.length ? await admin.from('profiles').select('id, email').in('id', owners) : { data: [] };
  const email = new Map(((profiles ?? []) as { id: string; email: string | null }[]).map((p) => [p.id, p.email]));
  return rows.map((r) => ({ leadId: r.lead_id, ownerId: r.owner_id, ownerEmail: email.get(r.owner_id) ?? null, status: r.status, attempts: r.attempts, code: r.last_error, updatedAt: r.updated_at }));
}

/** What a Retry would do, read only. */
export async function leadDbRetryPreview(leadId: string): Promise<{ ok: boolean; message: string }> {
  if (!hasServiceRole()) return { ok: false, message: 'The service role is not configured.' };
  const admin = db();
  const { data } = await admin.from('leaddb_deliveries').select('owner_id, status, attempts, last_error').eq('lead_id', leadId).maybeSingle();
  const row = data as { owner_id: string; status: string; attempts: number; last_error: string | null } | null;
  if (!row) return { ok: false, message: 'No push is recorded for that lead.' };
  if (row.status === 'sent') return { ok: false, message: 'That push already went through. Nothing to retry.' };
  const { data: link } = await admin.from('leaddb_links').select('status').eq('owner_id', row.owner_id).maybeSingle();
  const status = (link as { status: string } | null)?.status ?? null;
  if (status !== 'active') {
    return { ok: false, message: `The owner's lead database link is ${status ?? 'not set up'}, so a retry would fail again. They need to connect it first (it retries by itself once they do).` };
  }
  return { ok: true, message: `Would reset ${row.attempts} attempt${row.attempts === 1 ? '' : 's'} (last error: ${row.last_error ?? 'none'}) and send this lead again on the next run, within about 10 minutes.` };
}

/** Resets one failed or stuck push so the next run sends it. */
export async function leadDbRetry(leadId: string): Promise<boolean> {
  if (!hasServiceRole()) return false;
  const nowIso = new Date().toISOString();
  const { data } = await db()
    .from('leaddb_deliveries')
    .update({ status: 'pending', attempts: 0, next_attempt_at: nowIso, lease_until: null, last_error: null, updated_at: nowIso })
    .eq('lead_id', leadId)
    .in('status', ['pending', 'failed'])
    .select('lead_id');
  return (data ?? []).length > 0;
}
