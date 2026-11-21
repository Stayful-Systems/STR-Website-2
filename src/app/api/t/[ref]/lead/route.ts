import { after } from 'next/server';
import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin';
import { ACCESS_COLUMNS, type AccessProfile } from '@/lib/access';
import { countAttempt } from '@/lib/funnels/caps';
import { captureLead } from '@/lib/leads/store';
import { enqueueLeadDbPush } from '@/lib/leaddb/deliver';
import { notifyOperatorOfWebsiteLead } from '@/lib/websites/notify-server';
import { runWebsiteReport } from '@/lib/websites/report-server';
import { parseSiteSettings } from '@/lib/websites/store-server';
import { inputColumns, takeExportedLead, type IntakeDeps, type IntakeOutcome } from '@/lib/websites/transfer-intake';

/**
 * Batch 37, Phase 6: POST /api/t/<ref>/lead, the form of an EXPORTED website.
 *
 * The operator took their site as plain files; its form posts here as an
 * ordinary HTML form (application/x-www-form-urlencoded), from a page on the
 * operator's own host. No JavaScript, no JSON, no Turnstile, no CORS: a form
 * post is a navigation, and the answer is a 303 to our own thank-you page,
 * /t/<ref>/thanks?r=<outcome>.
 *
 * It works whether or not our copy of the site is live, paused or switched
 * off, and for as long as the transfer is not cancelled. What it does with the
 * post is src/lib/websites/transfer-intake.ts (read its header for the order).
 * This file only reads the body and the IP and wires the real dependencies.
 *
 * Nothing here logs the body, the contact details or the address; log lines
 * carry a lead id and an error name at most.
 */

export const maxDuration = 60;

const MAX_BODY_BYTES = 16 * 1024;
const REF = /^[a-z0-9]{16,64}$/;

function back(ref: string, outcome: IntakeOutcome): Response {
  // A relative address: the browser follows it on the host the form was posted to.
  return new Response(null, { status: 303, headers: { Location: `/t/${ref}/thanks?r=${outcome}`, 'Cache-Control': 'no-store' } });
}

/** The decoded form, string values only, or null when the body is not a small urlencoded form. */
async function readForm(request: Request): Promise<Record<string, string> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return null;
  const length = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return null;
  }
  if (raw.length > MAX_BODY_BYTES) return null;
  const form: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) if (!(k in form)) form[k] = v;
  return form;
}

const errName = (err: unknown) => (err instanceof Error ? err.name : 'error');

function realDeps(): IntakeDeps {
  const admin = createAdminClient();
  return {
    now: () => new Date(),
    loadTransfer: async (ref) => {
      const { data: t, error } = await admin.from('website_transfers').select('id, website_id, cancelled_at').eq('ref', ref).maybeSingle();
      if (error || !t) return null;
      const transfer = t as { id: string; website_id: string; cancelled_at: string | null };
      // The stub row, whatever its status: a paused or switched-off site still takes the form.
      const { data: w } = await admin.from('websites').select('id, user_id, funnel_id, settings').eq('id', transfer.website_id).maybeSingle();
      if (!w) return null;
      const site = w as { id: string; user_id: string; funnel_id: string; settings: unknown };
      const settings = parseSiteSettings(site.settings);
      return {
        transferId: transfer.id,
        cancelled: transfer.cancelled_at !== null,
        site: { id: site.id, userId: site.user_id, funnelId: site.funnel_id, contactEmail: settings.contactEmail, contactPhone: settings.contactPhone },
      };
    },
    dailyCapOf: async (funnelId, userId) => {
      const { data } = await admin.from('funnels').select('daily_cap').eq('id', funnelId).eq('user_id', userId).eq('kind', 'website').maybeSingle();
      return data ? Number((data as { daily_cap?: unknown }).daily_cap) || 100 : null;
    },
    countAttempt,
    recentLeadId: async ({ funnelId, userId, email, since }) => {
      const { data, error } = await admin
        .from('leads')
        .select('id')
        .eq('funnel_id', funnelId)
        .eq('user_id', userId)
        .eq('email', email)
        .is('archived_at', null)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) console.error('[transfer-lead] reuse check failed:', error.code ?? 'error');
      return data ? (data as { id: string }).id : null;
    },
    captureLead: async (input) => {
      const captured = await captureLead(input);
      return captured ? { id: captured.id } : null;
    },
    saveSources: async (leadId, sources) => {
      const { error } = await admin.from('lead_sources').upsert({ lead_id: leadId, ...sources }, { onConflict: 'lead_id', ignoreDuplicates: true });
      if (error) console.error(`[transfer-lead] sources not saved for lead ${leadId}:`, error.code ?? 'error');
    },
    ownerContact: async (ownerId) => {
      const { data } = await admin.from('profiles').select('email, mobile').eq('id', ownerId).maybeSingle();
      const row = data as { email?: string | null; mobile?: string | null } | null;
      return { email: row?.email ?? null, phone: row?.mobile ?? null };
    },
    saveReportRow: async ({ leadId, websiteId, selfSubmit }) => {
      const { error } = await admin
        .from('website_reports')
        .upsert({ lead_id: leadId, website_id: websiteId, state: 'awaiting_address', self_submit: selfSubmit }, { onConflict: 'lead_id', ignoreDuplicates: true });
      if (error) console.error(`[transfer-lead] report row not saved for lead ${leadId}:`, error.code ?? 'error');
    },
    reportState: async (leadId) => {
      const { data } = await admin.from('website_reports').select('state').eq('lead_id', leadId).maybeSingle();
      return (data as { state?: string } | null)?.state ?? null;
    },
    enqueueLeadDbPush,
    notifyOperator: notifyOperatorOfWebsiteLead,
    ownerProfile: async (ownerId) => {
      const { data } = await admin.from('profiles').select(ACCESS_COLUMNS).eq('id', ownerId).maybeSingle();
      return (data as unknown as AccessProfile | null) ?? null;
    },
    saveInput: async ({ leadId, userId, funnelId, input }) => {
      // First writer wins, as the live report route does: a lead that already holds an input keeps it.
      const { data, error } = await admin.from('leads').update(inputColumns(input)).eq('id', leadId).eq('user_id', userId).eq('funnel_id', funnelId).is('input', null).select('id');
      if (error) console.error(`[transfer-lead] input not saved for lead ${leadId}:`, error.code ?? 'error');
      // False when nothing changed (the lead already holds an input): that lead is not run a second time.
      return !error && (data?.length ?? 0) > 0;
    },
    runReportLater: (leadId) => {
      after(async () => {
        try {
          await runWebsiteReport(leadId);
        } catch (err) {
          // An error name only: the cron retakes the lease.
          console.error(`[transfer-lead] report run failed for lead ${leadId}:`, errName(err));
        }
      });
    },
    log: (line) => console.error(line),
  };
}

export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  if (!REF.test(ref)) return new Response('Not found', { status: 404 });
  if (!hasServiceRole()) return back(ref, 'wait');

  const form = await readForm(request);
  if (!form) return back(ref, 'check');

  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || 'unknown';

  try {
    const result = await takeExportedLead({ ref, ip, form }, realDeps());
    if (result.kind === 'not_found') return new Response('Not found', { status: 404 });
    return back(ref, result.outcome);
  } catch (err) {
    console.error('[transfer-lead] post failed:', errName(err));
    return back(ref, 'wait');
  }
}
