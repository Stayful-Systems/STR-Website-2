import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { sendEmail, isEmailConfigured } from '../email/send';
import { brandedFrom, safeReplyTo } from '../email/from.ts';
import {
  landlordHeldEmail,
  landlordSummaryEmail,
  landlordWillContactEmail,
  operatorNewLeadEmail,
  operatorReportFailedEmail,
  type LandlordEmailBrand,
  type OperatorLeadInput,
} from '../email/website.ts';
import type { EmailCopy } from '../email/new-lead.ts';
import { siteUrl } from '../url';
import { parseSiteSettings } from './store-server';
import type { ReportSummary } from './summary.ts';

/**
 * Batch 31: the emails a customer website sends. The wording is pure
 * (src/lib/email/website.ts); this sends it.
 *
 * To the OPERATOR (the member who owns the site), from Stayful Intelligence,
 * only to their own login email:
 *   notifyOperatorOfWebsiteLead   "New landlord lead", at step 1. Once per lead
 *                                 through the same owner_notified_at claim the
 *                                 funnel's new-lead email uses (set only while
 *                                 still null, cleared when the send fails). Off
 *                                 when the website funnel's "Email me each new
 *                                 lead" is off. Step-1 details and a link to
 *                                 /leads/<id>: never an address.
 *   notifyOperatorReportFailed    the report could not be run after every try.
 *
 * To the LANDLORD who filled in the form, in the operator's name, never a
 * link to the full report (/r/<token>) and never an address:
 *   sendLandlordEmail             summary | held | will_contact
 *
 * Nothing here logs a lead's details: log lines carry the lead id only.
 * Every send is best effort and never throws: a missing email costs the
 * landlord a message, never the lead or the report.
 */

const UUID = /^[0-9a-f-]{36}$/i;

type Admin = ReturnType<typeof createAdminClient>;

export type OperatorSendResult = 'sent' | 'off' | 'already' | 'failed' | 'skipped';
export type LandlordKind = 'summary' | 'held' | 'will_contact';
export type LandlordSendResult = 'sent' | 'failed' | 'skipped';

/** What an email needs of a lead's website: the operator's id, company and contact details. */
interface SiteFacts {
  websiteId: string;
  ownerId: string;
  funnelId: string;
  company: string;
  logoUrl: string | null;
  primary: string | null;
  contactEmail: string;
}

async function siteFactsFor(admin: Admin, leadId: string, knownWebsiteId?: string): Promise<SiteFacts | null> {
  let websiteId = knownWebsiteId && UUID.test(knownWebsiteId) ? knownWebsiteId : undefined;
  if (!websiteId) {
    const { data: report } = await admin.from('website_reports').select('website_id').eq('lead_id', leadId).maybeSingle();
    websiteId = (report as { website_id?: string } | null)?.website_id;
  }
  if (!websiteId) return null;
  const { data: site } = await admin.from('websites').select('id, user_id, funnel_id, settings').eq('id', websiteId).maybeSingle();
  if (!site) return null;
  const row = site as { id: string; user_id: string; funnel_id: string; settings: unknown };
  const s = parseSiteSettings(row.settings);
  return {
    websiteId: row.id,
    ownerId: row.user_id,
    funnelId: row.funnel_id,
    company: s.companyName,
    logoUrl: s.logoUrl,
    primary: s.brandColour,
    contactEmail: s.contactEmail,
  };
}

const operatorFrom = () => brandedFrom(process.env.EMAIL_FROM, 'Stayful Intelligence') ?? undefined;

// ── To the operator ──

interface LeadContactRow {
  name: string | null;
  email: string | null;
  phone: string | null;
}

function operatorInput(site: SiteFacts, leadId: string, lead: LeadContactRow): OperatorLeadInput {
  return {
    company: site.company,
    landlordName: lead.name,
    landlordEmail: lead.email,
    landlordPhone: lead.phone,
    leadUrl: siteUrl(`/leads/${leadId}`),
    // The member manages the website in the setup flow inside Leads.
    manageUrl: siteUrl('/leads/setup/website'),
  };
}

async function operatorEmailOf(admin: Admin, ownerId: string): Promise<string | null> {
  const { data } = await admin.from('profiles').select('email').eq('id', ownerId).maybeSingle();
  const to = (data as { email?: string | null } | null)?.email;
  return to && to.includes('@') ? to : null;
}

/**
 * "New landlord lead", once per lead. The claim is made before anything is
 * sent and cleared again when the send fails, so the next call can try again;
 * a second call after a send gets 'already'.
 */
export async function notifyOperatorOfWebsiteLead(o: { leadId: string; websiteId?: string }): Promise<OperatorSendResult> {
  if (!hasServiceRole() || !isEmailConfigured() || !UUID.test(o.leadId)) return 'skipped';
  const admin = createAdminClient();
  try {
    const site = await siteFactsFor(admin, o.leadId, o.websiteId);
    if (!site) return 'skipped';

    // The setting, read on its own so a database behind on the schema reads "on".
    const { data: f, error: fErr } = await admin.from('funnels').select('notify_new_lead').eq('id', site.funnelId).eq('user_id', site.ownerId).maybeSingle();
    if (fErr) throw new Error(fErr.message);
    if (!f) return 'skipped';
    if ((f as { notify_new_lead?: boolean }).notify_new_lead === false) return 'off';

    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await admin
      .from('leads')
      .update({ owner_notified_at: nowIso })
      .eq('id', o.leadId)
      .eq('user_id', site.ownerId)
      .is('owner_notified_at', null)
      .select('name, email, phone')
      .maybeSingle();
    if (claimErr) throw new Error(claimErr.message);
    if (!claimed) return 'already';

    const release = async () => {
      await admin.from('leads').update({ owner_notified_at: null }).eq('id', o.leadId).eq('owner_notified_at', nowIso);
    };

    const to = await operatorEmailOf(admin, site.ownerId);
    if (!to) {
      await release();
      return 'skipped';
    }
    const copy = operatorNewLeadEmail(operatorInput(site, o.leadId, claimed as LeadContactRow));
    const from = operatorFrom();
    const res = await sendEmail({ to, ...copy, ...(from ? { from } : {}), idempotencyKey: `website-new-lead:${o.leadId}` });
    if (!res.sent) {
      await release();
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error(`[website-notify] new-lead email for lead ${o.leadId} failed:`, err instanceof Error ? err.name : 'error');
    return 'failed';
  }
}

/**
 * The report could not be run after every try: tell the operator to follow the
 * landlord up. Sent whatever the "email me each new lead" setting says (it is
 * a problem to act on, not a notification), once per lead by its idempotency key.
 */
export async function notifyOperatorReportFailed(o: { leadId: string }): Promise<OperatorSendResult> {
  if (!hasServiceRole() || !isEmailConfigured() || !UUID.test(o.leadId)) return 'skipped';
  const admin = createAdminClient();
  try {
    const site = await siteFactsFor(admin, o.leadId);
    if (!site) return 'skipped';
    const { data: lead } = await admin.from('leads').select('name, email, phone').eq('id', o.leadId).eq('user_id', site.ownerId).maybeSingle();
    if (!lead) return 'skipped';
    const to = await operatorEmailOf(admin, site.ownerId);
    if (!to) return 'skipped';
    const copy = operatorReportFailedEmail(operatorInput(site, o.leadId, lead as LeadContactRow));
    const from = operatorFrom();
    const res = await sendEmail({ to, ...copy, ...(from ? { from } : {}), idempotencyKey: `website-failed:${o.leadId}` });
    return res.sent ? 'sent' : 'failed';
  } catch (err) {
    console.error(`[website-notify] failure notice for lead ${o.leadId} failed:`, err instanceof Error ? err.name : 'error');
    return 'failed';
  }
}

// ── To the landlord ──

const LANDLORD_KEYS: Record<LandlordKind, string> = {
  summary: 'website-summary',
  held: 'website-held',
  will_contact: 'website-contact',
};

/**
 * The landlord's email, in the operator's name: figures only (`summary` is
 * buildSummary's, never the report), the 24-hour message, or "will be in
 * touch". The caller sends each kind at most once per lead (it wins a state
 * transition first); the idempotency key (`website-summary:<lead>`,
 * `website-held:<lead>`, `website-contact:<lead>`) is the second guard.
 * 'summary' with no summary reads as 'will_contact': a report with no figures
 * is never shown as a number.
 */
export async function sendLandlordEmail(o: { leadId: string; kind: LandlordKind; summary?: ReportSummary | null }): Promise<LandlordSendResult> {
  if (!hasServiceRole() || !isEmailConfigured() || !UUID.test(o.leadId)) return 'skipped';
  const admin = createAdminClient();
  try {
    const site = await siteFactsFor(admin, o.leadId);
    if (!site) return 'skipped';
    // Scoped to the website's owner, and read for the contact details only: no address is selected.
    const { data: lead } = await admin.from('leads').select('name, email').eq('id', o.leadId).eq('user_id', site.ownerId).maybeSingle();
    const row = lead as { name: string | null; email: string | null } | null;
    if (!row?.email) return 'skipped';

    // A neutral sending identity when one is set; otherwise the operator's name on our address.
    const from = brandedFrom(process.env.EMAIL_FROM_WHITELABEL || process.env.EMAIL_FROM, site.company);
    if (!from) return 'skipped';
    const replyTo = safeReplyTo(site.contactEmail);
    const brand: LandlordEmailBrand = { company: site.company, logoUrl: site.logoUrl, primary: site.primary, canReply: Boolean(replyTo) };

    const kind: LandlordKind = o.kind === 'summary' && !o.summary ? 'will_contact' : o.kind;
    let copy: EmailCopy;
    if (kind === 'summary' && o.summary) copy = landlordSummaryEmail({ brand, landlordName: row.name, summary: o.summary });
    else if (kind === 'held') copy = landlordHeldEmail({ brand, landlordName: row.name });
    else copy = landlordWillContactEmail({ brand, landlordName: row.name });

    const res = await sendEmail({
      to: row.email,
      ...copy,
      from,
      ...(replyTo ? { replyTo } : {}),
      idempotencyKey: `${LANDLORD_KEYS[kind]}:${o.leadId}`,
    });
    return res.sent ? 'sent' : 'failed';
  } catch (err) {
    console.error(`[website-notify] ${o.kind} email for lead ${o.leadId} failed:`, err instanceof Error ? err.name : 'error');
    return 'failed';
  }
}
