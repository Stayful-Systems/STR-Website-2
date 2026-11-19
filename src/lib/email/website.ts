import { escapeHtml } from './escape.ts';
import type { EmailCopy } from './new-lead.ts';
import { FIGURE_LABELS, type ReportSummary } from '../websites/summary.ts';

/**
 * Batch 31: the emails a customer website sends.
 *
 * To the LANDLORD who filled in the form (in the member's name: their company,
 * logo and colour, reply-to their contact email; Stayful is not mentioned):
 *   landlordSummaryEmail      the headline figures, labelled an estimate, with
 *                             the caveat "early estimate, limited local data"
 *                             only when the report's quality was not OK.
 *   landlordHeldEmail         the 24-hour message (the free-report limit was
 *                             reached; the estimate runs the next UK day).
 *   landlordWillContactEmail  "{Company} will be in touch": a self-submit held,
 *                             a failed report, credit held. Never a reason.
 *
 * To the OPERATOR (the member, from Stayful Intelligence, like the funnel's
 * new-lead email):
 *   operatorNewLeadEmail      a landlord filled in step 1: name, email, phone.
 *   operatorReportFailedEmail the landlord's report could not be run: call them.
 *
 * No email here carries the property address (no builder even takes one), no
 * link to the full report (/r/<token>), and nothing the landlord typed is ever
 * put in a subject or header unescaped. The landlord's own copy is figures only:
 * the full report stays on the lead, for the operator.
 *
 * Pure: the runner (src/lib/websites/notify-server.ts) sends them.
 */

export interface LandlordEmailBrand {
  /** The operator's company name. */
  company: string;
  /** https logo, or null for the company name as a heading. */
  logoUrl: string | null;
  /** #rrggbb, or null for the default green. */
  primary: string | null;
  /** True when a reply-to is set, so "reply to this email" is true. */
  canReply: boolean;
}

const DEFAULT_PRIMARY = '#2E3D2B';
const HEX = /^#[0-9a-f]{6}$/i;

/** One line, no control characters, bounded: safe in a subject or a heading. */
function oneLine(v: string | null | undefined, max = 120): string {
  return (v ?? '').replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function firstName(name: string | null | undefined): string {
  const first = oneLine(name, 60).split(' ')[0] ?? '';
  return first;
}

function gbp(n: number): string {
  return `£${Math.round(n).toLocaleString('en-GB')}`;
}

function shell(brand: LandlordEmailBrand, title: string, body: string): string {
  const who = oneLine(brand.company, 80) || 'us';
  const primary = HEX.test(brand.primary ?? '') ? (brand.primary as string) : DEFAULT_PRIMARY;
  const logo = brand.logoUrl && /^https:\/\//i.test(brand.logoUrl)
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(who)}" style="max-height:40px;margin-bottom:16px" />`
    : `<h2 style="font-size:16px;margin:0 0 16px;color:${escapeHtml(primary)}">${escapeHtml(who)}</h2>`;
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f6f5f0;padding:24px;color:#1f2a1d">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e3da">
${logo}
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>
${body}
<p style="font-size:12px;color:#6b7280;margin:24px 0 0">Sent by ${escapeHtml(who)}.</p>
</div></body></html>`;
}

const p = (text: string) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${escapeHtml(text)}</p>`;

function replyLine(brand: LandlordEmailBrand): string | null {
  return brand.canReply ? 'Any questions, just reply to this email.' : null;
}

function greeting(name: string | null | undefined): string {
  const first = firstName(name);
  return first ? `Hello ${first},` : 'Hello,';
}

// ── To the landlord ──

export interface LandlordSummaryInput {
  brand: LandlordEmailBrand;
  landlordName: string | null;
  /** buildSummary(...): figures only, never an address. */
  summary: ReportSummary;
}

export function landlordSummaryEmail(i: LandlordSummaryInput): EmailCopy {
  const who = oneLine(i.brand.company, 80) || 'us';
  const f = i.summary.figures;
  const rows: Array<[string, string]> = [
    [FIGURE_LABELS.annualIncome, gbp(f.annualIncome)],
    [FIGURE_LABELS.monthlyIncome, gbp(f.monthlyIncome)],
    [FIGURE_LABELS.occupancyPct, `${f.occupancyPct}%`],
    [FIGURE_LABELS.nightlyRate, gbp(f.nightlyRate)],
  ];
  const intro = 'Here are the headline figures for your property, worked out from the local short-let market.';
  const estimateNote = 'These are estimates of gross income, not a promise. We can talk you through them and what they mean for your property.';
  const contactLine = `${who} will be in touch.`;
  const caveat = i.summary.caveat;
  const reply = replyLine(i.brand);

  const subject = oneLine(`Your short-let income estimate from ${who}`, 200);
  const table = `<table style="border-collapse:collapse;font-size:14px;width:100%;margin:0 0 16px">${rows
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 0;font-weight:600;white-space:nowrap">${escapeHtml(v)}</td></tr>`)
    .join('')}</table>`;
  const html = shell(
    i.brand,
    'Your short-let income estimate',
    [
      p(greeting(i.landlordName)),
      p(intro),
      table,
      caveat ? `<p style="font-size:14px;line-height:1.5;margin:0 0 12px;padding:10px 12px;background:#fff7e6;border-radius:8px">${escapeHtml(`Note: ${caveat}.`)}</p>` : '',
      p(estimateNote),
      p(contactLine),
      reply ? p(reply) : '',
    ].join('\n'),
  );
  const text = [
    'Your short-let income estimate',
    '',
    greeting(i.landlordName),
    '',
    intro,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(caveat ? ['', `Note: ${caveat}.`] : []),
    '',
    estimateNote,
    '',
    contactLine,
    ...(reply ? ['', reply] : []),
    '',
    `Sent by ${who}.`,
  ].join('\n');
  return { subject, html, text };
}

export interface LandlordMessageInput {
  brand: LandlordEmailBrand;
  landlordName: string | null;
}

export function landlordHeldEmail(i: LandlordMessageInput): EmailCopy {
  const who = oneLine(i.brand.company, 80) || 'us';
  const lines = [
    'Thank you for asking about your property. We are very busy at the moment, so your income estimate will reach you within 24 hours.',
    `${who} will also be in touch.`,
  ];
  const reply = replyLine(i.brand);
  const html = shell(i.brand, 'Your estimate is on its way', [p(greeting(i.landlordName)), ...lines.map(p), reply ? p(reply) : ''].join('\n'));
  const text = ['Your estimate is on its way', '', greeting(i.landlordName), '', ...lines, ...(reply ? ['', reply] : []), '', `Sent by ${who}.`].join('\n');
  return { subject: oneLine(`Your income estimate from ${who} is on its way`, 200), html, text };
}

export function landlordWillContactEmail(i: LandlordMessageInput): EmailCopy {
  const who = oneLine(i.brand.company, 80) || 'us';
  const lines = [`Thank you for asking about your property. ${who} will be in touch.`];
  const reply = replyLine(i.brand);
  const html = shell(i.brand, 'Thank you for your enquiry', [p(greeting(i.landlordName)), ...lines.map(p), reply ? p(reply) : ''].join('\n'));
  const text = ['Thank you for your enquiry', '', greeting(i.landlordName), '', ...lines, ...(reply ? ['', reply] : []), '', `Sent by ${who}.`].join('\n');
  return { subject: oneLine(`Thank you for your enquiry to ${who}`, 200), html, text };
}

// ── To the operator ──

export interface OperatorLeadInput {
  /** The operator's company name (the website's), for the subject. */
  company: string;
  landlordName: string | null;
  landlordEmail: string | null;
  landlordPhone: string | null;
  /** siteUrl('/leads/<id>'). */
  leadUrl: string;
  /** Where the operator manages the website. */
  manageUrl: string;
}

function operatorRows(i: OperatorLeadInput): Array<[string, string]> {
  const who = oneLine(i.landlordName, 120) || 'A landlord';
  return [
    ['Name', who],
    ...(i.landlordEmail ? ([['Email', oneLine(i.landlordEmail, 254)]] as Array<[string, string]>) : []),
    ...(i.landlordPhone ? ([['Phone', oneLine(i.landlordPhone, 40)]] as Array<[string, string]>) : []),
  ];
}

function operatorShell(title: string, intro: string, rows: Array<[string, string]>, i: OperatorLeadInput, footer: string): { html: string; text: string } {
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f6f5f0;padding:24px;color:#1f2a1d">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e3da">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 16px">${escapeHtml(intro)}</p>
<table style="border-collapse:collapse;font-size:14px;width:100%">${rows
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 0">${escapeHtml(v)}</td></tr>`)
    .join('')}</table>
<p style="margin:20px 0 0"><a href="${escapeHtml(i.leadUrl)}" style="display:inline-block;background:#2E3D2B;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Open the lead</a></p>
<p style="font-size:12px;color:#6b7280;margin:24px 0 0">Stayful Intelligence. ${escapeHtml(footer)} <a href="${escapeHtml(i.manageUrl)}" style="color:#6b7280">Manage your website</a>.</p>
</div></body></html>`;
  const text = [title, '', intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', `Open the lead: ${i.leadUrl}`, '', `Stayful Intelligence. ${footer} Manage your website: ${i.manageUrl}`].join('\n');
  return { html, text };
}

/** A landlord filled in step 1 of the website's form. Step-1 details only: no address, no figures. */
export function operatorNewLeadEmail(i: OperatorLeadInput): EmailCopy {
  const who = oneLine(i.landlordName, 120) || 'A landlord';
  const subject = oneLine(`New landlord lead: ${who}`, 200);
  const { html, text } = operatorShell(
    'You have a new landlord lead',
    `${who} has just filled in the form on your website. Their income estimate follows once they add their property.`,
    operatorRows(i),
    i,
    'You get this email for each new lead from your website.',
  );
  return { subject, html, text };
}

/** The landlord's report could not be run after every try: the operator is the one who follows up. */
export function operatorReportFailedEmail(i: OperatorLeadInput): EmailCopy {
  const who = oneLine(i.landlordName, 120) || 'A landlord';
  const subject = oneLine(`Please follow up: ${who}'s income estimate could not be run`, 200);
  const { html, text } = operatorShell(
    "A landlord's estimate could not be run",
    `${who} filled in your website's form, but their income estimate could not be worked out. They have been told you will be in touch, so please contact them directly.`,
    operatorRows(i),
    i,
    'You get this when an estimate cannot be run for a lead from your website.',
  );
  return { subject, html, text };
}
