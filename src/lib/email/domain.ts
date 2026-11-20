import { escapeHtml } from './escape.ts';
import type { EmailCopy } from './new-lead.ts';

/**
 * Batch 33: the emails the website domains send.
 *
 * To the MEMBER, from Stayful Intelligence:
 *   domainLiveEmail   "Your website is live at https://…": once, when the
 *                     member's own address is working. The old /s/<slug>
 *                     address now redirects there.
 *
 * To the ADMIN (adminEmails()), one email per event, never one per run:
 *   domainStuckEmail      a domain has sat in one unfinished state for 24 hours
 *   domainRenewalEmail    a domain is within 30 days of expiry (once per domain per period)
 *   domainAutoRenewEmail  the 7-day rule renewed (or could not renew) a domain
 *
 * Nothing here takes a price, a registrar reference or an error body: a
 * member never sees the cost, and an admin email names the domain, the state
 * and where to act. The domain name is the only thing a member chose; it is
 * escaped like everything else and its address is built by the caller.
 *
 * Pure: the engine (purchase-server.ts) and the cron send them.
 */

const GREEN = '#2E3D2B';

/** One line, no control characters, bounded: safe in a subject or a heading. */
function oneLine(v: string | null | undefined, max = 120): string {
  return (v ?? '').replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function shell(title: string, bodyHtml: string, footer: string): string {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f6f5f0;padding:24px;color:#1f2a1d">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e3da">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>
${bodyHtml}
<p style="font-size:12px;color:#6b7280;margin:24px 0 0">${escapeHtml(footer)}</p>
</div></body></html>`;
}

const p = (text: string) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${escapeHtml(text)}</p>`;
const button = (href: string, label: string) =>
  `<p style="margin:20px 0 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:${GREEN};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(label)}</a></p>`;

export interface DomainLiveInput {
  /** The member's company name. */
  company: string;
  /** The live address, https://<domain>/ . */
  address: string;
  /** The old address that now redirects, https://…/s/<slug> . */
  oldAddress: string;
  /** Where the member sees their leads. */
  leadsUrl: string;
}

export function domainLiveEmail(i: DomainLiveInput): EmailCopy {
  const company = oneLine(i.company, 80) || 'Your company';
  const subject = oneLine(`Your website is live at ${i.address}`, 200);
  const lines = [
    `${company}'s website now has its own address: ${i.address}`,
    `Share that one. The temporary address (${i.oldAddress}) now sends visitors there, so any link you have already shared keeps working.`,
    'Landlords who visit can ask for a free estimate, and their details land in Leads.',
  ];
  const html = shell(
    'Your website is live',
    [p(lines[0]), button(i.address, 'Open your website'), `<p style="font-size:15px;line-height:1.5;margin:16px 0 12px">${escapeHtml(lines[1])}</p>`, p(lines[2]), `<p style="font-size:14px;margin:0 0 12px"><a href="${escapeHtml(i.leadsUrl)}" style="color:${GREEN};font-weight:600">See your leads</a></p>`].join('\n'),
    'Stayful Intelligence. The address is registered and looked after by Stayful, and is free for the first year.',
  );
  const text = ['Your website is live', '', lines[0], '', lines[1], '', lines[2], '', `See your leads: ${i.leadsUrl}`, '', 'Stayful Intelligence. The address is registered and looked after by Stayful, and is free for the first year.'].join('\n');
  return { subject, html, text };
}

export interface AdminDomainInput {
  /** The domain, e.g. harbourmanagement.co.uk. */
  domain: string;
  /** The admin Domains panel. */
  panelUrl: string;
}

export interface StuckInput extends AdminDomainInput {
  status: string;
  hours: number;
}

export function domainStuckEmail(i: StuckInput): EmailCopy {
  const d = oneLine(i.domain, 100);
  const subject = oneLine(`Website domain stuck: ${d} (${i.status})`, 200);
  const lines = [
    `${d} has been "${oneLine(i.status, 40)}" for over ${Math.round(i.hours)} hours.`,
    'Open the Domains panel to see the last error and why, and to Retry, Buy or Release it.',
  ];
  const html = shell('A website domain is stuck', [p(lines[0]), p(lines[1]), button(i.panelUrl, 'Open the Domains panel')].join('\n'), 'You get this once for each stuck domain.');
  return { subject, html, text: [lines[0], '', lines[1], '', `Domains panel: ${i.panelUrl}`, '', 'You get this once for each stuck domain.'].join('\n') };
}

export interface RenewalInput extends AdminDomainInput {
  /** The expiry date, e.g. "20 November 2027". */
  expires: string;
  /** Whole days left. */
  days: number;
  /** The date the 7-day rule will renew it if nobody decides, e.g. "13 November 2027". */
  autoRenewOn: string;
}

export function domainRenewalEmail(i: RenewalInput): EmailCopy {
  const d = oneLine(i.domain, 100);
  const subject = oneLine(`Website domain renewal due: ${d}`, 200);
  const lines = [
    `${d} expires on ${oneLine(i.expires, 40)} (${Math.max(0, Math.round(i.days))} days).`,
    `Choose Renew or Don't renew in the Domains panel. If nobody decides, it renews on ${oneLine(i.autoRenewOn, 40)} only if the website is live and not switched off, and the renewal fits within the daily cap.`,
  ];
  const html = shell('A website domain is due for renewal', [p(lines[0]), p(lines[1]), button(i.panelUrl, 'Open the Domains panel')].join('\n'), 'You get this once for each domain each year.');
  return { subject, html, text: [lines[0], '', lines[1], '', `Domains panel: ${i.panelUrl}`, '', 'You get this once for each domain each year.'].join('\n') };
}

export interface AutoRenewInput extends AdminDomainInput {
  outcome: 'renewed' | 'held' | 'skipped';
  /** Why a skipped or held one did not renew, in a few plain words. */
  reason: string | null;
}

export function domainAutoRenewEmail(i: AutoRenewInput): EmailCopy {
  const d = oneLine(i.domain, 100);
  const what = i.outcome === 'renewed' ? 'was renewed automatically' : i.outcome === 'held' ? 'could not be renewed yet' : 'was not renewed';
  const subject = oneLine(`Website domain ${what}: ${d}`, 200);
  const lines = [`${d} ${what}.`, ...(i.reason ? [oneLine(i.reason, 200)] : []), 'Nobody had chosen Renew or Not renew in the Domains panel seven days before it expired.'];
  const html = shell(`A website domain ${what}`, [...lines.map(p), button(i.panelUrl, 'Open the Domains panel')].join('\n'), 'You get this once for each domain each year.');
  return { subject, html, text: [...lines.flatMap((l) => [l, '']), `Domains panel: ${i.panelUrl}`].join('\n') };
}
