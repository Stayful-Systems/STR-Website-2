/**
 * Batch 36 (Phase 6): the two emails a customer website's grace period sends.
 *
 *   websiteGraceWarningEmail     "your website will be switched off on <date>",
 *                                with one tap to keep it (log in, or pay, or
 *                                start the plan again, by the reason)
 *   websiteSwitchedOffEmail      "your website has been switched off", what
 *                                happens to the data and until when it can be
 *                                switched back on
 *
 * Both are SERVICE NOTICES like a billing email: they go through the daily cap
 * (SendKind 'website_grace', one non-billing email a day) but opt-outs never
 * block them, so they carry no "Manage notifications" footer (SWITCHES_BEHIND
 * is []). The copy is in pure builders that return { subject, title, lines,
 * cta }, and a pure renderer, so it is unit tested without sending
 * (website-grace.test.ts). Built like src/lib/email/credit-idle.ts. Sending
 * never throws. The copy names dates and a day count only: never a figure of
 * money, and never anything from the member's site.
 */
import { escapeHtml } from './escape.ts';
import { sendEmail, isEmailConfigured, type SendResult } from './send.ts';
import { brandedFrom } from './from.ts';
import { siteUrl } from '../url.ts';
import type { GraceReason } from '../websites/grace-rules.ts';

export interface WebsiteGraceCopy {
  subject: string;
  title: string;
  /** One paragraph each, plain text. */
  lines: string[];
  cta: { label: string; path: string };
}

const NOTICE_LINE = 'This is a service notice about your Stayful website, so we send it whatever your email settings.';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "20 November 2026" from a UK day ("2026-11-20"). */
export function longDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** Why the site is going, in the words of the person reading. */
function whyLine(reason: GraceReason): string {
  if (reason === 'abandoned') return "We haven't seen you log in to Stayful, and no enquiries have come through your website, for a while.";
  if (reason === 'cancelled') return 'Your Stayful plan has ended, and your website is part of it.';
  return "The yearly charge for your website's web address has not been paid.";
}

/** What to do to keep it, and where the one tap goes. */
function keepAction(reason: GraceReason): { line: string; path: string } {
  if (reason === 'abandoned') return { line: 'To keep your website, just log in. That is all you need to do.', path: '/leads/website' };
  if (reason === 'cancelled') return { line: 'To keep your website, start your plan again before then.', path: '/upgrade' };
  return { line: 'To keep your website, pay the outstanding charge before then.', path: '/account/billing' };
}

/** The warning: when it goes, why, and the one thing that keeps it. `daysLeft` is days from today to the switch-off. */
export function websiteGraceWarningCopy({ reason, switchOffOn, daysLeft }: { reason: GraceReason; switchOffOn: string; daysLeft: number }): WebsiteGraceCopy {
  const date = longDay(switchOffOn);
  const keep = keepAction(reason);
  const when = daysLeft <= 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days, on ${date}`;
  return {
    subject: `Your Stayful website will be switched off on ${date}`,
    title: `Your website will be switched off ${when}`,
    lines: [
      whyLine(reason),
      `If nothing changes, your website will be switched off on ${date}. Visitors will then see a page saying the site is no longer available.`,
      keep.line,
      'Your leads and their reports are not affected, and you can switch the website back on yourself after it is switched off.',
      NOTICE_LINE,
    ],
    cta: { label: 'Keep my website', path: keep.path },
  };
}

/** The switched-off email: what has happened, what is kept and for how long, and how to switch back on. */
export function websiteSwitchedOffCopy({ reason, deleteOn }: { reason: GraceReason; deleteOn: string }): WebsiteGraceCopy {
  const date = longDay(deleteOn);
  return {
    subject: 'Your Stayful website has been switched off',
    title: 'Your website has been switched off',
    lines: [
      whyLine(reason),
      'Your website has been switched off. Visitors now see a page saying the site is no longer available, and the lead form no longer takes new enquiries. If you have your own web address, it will not renew while the website is off.',
      'Your leads, their reports and your account are not affected.',
      `You can switch your website back on yourself from your Leads page until ${date}. After that day we delete the website's settings, pages and uploaded files, and that cannot be undone.`,
      NOTICE_LINE,
    ],
    cta: { label: 'Switch my website back on', path: '/leads/website' },
  };
}

/** The html and text of a copy, in the billing email layout: a service notice has no "Manage notifications" footer. */
export function renderWebsiteGraceEmail(copy: WebsiteGraceCopy, base?: string): { subject: string; html: string; text: string } {
  const root = base ? base.replace(/\/$/, '') : siteUrl();
  const url = `${root}${copy.cta.path}`;
  const billing = `${root}/account/billing`;
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f6f5f0;padding:24px;color:#1f2a1d">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e3da">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(copy.title)}</h1>
${copy.lines.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${escapeHtml(p)}</p>`).join('')}
<p style="margin:20px 0 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#2E3D2B;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(copy.cta.label)}</a></p>
<p style="font-size:12px;color:#6b7280;margin:24px 0 0">Stayful Intelligence · <a href="${escapeHtml(billing)}" style="color:#6b7280">Billing &amp; usage</a></p>
</div></body></html>`;
  const text = `${copy.title}\n\n${copy.lines.join('\n\n')}\n\n${copy.cta.label}: ${url}\n\nBilling & usage: ${billing}\n`;
  return { subject: copy.subject, html, text };
}

async function send(to: string | null | undefined, copy: WebsiteGraceCopy, opts: { idempotencyKey?: string } = {}): Promise<SendResult> {
  if (!to) return { sent: false, reason: 'no_recipient' };
  if (!isEmailConfigured()) return { sent: false, reason: 'not_configured' };
  const from = brandedFrom(process.env.EMAIL_FROM, 'Stayful Intelligence') ?? undefined;
  return sendEmail({ to, ...renderWebsiteGraceEmail(copy), ...(from ? { from } : {}), ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) });
}

/** A warning. `idempotencyKey`: website-grace:<website>:<episode ISO>:<stage>. */
export function websiteGraceWarningEmail(to: string | null | undefined, data: { reason: GraceReason; switchOffOn: string; daysLeft: number }, opts: { idempotencyKey?: string } = {}): Promise<SendResult> {
  return send(to, websiteGraceWarningCopy(data), opts);
}

/** The switched-off email. `idempotencyKey`: website-grace:<website>:<episode ISO>:off. */
export function websiteSwitchedOffEmail(to: string | null | undefined, data: { reason: GraceReason; deleteOn: string }, opts: { idempotencyKey?: string } = {}): Promise<SendResult> {
  return send(to, websiteSwitchedOffCopy(data), opts);
}
