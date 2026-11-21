/**
 * Batch 38b: the two emails the operator gets about their video ad.
 *
 *   videoReadyCopy    "Your video ad is ready": the video is made and passed its checks, so it can be approved.
 *   videoFailedCopy   "We couldn't finish your video": the video failed for good; says what to do next.
 *
 * The video takes minutes and the operator may have closed the page, so these two are the only way they find out.
 * Both are direct replies to something the operator started, like the website change emails
 * (src/lib/email/website-edit.ts), so they sit OUTSIDE the one-email-a-day cap and go straight through sendEmail
 * with their own idempotency key. Plain words only: nothing about packs, versions, renders or checks, no figure, no
 * company name, no lead data, and nothing of what the operator typed. The link goes to /leads/ads on the site's own
 * base URL.
 *
 * Built like website-edit.ts: pure builders that return copy (and reuse its renderer, so the look is the house look),
 * and a thin sender that never throws. The decision of WHEN to send is src/lib/ad-packs/notify-core.ts.
 */
import { renderRequestEmail, type RequestEmailCopy } from './website-edit.ts';
import { isRetryableRenderCode } from '../ad-packs/render-store.ts';
import { sendEmail, isEmailConfigured, type SendResult } from './send.ts';

export type VideoEmailOutcome = 'ready' | 'failed';

export const VIDEO_EMAIL_PATH = '/leads/ads';

/** "Your video ad is ready". */
export function videoReadyCopy(): RequestEmailCopy {
  return {
    subject: 'Your video ad is ready',
    title: 'Your video ad is ready',
    lines: [
      'Your Facebook video ad is ready to watch.',
      'Open it here, check it looks right, then follow the steps to put your ads on Facebook.',
    ],
    quote: null,
    cta: { label: 'Watch your video ad', path: VIDEO_EMAIL_PATH },
  };
}

/** "We couldn't finish your video", with the next step that fits the failure (a voice problem, a retry, or just ask us). */
export function videoFailedCopy(errorCode: string | null | undefined): RequestEmailCopy {
  const code = errorCode ?? '';
  const next =
    code === 'voice_unavailable'
      ? 'Open your ads page and choose a different voice. We will make the video again for you.'
      : isRetryableRenderCode(code)
        ? 'Open your ads page and try again. If you like, you can choose a different voice first.'
        : 'Open your ads page to see where things stand.';
  return {
    subject: "We couldn't finish your video",
    title: "We couldn't finish your video",
    lines: ['Something went wrong while we were making your Facebook video ad, so it is not ready yet. Your other ads are not affected.', next, 'If it still does not work, just reply to this email and we will sort it out.'],
    quote: null,
    cta: { label: 'Open your ads page', path: VIDEO_EMAIL_PATH },
  };
}

/**
 * Resend's Idempotency-Key for one result of one render: the render's id, the outcome and the moment it finished (so a
 * voice change or a retry, which finishes later, is a different email, while a repeated send of the same result is the
 * same key and Resend will not send it twice).
 */
export function videoEmailKey(renderId: string, outcome: VideoEmailOutcome, finishedAt: string | null): string {
  const stamp = finishedAt ? String(Date.parse(finishedAt) || 0) : '0';
  return `ad-pack-video:${renderId}:${outcome}:${stamp}`;
}

/** Send one of the two emails. Never throws; the address and body are never logged. */
export async function sendVideoEmail(to: string | null | undefined, o: { outcome: VideoEmailOutcome; errorCode?: string | null; idempotencyKey: string; base?: string; from?: string }): Promise<SendResult> {
  try {
    if (!to) return { sent: false, reason: 'no_recipient' };
    if (!isEmailConfigured()) return { sent: false, reason: 'not_configured' };
    const copy = o.outcome === 'ready' ? videoReadyCopy() : videoFailedCopy(o.errorCode);
    return await sendEmail({ to, ...renderRequestEmail(copy, o.base), ...(o.from ? { from: o.from } : {}), idempotencyKey: o.idempotencyKey });
  } catch {
    return { sent: false, reason: 'error' };
  }
}
