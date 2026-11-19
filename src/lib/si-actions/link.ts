/**
 * Review R4 (R4-10): the reply to a message that is only a listing link
 * (link-server.ts). The plan's notes (plan-server.ts proposeActions) are
 * written for the model, in the third person ("they don't have enough
 * credit… under your answer"), so the member never sees them: each case has
 * its own words here. The "switched off" note cannot reach this reply (the
 * link-only path falls back to the normal chat when actions are off).
 *
 * Pure: no network, no database, no server-only.
 */

/** What proposeActions returned, as far as this reply reads it. */
export type LinkPlan = Record<string, unknown>;

export const LINK_REPLIES = {
  not_enough_credit: 'There isn’t enough credit to check that listing, so I haven’t checked it. You can top up below.',
  rate_limited: 'You’ve asked me to do a lot in a short time, so I haven’t checked that one. Please try again a little later.',
  one_plan: 'I’m already on that one.',
  fallback: 'I can’t check that just now. Please try again in a moment.',
  done: 'Here it is.',
} as const;

/** The member-facing words for the link-only reply: the spend line, the reason a step was left out, or the case's own words. */
export function linkReplyText(plan: LinkPlan): string {
  if (plan.ok === true) {
    // A step left out says why in the member's own words (config.ts DROP_REASONS).
    const dropped = Array.isArray(plan.dropped) ? (plan.dropped as { why?: unknown }[]).find((d) => typeof d?.why === 'string') : undefined;
    if (dropped) return String(dropped.why);
    if (typeof plan.spend_line === 'string' && plan.spend_line) return `${plan.spend_line}.`;
    if (typeof plan.not_enough_credit === 'string' && plan.not_enough_credit) return LINK_REPLIES.not_enough_credit;
    return LINK_REPLIES.done;
  }
  if (plan.code === 'rate_limited') return LINK_REPLIES.rate_limited;
  if (plan.code === 'one_plan') return LINK_REPLIES.one_plan;
  return LINK_REPLIES.fallback;
}
