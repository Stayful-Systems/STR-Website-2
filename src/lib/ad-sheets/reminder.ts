/**
 * Batch 35 (Phase 11): the count behind the daily email's one leads line,
 * "N leads are over 7 days old and still at New, mark what happened".
 *
 * Pure. The 7 is billing_settings.ad_sheet_reminder_age_days (settings.ts).
 * It counts the recipient's OWN leads only (owner id match, checked here again
 * after the database filter), not archived, stage New (a missing stage is New),
 * created more than `ageDays` days before `now`. It sends nothing: the line only
 * rides the existing one-a-day email (notify/message.ts staleLeadsSection).
 */

export interface ReminderLead {
  ownerId: string;
  stage: string | null;
  createdAt: string;
  archived: boolean;
}

const DAY_MS = 86_400_000;

export function countStaleNew(leads: readonly ReminderLead[], ownerId: string, now: Date, ageDays: number): number {
  if (!Number.isInteger(ageDays) || ageDays < 1) return 0;
  const cutoff = now.getTime() - ageDays * DAY_MS;
  let n = 0;
  for (const l of leads) {
    if (l.ownerId !== ownerId || l.archived) continue;
    if ((l.stage ?? 'new') !== 'new') continue;
    const at = Date.parse(l.createdAt);
    if (Number.isNaN(at) || at >= cutoff) continue;
    n += 1;
  }
  return n;
}

/** Per recipient: a count for every id given (0 when none); an id's count never includes another id's leads. */
export function staleNewByOwner(leads: readonly ReminderLead[], ownerIds: readonly string[], now: Date, ageDays: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ownerIds) out.set(id, countStaleNew(leads, id, now, ageDays));
  return out;
}
