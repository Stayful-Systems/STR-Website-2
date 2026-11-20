/**
 * Batch 36: the first instant of the UK calendar month, for the monthly spend
 * cap. Same arithmetic as monthStartIso in knowledge/gap/run.ts (which is
 * server-only and not exported).
 *
 * Pure: no network, no database, no server-only.
 */
import { londonMonthStart } from '../sms/uk-time.ts';
import { londonDayStart } from '../leads/search.ts';

export function monthStartIso(now: Date): string {
  return (londonDayStart(londonMonthStart(now)) ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))).toISOString();
}
