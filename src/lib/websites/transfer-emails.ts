/**
 * Batch 37: the emails a website transfer sends, as pure builders ({ subject, html, text }).
 *
 * To the OPERATOR (the account owner), from Stayful Intelligence:
 *   filesReadyEmail      the guide in the body, the zip attached (or a download link when it is too big)
 *   transferCodeEmail    the domain's transfer code, straight to the owner (the only email that holds it)
 *   domainMovedEmail     "your domain has moved"
 *
 * To the ADMIN (one email per event, never one per run):
 *   transferRequestedAdminEmail   a transfer was asked for
 *   manualStepAdminEmail          the tag change (or the transfer code) needs a person
 *   stuckAlertAdminEmail          a requested move has sat for the stuck days
 *   exportFailedAdminEmail        the files could not be built after three tries
 *
 * Nothing here carries a secret: the transfer code is in transferCodeEmail and nowhere else (an admin
 * email never has it), and the download link is in filesReadyEmail only when the zip is not attached.
 * Every value that is not fixed wording is one line and escaped. No money figure is typed here, and no
 * Stayful asset. The callers log ids and codes, never these bodies.
 *
 * Pure: no network, no database, no server-only. Relative .ts imports only.
 */
import { escapeHtml } from '../email/escape.ts';
import type { EmailCopy } from '../email/new-lead.ts';
import type { TransferMethod } from './transfer-rules.ts';

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
const pre = (text: string) => `<pre style="font-size:13px;line-height:1.5;white-space:pre-wrap;background:#f6f5f0;border-radius:8px;padding:12px;margin:0 0 12px">${escapeHtml(text)}</pre>`;

const OPERATOR_FOOTER = 'Stayful Intelligence. This is a service notice about your website, so we send it whatever your email settings.';
const ADMIN_FOOTER = 'Stayful Intelligence admin notice.';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "21 December 2026" from an ISO date or time (UK day), or null when missing or unreadable. */
export function emailDay(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}

const methodWords = (m: TransferMethod): string => (m === 'tag' ? 'IPS tag change' : m === 'code' ? 'transfer code' : 'files only (no domain)');

// ── To the operator ──

export interface FilesReadyInput {
  siteName: string;
  /** The guide as plain text (buildGuide(...).text). */
  guideText: string;
  /** The zip is attached to this email. */
  attached: boolean;
  /** The signed download link: used only when the zip is not attached. */
  downloadUrl: string | null;
  /** The day our copy of the site stops (ISO), or null. */
  ourCopyEnds: string | null;
  /** Where the operator can download it again, an absolute address (their Take my website page). */
  transferPageUrl: string;
}

export function filesReadyEmail(i: FilesReadyInput): EmailCopy {
  const name = oneLine(i.siteName, 80) || 'your website';
  const ends = emailDay(i.ourCopyEnds);
  const subject = oneLine(`Your website files are ready: ${name}`, 200);
  const where = i.attached
    ? 'Your website files are attached to this email as a zip. The guide is below and is in the zip too (GUIDE.html).'
    : i.downloadUrl
      ? 'Your website files are too big to attach, so here is a download link. The guide is below and is in the zip too (GUIDE.html).'
      : 'Your website files are ready. Download them from your Take my website page. The guide is below and is in the zip too (GUIDE.html).';
  const keeps = ends ? `Our copy of your website keeps working until ${ends}, so nothing goes dark while you move it.` : 'Our copy of your website keeps working while you move it, so nothing goes dark.';
  const html = shell(
    'Your website files are ready',
    [p(where), ...(!i.attached && i.downloadUrl ? [button(i.downloadUrl, 'Download my website files')] : []), p(keeps), pre(i.guideText), button(i.transferPageUrl, 'Open Take my website')].join('\n'),
    OPERATOR_FOOTER,
  );
  const text = [
    'Your website files are ready',
    '',
    where,
    ...(!i.attached && i.downloadUrl ? ['', `Download: ${i.downloadUrl}`] : []),
    '',
    keeps,
    '',
    '----',
    i.guideText.trimEnd(),
    '----',
    '',
    `Take my website: ${i.transferPageUrl}`,
    '',
    OPERATOR_FOOTER,
    '',
  ].join('\n');
  return { subject, html, text };
}

export interface TransferCodeInput {
  siteName: string;
  domain: string;
  /** The transfer code. It is in this email and nowhere else. */
  code: string;
  providerName: string | null;
}

export function transferCodeEmail(i: TransferCodeInput): EmailCopy {
  const name = oneLine(i.siteName, 80) || 'your website';
  const domain = oneLine(i.domain, 120);
  const provider = oneLine(i.providerName, 60);
  const subject = oneLine(`Your transfer code for ${domain}`, 200);
  const lines = [
    `Here is the transfer code for ${domain}, the web address of ${name}.`,
    provider ? `Give it to ${provider} when they ask for it, in the step where you ask them to transfer ${domain} in.` : `Give it to your new registrar when they ask for it, in the step where you ask them to transfer ${domain} in.`,
    'Keep it private: anyone with this code can move your domain. We do not keep a copy of it.',
    'Your website keeps working while the move happens. We email you again once the domain has moved.',
  ];
  const html = shell(`Your transfer code for ${domain}`, [p(lines[0]), `<p style="font-size:20px;font-weight:700;letter-spacing:0.5px;margin:0 0 12px;font-family:ui-monospace,Menlo,monospace">${escapeHtml(i.code)}</p>`, ...lines.slice(1).map(p)].join('\n'), OPERATOR_FOOTER);
  const text = [`Your transfer code for ${domain}`, '', lines[0], '', `    ${i.code}`, '', ...lines.slice(1).flatMap((l) => [l, '']), OPERATOR_FOOTER, ''].join('\n');
  return { subject, html, text };
}

export interface DomainMovedInput {
  siteName: string;
  domain: string;
  ourCopyEnds: string | null;
  transferPageUrl: string;
}

export function domainMovedEmail(i: DomainMovedInput): EmailCopy {
  const name = oneLine(i.siteName, 80) || 'your website';
  const domain = oneLine(i.domain, 120);
  const ends = emailDay(i.ourCopyEnds);
  const subject = oneLine(`Your domain has moved: ${domain}`, 200);
  const lines = [
    `${domain} has moved to your new provider.`,
    `Point it at your own copy of ${name} there if you have not already (the guide has the steps).`,
    ends ? `Our copy of your website stops serving on ${ends} or soon after, now that the domain has moved. Your exported enquiry form keeps sending enquiries to your account for good.` : 'Our copy of your website stops serving soon, now that the domain has moved. Your exported enquiry form keeps sending enquiries to your account for good.',
  ];
  const html = shell('Your domain has moved', [...lines.map(p), button(i.transferPageUrl, 'Open Take my website')].join('\n'), OPERATOR_FOOTER);
  const text = ['Your domain has moved', '', ...lines.flatMap((l) => [l, '']), `Take my website: ${i.transferPageUrl}`, '', OPERATOR_FOOTER, ''].join('\n');
  return { subject, html, text };
}

// ── To the admin ──

const short = (id: string): string => oneLine(id, 36).slice(0, 8);

export interface TransferRequestedInput {
  transferId: string;
  siteName: string;
  /** The domain being moved, or null (files only). */
  domain: string | null;
  providerName: string;
  method: TransferMethod;
  /** The new registrar's tag (method tag), or null. */
  tag: string | null;
  overlapEndsAt: string | null;
  panelUrl: string;
}

export function transferRequestedAdminEmail(i: TransferRequestedInput): EmailCopy {
  const name = oneLine(i.siteName, 80) || 'A website';
  const subject = oneLine(`Website transfer requested: ${name}`, 200);
  const lines = [
    `${name} asked to take their website${i.domain ? ` and move ${oneLine(i.domain, 120)}` : ' (files only, no domain)'}.`,
    `Reference ${short(i.transferId)}. Moving to: ${oneLine(i.providerName, 60)}. Method: ${methodWords(i.method)}${i.tag ? ` (${oneLine(i.tag, 40)})` : ''}.`,
    i.method === 'tag' ? 'The tag change is tried once automatically. If the registrar cannot do it, it becomes a manual step here and you press "Tag changed" once it is done.' : i.method === 'code' ? 'The transfer code is emailed straight to the account owner.' : 'The files are built and emailed; there is no domain to move.',
    emailDay(i.overlapEndsAt) ? `Our copy keeps serving until ${emailDay(i.overlapEndsAt)} at the earliest.` : 'Our copy keeps serving for the overlap days.',
  ];
  return { subject, html: shell('Website transfer requested', [...lines.map(p), button(i.panelUrl, 'Open the transfers panel')].join('\n'), ADMIN_FOOTER), text: ['Website transfer requested', '', ...lines.flatMap((l) => [l, '']), `Transfers panel: ${i.panelUrl}`, ''].join('\n') };
}

export interface ManualStepInput {
  transferId: string;
  domain: string;
  providerName: string;
  /** 'tag': change the IPS tag; 'code': get the transfer code and send it. */
  step: 'tag' | 'code';
  tag: string | null;
  /** Why it is manual: a short code (refused, unclear), never a response body. */
  reason: string;
  panelUrl: string;
}

export function manualStepAdminEmail(i: ManualStepInput): EmailCopy {
  const domain = oneLine(i.domain, 120);
  const subject = oneLine(i.step === 'tag' ? `Manual step: change the tag on ${domain}` : `Manual step: send the transfer code for ${domain}`, 200);
  const lines =
    i.step === 'tag'
      ? [
          `${domain} needs its IPS tag changed by hand${i.tag ? ` to ${oneLine(i.tag, 40)}` : ''} (${oneLine(i.providerName, 60)}). The registrar did not take the automatic change (${oneLine(i.reason, 40)}).`,
          'Change it at the registrar, then press "Tag changed" on the transfers panel. The move is then tracked, and you are alerted if it sits too long.',
        ]
      : [
          `${domain} needs its transfer code sent by hand (${oneLine(i.providerName, 60)}). The registrar did not give it automatically (${oneLine(i.reason, 40)}).`,
          'Get the code at the registrar, then type it into "Send code" on the transfers panel. It is emailed to the owner and is not stored.',
        ];
  return { subject, html: shell('A transfer needs a person', [p(`Reference ${short(i.transferId)}.`), ...lines.map(p), button(i.panelUrl, 'Open the transfers panel')].join('\n'), ADMIN_FOOTER), text: ['A transfer needs a person', '', `Reference ${short(i.transferId)}.`, '', ...lines.flatMap((l) => [l, '']), `Transfers panel: ${i.panelUrl}`, ''].join('\n') };
}

export interface StuckAlertInput {
  transferId: string;
  domain: string;
  method: TransferMethod;
  providerName: string;
  /** When the move was requested (ISO). */
  requestedAt: string | null;
  stuckDays: number;
  panelUrl: string;
}

export function stuckAlertAdminEmail(i: StuckAlertInput): EmailCopy {
  const domain = oneLine(i.domain, 120);
  const since = emailDay(i.requestedAt);
  const subject = oneLine(`Domain move stuck: ${domain}`, 200);
  const lines = [
    `${domain} was asked to move to ${oneLine(i.providerName, 60)}${since ? ` on ${since}` : ''} and it has not moved after ${Math.max(1, Math.floor(i.stuckDays))} days (${methodWords(i.method)}).`,
    'Check the registrar and the new provider. Press "Mark moved" if it has, or cancel the transfer (only possible before it moves) to let the domain renew again.',
  ];
  return { subject, html: shell('A domain move is stuck', [p(`Reference ${short(i.transferId)}.`), ...lines.map(p), button(i.panelUrl, 'Open the transfers panel')].join('\n'), ADMIN_FOOTER), text: ['A domain move is stuck', '', `Reference ${short(i.transferId)}.`, '', ...lines.flatMap((l) => [l, '']), `Transfers panel: ${i.panelUrl}`, ''].join('\n') };
}

export interface ExportFailedInput {
  transferId: string;
  siteName: string;
  /** A short code for what failed, never an address. */
  code: string;
  attempts: number;
  panelUrl: string;
}

export function exportFailedAdminEmail(i: ExportFailedInput): EmailCopy {
  const name = oneLine(i.siteName, 80) || 'A website';
  const subject = oneLine(`Website export failed: ${name}`, 200);
  const lines = [
    `The files for ${name} could not be built after ${Math.max(1, Math.floor(i.attempts))} tries (${oneLine(i.code, 60)}).`,
    'Press "Retry export" on the transfers panel once the cause is fixed. The operator has not been emailed.',
  ];
  return { subject, html: shell('A website export failed', [p(`Reference ${short(i.transferId)}.`), ...lines.map(p), button(i.panelUrl, 'Open the transfers panel')].join('\n'), ADMIN_FOOTER), text: ['A website export failed', '', `Reference ${short(i.transferId)}.`, '', ...lines.flatMap((l) => [l, '']), `Transfers panel: ${i.panelUrl}`, ''].join('\n') };
}
