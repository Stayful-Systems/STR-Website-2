/**
 * Stayful Academy emails (Batch 31a). Pure: the caller sends them (deps.ts
 * and reminders-run.ts, through src/lib/email/send.ts). Billing emails: no
 * unsubscribe link (they are about money the member paid). The refund email
 * is never capped; the reminder takes the day's capped slot
 * (src/lib/notify/cap.ts 'academy_reminder', Zac's Q3).
 */
import { escapeHtml as esc } from '../email/escape.ts';
import { formatPlanDate } from '../subscription.ts';
import { ACADEMY_FACTS } from './rules.ts';

export interface Email {
  subject: string;
  html: string;
  text: string;
}

/** A paragraph: plain text (escaped for the html), or its text and ready-escaped html. */
type Paragraph = string | { text: string; html: string };

function layout(paragraphs: Paragraph[], base: string): { html: string; text: string } {
  const billing = `${base}/account/billing`;
  const htmlOf = (p: Paragraph) => (typeof p === 'string' ? esc(p) : p.html);
  const textOf = (p: Paragraph) => (typeof p === 'string' ? p : p.text);
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#2e3d2b;max-width:520px;margin:0 auto;padding:24px">
  ${paragraphs.map((p) => `<p style="margin:0 0 14px">${htmlOf(p)}</p>`).join('\n  ')}
  <p style="margin:24px 0 0;font-size:13px;color:#7a8274">Stayful Intelligence · <a href="${esc(billing)}" style="color:#7a8274">Billing &amp; usage</a></p>
</div>`;
  const text = [...paragraphs.flatMap((p) => [textOf(p), '']), `Billing & usage: ${billing}`, '', 'Stayful Intelligence'].join('\n');
  return { html, text };
}

/** Sent when a full refund of the Academy ends the free Pro months early. */
export function academyRefundEmail({ siteUrl }: { siteUrl: string }): Email {
  const base = siteUrl.replace(/\/$/, '');
  const subject = 'Your Academy refund';
  const body =
    "Your Stayful Academy purchase has been refunded, so your free months of Stayful Intelligence Pro have ended today. You won't be charged anything. Your account, deals and history stay as they are on the free plan.";
  return { subject, ...layout([body], base) };
}

/** "19 February 2027", as the account page shows plan dates (UTC). */
function longDate(date: Date | string): string {
  return formatPlanDate(typeof date === 'string' ? date : date.toISOString()) ?? String(date);
}

/**
 * The reminder before the first charge (PLAN.md "Exact wording"). `amount` is
 * the Pro price as Stripe charges it ("£39.99"), `last4` the card the trial
 * runs on, `cancelUrl` the one-tap signed cancel link (cancel-link.ts).
 */
export function academyReminderEmail({
  date,
  amount,
  last4,
  cancelUrl,
  months = ACADEMY_FACTS.trialMonths,
  siteUrl,
}: {
  date: Date | string;
  amount: string;
  last4: string;
  cancelUrl: string;
  months?: number;
  siteUrl: string;
}): Email {
  const base = siteUrl.replace(/\/$/, '');
  const when = longDate(date);
  const subject = `Your free Academy months end on ${when}`;
  const lead = `Your ${months} free months of Stayful Intelligence Pro end on ${when}. From then it's ${amount}/month on your card ending ${last4}. Nothing to do if you'd like to keep it. To cancel, tap here: `;
  const link = `<a href="${esc(cancelUrl)}" style="color:#5d8156">${esc(cancelUrl)}</a>`;
  return { subject, ...layout([{ text: `${lead}${cancelUrl}.`, html: `${esc(lead)}${link}.` }], base) };
}
