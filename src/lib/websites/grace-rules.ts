/**
 * Batch 36: when a customer website is warned, switched off and deleted, as
 * pure rules. The cron, the admin console and the operator's screen all call
 * graceState, so a login that cancels a switch-off cancels it everywhere at
 * once (the cron only records it afterwards). Nothing here reads a clock, a
 * database or a network: every date comes in as a UK day ("YYYY-MM-DD") or a
 * Date, and the answer is a plain value.
 *
 * Three reasons start an episode:
 *   abandoned   the site is live and nobody has logged in (owner or any team
 *               member) and no website lead has come in for website_abandon_days.
 *               A login or a lead after the episode started cancels it.
 *   cancelled   the plan has ended (or is set to end), when the plan gate is on.
 *               Only a live plan cancels it: a login does not.
 *   unpaid      a domain charge is unpaid, when domain charging is on. Only
 *               paying (no unpaid charge left) cancels it.
 *
 * The switch-off date:
 *   base date = abandoned: last activity + abandon days; cancelled: the plan end
 *               date when known; unpaid: the day the charge went unpaid.
 *   switchOffOn = the later of the base date and the day the FIRST warning was
 *               sent + the largest warning day. So a cron outage, or a site
 *               already past day 90 on launch day, still gets its full notice,
 *               and nothing is switched off before a warning was actually sent.
 *
 * Warnings (website_warning_days, "30,14,3"): stage d is due once switchOffOn
 * is d days away or less. The most imminent due stage is the one sent; earlier
 * stages that were missed are recorded as skipped. Each stage goes once.
 *
 * Deletion: only after switch-off, only when switched-off day + delete days is
 * today or earlier, and never for a switched-back-on site.
 */
import { largestWarningDay, type GraceSettings } from './grace-settings.ts';

export type GraceReason = 'abandoned' | 'cancelled' | 'unpaid';

// ── Dates ──

/** A UK calendar day, "YYYY-MM-DD". */
export type UkDay = string;

const DAY_MS = 86400000;

/** The UK day a moment falls on (Europe/London). */
export function ukDayOf(d: Date): UkDay {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const dayNumber = (day: UkDay): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

export function addDays(day: UkDay, n: number): UkDay {
  return new Date((dayNumber(day) + n) * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from a to b (positive when b is later). */
export function daysBetween(a: UkDay, b: UkDay): number {
  return Math.round(dayNumber(b) - dayNumber(a));
}

const laterDay = (a: UkDay, b: UkDay): UkDay => (a >= b ? a : b);

// ── Facts ──

export interface GraceFacts {
  /** websites.status === 'live'. A paused, preview or setup site is never processed. */
  siteLive: boolean;
  /** When the site went live: the fallback "activity" for a site nobody has logged in to since. */
  liveAt: Date | null;
  /** The newest profiles.last_seen_at of the owner and every team member. */
  lastSeen: Date | null;
  /** The newest lead on the site's funnel. */
  lastLead: Date | null;
  /** accountStatus(...) === 'lapsed'. */
  planLapsed: boolean;
  /** When the plan ends, if it is set to end and the date is known. */
  planEndsAt: Date | null;
  /** website_domain_charges.status = 'unpaid' for this site's domain. */
  unpaidDomain: boolean;
  /** When that charge went unpaid, if known. */
  unpaidSince: Date | null;
  /** website_plan_gate_on */
  gateOn: boolean;
  /** domain_charge_on */
  chargeOn: boolean;
}

/** The newest of the logins, enquiries and (failing both) the day the site went live. */
export function lastActivity(f: Pick<GraceFacts, 'lastSeen' | 'lastLead' | 'liveAt'>): Date | null {
  const dates = [f.lastSeen, f.lastLead].filter((d): d is Date => d !== null);
  if (dates.length === 0) return f.liveAt;
  const newest = dates.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
  return f.liveAt && f.liveAt.getTime() > newest.getTime() ? f.liveAt : newest;
}

/** The website_grace row, as the rules read it. */
export interface GraceEpisode {
  reason: GraceReason;
  startedAt: Date;
  cancelledAt: Date | null;
  switchedOffAt: Date | null;
  deletedAt: Date | null;
}

/** One website_grace_notices row of this episode. */
export interface GraceNotice {
  stage: number;
  status: 'sent' | 'skipped';
  sentAt: Date;
}

// ── Why an episode is (still) due ──

/** Whether the reason's condition holds now, and the base switch-off date it points at (null: no date, so today). */
function reasonHolds(reason: GraceReason, f: GraceFacts, today: UkDay, s: GraceSettings): { holds: boolean; base: UkDay } {
  if (reason === 'abandoned') {
    const last = lastActivity(f);
    if (!last) return { holds: false, base: today };
    return { holds: true, base: addDays(ukDayOf(last), s.abandonDays) };
  }
  if (reason === 'cancelled') {
    if (!f.gateOn) return { holds: false, base: today };
    if (f.planLapsed) return { holds: true, base: f.planEndsAt ? ukDayOf(f.planEndsAt) : today };
    if (f.planEndsAt) return { holds: true, base: ukDayOf(f.planEndsAt) };
    return { holds: false, base: today };
  }
  if (!f.chargeOn || !f.unpaidDomain) return { holds: false, base: today };
  return { holds: true, base: f.unpaidSince ? ukDayOf(f.unpaidSince) : today };
}

/** Which episode would start today, if any: cancelled, then unpaid, then abandoned. */
export function episodeDue(f: GraceFacts, today: UkDay, s: GraceSettings): { reason: GraceReason; base: UkDay } | null {
  if (!f.siteLive) return null;
  const lead = largestWarningDay(s);
  for (const reason of ['cancelled', 'unpaid', 'abandoned'] as const) {
    const r = reasonHolds(reason, f, today, s);
    // Warnings begin `lead` days before the base date, so the switch-off is on it.
    if (r.holds && daysBetween(today, r.base) <= lead) return { reason, base: r.base };
  }
  return null;
}

// ── The state ──

export type GraceState =
  | { kind: 'none' }
  /** Begin an episode today (the caller writes the row, then asks again to find the first warning). */
  | { kind: 'start'; reason: GraceReason; switchOffOn: UkDay }
  /** The open episode is no longer due: record cancelled_at. */
  | { kind: 'cancel'; reason: GraceReason }
  | { kind: 'warn'; reason: GraceReason; stage: number; skipped: number[]; switchOffOn: UkDay; warned: boolean }
  | { kind: 'wait'; reason: GraceReason; switchOffOn: UkDay; warned: boolean }
  | { kind: 'switch_off'; reason: GraceReason; switchOffOn: UkDay }
  | { kind: 'delete_due'; deleteOn: UkDay };

/** The day the first warning was actually sent (a skipped stage is not a warning), or null. */
export function firstWarningDay(notices: readonly GraceNotice[]): UkDay | null {
  const sent = notices.filter((n) => n.status === 'sent').map((n) => ukDayOf(n.sentAt));
  return sent.length === 0 ? null : sent.reduce((a, b) => (a <= b ? a : b));
}

/** The day a switched-off site's data is deleted: the day it was switched off + the delete days. */
export function deleteOnFor(switchedOffAt: Date, s: GraceSettings): UkDay {
  return addDays(ukDayOf(switchedOffAt), s.deleteAfterDays);
}

function activityAfterStart(f: GraceFacts, startedAt: Date): boolean {
  return (f.lastSeen !== null && f.lastSeen.getTime() > startedAt.getTime()) || (f.lastLead !== null && f.lastLead.getTime() > startedAt.getTime());
}

/**
 * Whether the open episode still stands. Abandoned is cancelled by a login or
 * a lead after the episode started; cancelled only by a live plan; unpaid only
 * by there being no unpaid charge.
 */
function stillStands(ep: GraceEpisode, f: GraceFacts): boolean {
  if (ep.reason === 'abandoned') return !activityAfterStart(f, ep.startedAt);
  if (ep.reason === 'cancelled') return f.gateOn && (f.planLapsed || f.planEndsAt !== null);
  return f.chargeOn && f.unpaidDomain;
}

/**
 * What to do with this site today.
 *
 * `episode` is the site's website_grace row (null when it has none) and
 * `notices` that episode's website_grace_notices. A site that is not live is
 * left alone, except one that was switched off by this process (it is paused
 * on purpose): that one is only ever checked for deletion.
 */
export function graceState(f: GraceFacts, episode: GraceEpisode | null, notices: readonly GraceNotice[], s: GraceSettings, today: UkDay): GraceState {
  const ep = episode && episode.cancelledAt === null ? episode : null;

  // Deleted already, or switched off: the only question left is deletion.
  if (ep && ep.deletedAt !== null) return { kind: 'none' };
  if (ep && ep.switchedOffAt !== null) {
    const deleteOn = deleteOnFor(ep.switchedOffAt, s);
    return deleteOn <= today ? { kind: 'delete_due', deleteOn } : { kind: 'none' };
  }

  // No open episode: would one start?
  if (!ep) {
    const due = episodeDue(f, today, s);
    return due ? { kind: 'start', reason: due.reason, switchOffOn: laterDay(due.base, addDays(today, largestWarningDay(s))) } : { kind: 'none' };
  }

  // An admin-paused (or otherwise not live) site is not processed; its episode waits.
  if (!f.siteLive) return { kind: 'none' };

  if (!stillStands(ep, f)) return { kind: 'cancel', reason: ep.reason };

  const lead = largestWarningDay(s);
  const base = reasonHolds(ep.reason, f, today, s).base;
  const first = firstWarningDay(notices);
  const switchOffOn = first ? laterDay(base, addDays(first, lead)) : laterDay(base, addDays(today, lead));
  const warned = first !== null;

  // Switch off only once a warning has really gone out.
  if (warned && today >= switchOffOn) return { kind: 'switch_off', reason: ep.reason, switchOffOn };

  // The most imminent stage that is due and not yet recorded; earlier unrecorded ones are skipped.
  const left = daysBetween(today, switchOffOn);
  const recorded = new Set(notices.map((n) => n.stage));
  const due = s.warningDays.filter((d) => left <= d && !recorded.has(d));
  if (due.length > 0) {
    const stage = Math.min(...due);
    return { kind: 'warn', reason: ep.reason, stage, skipped: due.filter((d) => d !== stage).sort((a, b) => b - a), switchOffOn, warned };
  }
  return { kind: 'wait', reason: ep.reason, switchOffOn, warned };
}

/**
 * Whether a warning goes today. The daily slot is the member's one non-billing
 * email a day; when it is used the warning waits for tomorrow, except from the
 * day before the switch-off on, when it goes anyway (nobody is switched off
 * without the notice).
 */
export function capDecision(slotUsed: boolean, today: UkDay, switchOffOn: UkDay): 'send' | 'wait' {
  if (daysBetween(today, switchOffOn) <= 1) return 'send';
  return slotUsed ? 'wait' : 'send';
}

/**
 * The switch-off date to show the operator, or null when no warning has been
 * sent (nothing is pending as far as they are concerned) or the episode is
 * over. Screens and emails use this, never the raw row.
 */
export function pendingSwitchOff(state: GraceState): UkDay | null {
  if (state.kind === 'warn' || state.kind === 'wait') return state.warned ? state.switchOffOn : null;
  if (state.kind === 'switch_off') return state.switchOffOn;
  return null;
}
