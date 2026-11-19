/**
 * Stayful Academy emails (Batch 31a). Pure: the caller sends them (deps.ts
 * through src/lib/email/send.ts). Billing emails: never capped, no
 * unsubscribe link (they are about money the member paid).
 */
import { escapeHtml as esc } from '../email/escape.ts';

export interface Email {
  subject: string;
  html: string;
  text: string;
}

function layout(paragraphs: string[], base: string): { html: string; text: string } {
  const billing = `${base}/account/billing`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#2e3d2b;max-width:520px;margin:0 auto;padding:24px">
  ${paragraphs.map((p) => `<p style="margin:0 0 14px">${esc(p)}</p>`).join('\n  ')}
  <p style="margin:24px 0 0;font-size:13px;color:#7a8274">Stayful Intelligence · <a href="${esc(billing)}" style="color:#7a8274">Billing &amp; usage</a></p>
</div>`;
  const text = [...paragraphs.flatMap((p) => [p, '']), `Billing & usage: ${billing}`, '', 'Stayful Intelligence'].join('\n');
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
