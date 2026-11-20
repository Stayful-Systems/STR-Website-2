/**
 * Batch 36 (Phase 5): the two emails a website change request sends.
 *
 *   requestAdminCopy   to every admin address when an operator sends a change
 *                      request: who (the company), what they wrote, a link to
 *                      /admin/websites. Never a screenshot or a link to one
 *                      (those stay behind admin's sign-in).
 *   requestClosedCopy  to the operator once, when the request is done or
 *                      declined: their own words, the news and the admin's note.
 *
 * Both are direct replies to something someone did, like the feedback emails
 * (src/lib/email/feedback.ts), so they sit OUTSIDE the one-email-a-day cap and
 * go straight through sendEmail with their own idempotency key. Nothing a
 * person wrote goes into a subject line, and everything is escaped.
 *
 * Built like src/lib/email/credit-idle.ts: pure builders that return copy, a
 * pure renderer, and thin senders that never throw.
 */
import { escapeHtml } from './escape.ts';
import { sendEmail, isEmailConfigured, type SendResult } from './send.ts';
import { siteUrl } from '../url.ts';

export interface RequestEmailCopy {
  subject: string;
  title: string;
  /** One paragraph each, plain text; line breaks inside a paragraph are kept. */
  lines: string[];
  /** The person's own words, shown set apart, or null. */
  quote: string | null;
  cta: { label: string; path: string };
}

/** A header-safe single line: no controls, bounded. */
function oneLine(s: string | null | undefined, max = 80): string {
  return (s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Resend's Idempotency-Key for one admin address: one email per request per address. */
export const adminRequestKey = (requestId: string, address: string): string => `website-request:${requestId}:${address.trim().toLowerCase()}`;
/** Resend's Idempotency-Key for the operator's closed email: one per request. */
export const closedRequestKey = (requestId: string): string => `website-request-closed:${requestId}`;

/** To admin: a new request. The subject names the company (the operator's own setting), never what they wrote. */
export function requestAdminCopy(d: { company: string | null; body: string; hasScreenshot: boolean }): RequestEmailCopy {
  const who = oneLine(d.company) || 'a customer website';
  return {
    subject: `New website change request: ${who}`,
    title: 'New website change request',
    lines: [`${who} has asked for a change to their website.`, ...(d.hasScreenshot ? ['They attached a screenshot: it is in the console.'] : [])],
    quote: d.body,
    cta: { label: 'Open the website console', path: '/admin/websites' },
  };
}

/** To the operator: done or declined, with the admin's note. */
export function requestClosedCopy(d: { status: 'done' | 'declined'; body: string; adminNote: string | null }): RequestEmailCopy {
  const done = d.status === 'done';
  return {
    subject: done ? 'Your website change is done' : "We can't make your website change",
    title: done ? 'Your website change is done' : "We can't make that change",
    lines: [
      done ? 'We have made the change you asked for. It is on your website now.' : "We're sorry: we can't make the change you asked for.",
      ...(d.adminNote ? [`Note from us: ${d.adminNote}`] : []),
      'You can send another request, or change many things yourself, any time.',
    ],
    quote: d.body,
    cta: { label: 'Go to your website', path: '/leads/website' },
  };
}

/** The html and text of a copy. */
export function renderRequestEmail(copy: RequestEmailCopy, base?: string): { subject: string; html: string; text: string } {
  const root = base ? base.replace(/\/$/, '') : siteUrl();
  const url = `${root}${copy.cta.path}`;
  const para = (p: string) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`;
  const quote = copy.quote
    ? `<p style="font-size:14px;line-height:1.5;margin:0 0 12px;padding:10px 14px;background:#f6f5f0;border-left:3px solid #2E3D2B;color:#3b4a38">${escapeHtml(copy.quote).replace(/\n/g, '<br>')}</p>`
    : '';
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f6f5f0;padding:24px;color:#1f2a1d">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e3da">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(copy.title)}</h1>
${copy.lines.slice(0, 1).map(para).join('')}${quote}${copy.lines.slice(1).map(para).join('')}
<p style="margin:20px 0 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#2E3D2B;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(copy.cta.label)}</a></p>
<p style="font-size:12px;color:#6b7280;margin:24px 0 0">Stayful Intelligence</p>
</div></body></html>`;
  const text = `${copy.title}\n\n${[copy.lines[0], copy.quote ? `> ${copy.quote.replace(/\n/g, '\n> ')}` : null, ...copy.lines.slice(1)].filter(Boolean).join('\n\n')}\n\n${copy.cta.label}: ${url}\n`;
  return { subject: copy.subject, html, text };
}

async function send(to: string | null | undefined, copy: RequestEmailCopy, idempotencyKey: string): Promise<SendResult> {
  try {
    if (!to) return { sent: false, reason: 'no_recipient' };
    if (!isEmailConfigured()) return { sent: false, reason: 'not_configured' };
    return await sendEmail({ to, ...renderRequestEmail(copy), idempotencyKey });
  } catch {
    return { sent: false, reason: 'error' };
  }
}

/** One admin address. Idempotency key: adminRequestKey(requestId, address). */
export function sendRequestAdminEmail(to: string, requestId: string, data: { company: string | null; body: string; hasScreenshot: boolean }): Promise<SendResult> {
  return send(to, requestAdminCopy(data), adminRequestKey(requestId, to));
}

/** The operator's done/declined email. Idempotency key: closedRequestKey(requestId). */
export function sendRequestClosedEmail(to: string | null | undefined, requestId: string, data: { status: 'done' | 'declined'; body: string; adminNote: string | null }): Promise<SendResult> {
  return send(to, requestClosedCopy(data), closedRequestKey(requestId));
}
