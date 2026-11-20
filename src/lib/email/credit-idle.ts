/**
 * Batch 34b (Phase 11): the no-spend emails for plan credit.
 *
 *   creditIdleReminderEmail      the 3- and 6-month reminders: capped
 *                                ('credit_idle'), behind the credit alerts
 *                                switch, so they carry "Manage notifications".
 *   creditIdleFinalWarningEmail  the final warning before earlier months'
 *                                plan credit expires: a BILLING NOTICE, capped
 *                                ('credit_idle_final') but never switched off,
 *                                so no unsubscribe or notification-settings
 *                                footer.
 *
 * Built like src/lib/email/billing.ts (the same short layout and one link),
 * but with the copy in pure builders that return { subject, lines } and a pure
 * renderer, so they are unit tested without sending (credit-idle.test.ts).
 * billing.ts is server-only and keeps its helpers private, so the layout is
 * mirrored here rather than imported. Wording follows the approved terms
 * (src/app/(marketing)/terms/page.tsx section 2). Sending never throws.
 */
import { escapeHtml } from './escape.ts';
import { sendEmail, isEmailConfigured, type SendResult } from './send.ts';
import { siteUrl, manageNotificationsUrl } from '../url.ts';
import { formatGbp } from '../credit/pricing.ts';
import { formatPlanDate } from '../subscription.ts';

export interface CreditIdleCopy {
  subject: string;
  /** The heading inside the email. */
  title: string;
  /** One paragraph each, plain text. */
  lines: string[];
  cta: { label: string; path: string };
  /** A billing notice: no notification-settings footer (opt-outs never block it). */
  billingNotice: boolean;
}

const BILLING_NOTICE_LINE = 'This is a billing notice about the credit on your account, so we send it whatever your email settings.';

/** "20 November 2027" (UTC, as the account page shows plan dates). */
function longDate(d: Date | string): string {
  const iso = typeof d === 'string' ? d : Number.isFinite(d.getTime()) ? d.toISOString() : '';
  return formatPlanDate(iso) ?? String(d);
}

/** The 3- and 6-month reminder: the balance, and that plan credit rolls over and any spending keeps it that way. */
export function creditIdleReminderCopy({ months, balancePence }: { months: number; balancePence: number }): CreditIdleCopy {
  const balance = formatGbp(balancePence);
  return {
    subject: `You have ${balance} of Stayful credit waiting`,
    title: `${balance} of credit is waiting for you`,
    lines: [
      `You haven't spent any credit in ${months} months. You have ${balance} of credit on your account.`,
      'Unused plan credit rolls over every month with no cap, and any spending at all, however small, keeps it that way.',
    ],
    cta: { label: "See today's deals", path: '/today' },
    billingNotice: false,
  };
}

/**
 * The final warning: the balance, the amount that would expire and the date.
 * Only earlier months' plan credit can expire; the latest month's never does
 * this way, and spending any credit before the date stops it.
 */
export function creditIdleFinalWarningCopy({ balancePence, expiringPence, expiresOn, months }: { balancePence: number; expiringPence: number; expiresOn: Date | string; months?: number }): CreditIdleCopy {
  const balance = formatGbp(balancePence);
  const expiring = formatGbp(expiringPence);
  const date = longDate(expiresOn);
  return {
    subject: `${expiring} of your Stayful plan credit expires on ${date}`,
    title: 'Some of your plan credit is due to expire',
    lines: [
      `${months ? `You haven't spent any credit in ${months} months. ` : "You haven't spent any credit for a long time. "}You have ${balance} of credit on your account.`,
      `On ${date}, ${expiring} of plan credit from earlier months expires if your account still has no spending by then. Your latest month's plan credit never expires this way, and top-up credit never expires.`,
      `Spending any credit before ${date}, however small, stops this.`,
      BILLING_NOTICE_LINE,
    ],
    cta: { label: 'Run a report', path: '/estimate' },
    billingNotice: true,
  };
}

/** The html and text of a copy, in billing.ts's layout. A billing notice has no "Manage notifications" footer. */
export function renderCreditIdleEmail(copy: CreditIdleCopy, base?: string): { subject: string; html: string; text: string } {
  const root = base ? base.replace(/\/$/, '') : siteUrl();
  const url = `${root}${copy.cta.path}`;
  const billing = `${root}/account/billing`;
  const manage = manageNotificationsUrl(root);
  const footerLinks = copy.billingNotice
    ? `<a href="${escapeHtml(billing)}" style="color:#6b7280">Billing &amp; usage</a>`
    : `<a href="${escapeHtml(billing)}" style="color:#6b7280">Billing &amp; usage</a> · <a href="${escapeHtml(manage)}" style="color:#6b7280">Manage notifications</a>`;
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f6f5f0;padding:24px;color:#1f2a1d">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e3da">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(copy.title)}</h1>
${copy.lines.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${escapeHtml(p)}</p>`).join('')}
<p style="margin:20px 0 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#2E3D2B;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(copy.cta.label)}</a></p>
<p style="font-size:12px;color:#6b7280;margin:24px 0 0">Stayful Intelligence · ${footerLinks}</p>
</div></body></html>`;
  const footerText = copy.billingNotice ? `Billing & usage: ${billing}` : `Billing & usage: ${billing}\n\nManage notifications: ${manage}`;
  const text = `${copy.title}\n\n${copy.lines.join('\n\n')}\n\n${copy.cta.label}: ${url}\n\n${footerText}\n`;
  return { subject: copy.subject, html, text };
}

async function send(to: string | null | undefined, copy: CreditIdleCopy, opts: { idempotencyKey?: string } = {}): Promise<SendResult> {
  if (!to) return { sent: false, reason: 'no_recipient' };
  if (!isEmailConfigured()) return { sent: false, reason: 'not_configured' };
  return sendEmail({ to, ...renderCreditIdleEmail(copy), ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) });
}

/** The 3- or 6-month reminder. `idempotencyKey`: credit-idle:<user>:<idle_since>:<stage> (Phase 12). */
export function creditIdleReminderEmail(to: string | null | undefined, data: { months: number; balancePence: number }, opts: { idempotencyKey?: string } = {}): Promise<SendResult> {
  return send(to, creditIdleReminderCopy(data), opts);
}

/** The final warning (a billing notice). */
export function creditIdleFinalWarningEmail(to: string | null | undefined, data: { balancePence: number; expiringPence: number; expiresOn: Date | string; months?: number }, opts: { idempotencyKey?: string } = {}): Promise<SendResult> {
  return send(to, creditIdleFinalWarningCopy(data), opts);
}
