/**
 * `leads.meeting_reached_at` (Batch 35, Phase 8): the first time a lead's stage
 * reached "Meeting booked" or "Signed". Stamped once, never cleared, so a later
 * "Lost" does not take the meeting away from the ad ranking.
 *
 * Pure module so it runs under `node --test`. Separate from `status` and
 * `crm_pushed_at`, which mean "went to your CRM" and are never touched here.
 */

import type { LeadStage } from './stage.ts';

const MEETING_STAGES: ReadonlySet<LeadStage> = new Set<LeadStage>(['meeting_booked', 'signed']);

/** True for the stages that count as "a meeting was reached". */
export function reachesMeeting(stage: LeadStage): boolean {
  return MEETING_STAGES.has(stage);
}

/**
 * The timestamp to write, or null to leave the column alone. Only when the
 * column is empty and the new stage is a meeting stage.
 */
export function meetingStampFor(currentStamp: string | null, newStage: LeadStage, now: Date): string | null {
  if (currentStamp) return null;
  return reachesMeeting(newStage) ? now.toISOString() : null;
}
