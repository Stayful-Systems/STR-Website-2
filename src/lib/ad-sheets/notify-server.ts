import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { sendEmail, isEmailConfigured } from '../email/send';
import { brandedFrom } from '../email/from.ts';
import { escapeHtml } from '../email/escape.ts';
import { siteUrl } from '../url';

/**
 * Batch 35: the instant "new lead" email for a lead read from the operator's
 * Facebook lead-form sheet. No report is coming, so the email says so plainly.
 *
 * Same rules as the website lead's email (websites/notify-server.ts, which is
 * not edited): to the OPERATOR'S OWN login email only, once per lead through the
 * `leads.owner_notified_at` claim (set only while still null, cleared again when
 * the send fails), and off when the operator's website funnel has "Email me each
 * new lead" off (`funnels.notify_new_lead`). An operator with no website funnel
 * has no such setting: the column's default, on, applies.
 *
 * The email carries the name, email and phone the landlord gave and a link to
 * /leads/<id>: never an address, never a postcode. Nothing here logs a lead's
 * details: log lines carry the lead id only. NEVER THROWS.
 */

const UUID = /^[0-9a-f-]{36}$/i;

export type SheetNotifyResult = 'sent' | 'off' | 'already' | 'failed' | 'skipped';

const oneLine = (v: string | null | undefined, max: number) =>
  (v ?? '').replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The email's words (pure, so the lead's details are escaped in one place). */
export function sheetLeadEmail(i: { landlordName: string | null; landlordEmail: string | null; landlordPhone: string | null; leadUrl: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const who = oneLine(i.landlordName, 120) || 'A landlord';
  const subject = oneLine(`New landlord lead from your Facebook lead form: ${who}`, 200);
  const title = 'You have a new landlord lead';
  const intro = `${who} has just filled in your Facebook lead form. There is no income report for this lead: the details below are what they gave you.`;
  const rows: Array<[string, string]> = [
    ['Name', who],
    ...(i.landlordEmail ? ([['Email', oneLine(i.landlordEmail, 254)]] as Array<[string, string]>) : []),
    ...(i.landlordPhone ? ([['Phone', oneLine(i.landlordPhone, 40)]] as Array<[string, string]>) : []),
  ];
  const footer = 'You get this email for each new lead from your Facebook lead form.';
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f6f5f0;padding:24px;color:#1f2a1d">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e3da">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 16px">${escapeHtml(intro)}</p>
<table style="border-collapse:collapse;font-size:14px;width:100%">${rows
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 0">${escapeHtml(v)}</td></tr>`)
    .join('')}</table>
<p style="margin:20px 0 0"><a href="${escapeHtml(i.leadUrl)}" style="display:inline-block;background:#2E3D2B;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Open the lead</a></p>
<p style="font-size:12px;color:#6b7280;margin:24px 0 0">Stayful Intelligence. ${escapeHtml(footer)}</p>
</div></body></html>`;
  const text = [title, '', intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', `Open the lead: ${i.leadUrl}`, '', `Stayful Intelligence. ${footer}`].join('\n');
  return { subject, html, text };
}

/**
 * "New landlord lead", once per lead. The claim is made before anything is
 * sent and cleared again when the send fails, so a later call can try again;
 * a second call after a send gets 'already'.
 */
export async function notifySheetLead(leadId: string): Promise<SheetNotifyResult> {
  if (!hasServiceRole() || !isEmailConfigured() || !UUID.test(leadId)) return 'skipped';
  const admin = createAdminClient();
  try {
    const { data: lead, error: leadErr } = await admin.from('leads').select('user_id, funnel_id').eq('id', leadId).maybeSingle();
    if (leadErr) throw new Error('lead');
    if (!lead) return 'skipped';
    const { user_id: ownerId, funnel_id: funnelId } = lead as { user_id: string; funnel_id: string | null };

    // The setting, when the lead sits on a funnel (the operator's website funnel). No funnel: the default, on.
    if (funnelId) {
      const { data: f, error: fErr } = await admin.from('funnels').select('notify_new_lead').eq('id', funnelId).eq('user_id', ownerId).maybeSingle();
      if (fErr) throw new Error('funnel');
      if (!f) return 'skipped';
      if ((f as { notify_new_lead?: boolean }).notify_new_lead === false) return 'off';
    }

    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await admin
      .from('leads')
      .update({ owner_notified_at: nowIso })
      .eq('id', leadId)
      .eq('user_id', ownerId)
      .is('owner_notified_at', null)
      .select('name, email, phone')
      .maybeSingle();
    if (claimErr) throw new Error('claim');
    if (!claimed) return 'already';

    const release = async () => {
      await admin.from('leads').update({ owner_notified_at: null }).eq('id', leadId).eq('owner_notified_at', nowIso);
    };

    const { data: owner } = await admin.from('profiles').select('email').eq('id', ownerId).maybeSingle();
    const to = (owner as { email?: string | null } | null)?.email;
    if (!to || !to.includes('@')) {
      await release();
      return 'skipped';
    }
    const c = claimed as { name: string | null; email: string | null; phone: string | null };
    const copy = sheetLeadEmail({ landlordName: c.name, landlordEmail: c.email, landlordPhone: c.phone, leadUrl: siteUrl(`/leads/${leadId}`) });
    const from = brandedFrom(process.env.EMAIL_FROM, 'Stayful Intelligence') ?? undefined;
    const res = await sendEmail({ to, ...copy, ...(from ? { from } : {}), idempotencyKey: `sheet-new-lead:${leadId}` });
    if (!res.sent) {
      await release();
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error(`[ad-sheets] new-lead email for lead ${leadId} failed:`, err instanceof Error ? err.message : 'error');
    return 'failed';
  }
}
