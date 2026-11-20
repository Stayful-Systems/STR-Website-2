/**
 * Batch 36 (Phase 6): the website grace cron, /api/internal/website-grace,
 * 06:45 UTC daily, and the pure orchestration of what it (and the admin
 * console, and the operator's own button) does to a site:
 *
 *   runWebsiteGrace        the cron. For every live site, and every site with an
 *                          open or switched-off episode, it asks the pure rules
 *                          (grace-rules.ts graceState) and in this order:
 *                            1 cancel   episodes no longer due (writes cancelled_at)
 *                            2 start    new episodes
 *                            3 warn     the warning due: ONE per site per run,
 *                                       claim the day's slot -> mark -> send ->
 *                                       notice row. A used slot writes nothing
 *                                       and waits for tomorrow, except from the
 *                                       day before switch-off on (sent anyway).
 *                            4 switch off   what is due (switchOffWith): status
 *                                       live -> paused, the dates, the domain's
 *                                       renewal blocked, the "switched off" email
 *                            5 delete   what is due (deleteWith)
 *   switchOffWith / finishSwitchOffWith / switchOnWith / deleteWith / exportWith
 *                          the callable pieces (grace-server.ts wires the real
 *                          ones as switchOffSite, switchOnSite, deleteSiteData,
 *                          exportSiteData for the console and Batch 37).
 *   siteGraceView          what a screen shows, derived (never the stored row)
 *
 * Nothing is switched off unless the first warning was actually SENT (a send
 * that fails leaves no notice, so the site is warned again, not switched off).
 * Switching off only flips the status: leads, held reports, CRM and lead
 * database deliveries all carry on. Deletion never touches leads, lead_sources,
 * website_reports, charges, domain records or the funnel row.
 *
 * Dry run: lists what each site would get and writes nothing, sends nothing
 * and claims no slot (a fake that counts writes pins it).
 *
 * Dependency-injected (grace-server.ts holds the live wiring). Lists and logs
 * carry a website id (short), a stage and a code: never an address, an email
 * body or a request's text. Pure of server-only and the network.
 */
import { accountStatus, isCancelScheduled } from '../access.ts';
import { goLive, goLiveMessages, type GoLiveDeps, type PageFetch } from './golive-server.ts';
import type { PageModel, SiteCopy, SiteSettings } from './page-model.ts';
import { capDecision, daysBetween, deleteOnFor, graceState, pendingSwitchOff, ukDayOf, addDays, type GraceEpisode, type GraceFacts, type GraceNotice, type GraceReason, type GraceState, type UkDay } from './grace-rules.ts';
import type { GraceSettings } from './grace-settings.ts';
import { filesInUse } from './edit-rules.ts';

/** No new piece of work after this long into the run (maxDuration is 60). */
export const TIME_BUDGET_MS = 45_000;

// ── What the rules read, and what is stored ──

/** The website_grace row, as the runner works with it. */
export interface GraceEpisodeRow extends GraceEpisode {
  switchOffOn: UkDay | null;
  switchOffBy: 'cron' | 'admin' | null;
  offEmailedAt: Date | null;
  deleteOn: UkDay | null;
}

/** One site, with everything the rules need already read. */
export interface GraceSite {
  websiteId: string;
  ownerId: string;
  /** websites.status */
  status: string;
  /** The owner's address, for the email only (never logged or listed). */
  email: string | null;
  facts: GraceFacts;
  episode: GraceEpisodeRow | null;
  /** The notices of THIS episode (episode_started_at equal). */
  notices: GraceNotice[];
}

/** The profile columns the facts need (ACCESS_COLUMNS' set, read only). */
export interface GraceProfile {
  plan?: string | null;
  plan_code?: string | null;
  plan_source?: string | null;
  reports_run?: number | null;
  stripe_subscription_id?: string | null;
  stripe_subscription_status?: string | null;
  subscription_paused_from?: string | null;
  subscription_paused_until?: string | null;
  subscription_cancel_at?: string | null;
}

/** The newest of some dates, or null. */
export function newestOf(dates: ReadonlyArray<Date | null | undefined>): Date | null {
  const ok = dates.filter((d): d is Date => d instanceof Date && Number.isFinite(d.getTime()));
  return ok.length === 0 ? null : ok.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

/**
 * The facts for one site. `lastSeen` is the newest last_seen_at of the owner and
 * every team member. The plan is read through accountStatus (access.ts, read
 * only): lapsed means the plan ended; a cancellation booked for a future date
 * is the plan end date.
 */
export function graceFactsOf(i: {
  status: string;
  liveAt: Date | null;
  lastSeen: Date | null;
  lastLead: Date | null;
  profile: GraceProfile;
  unpaidSince: Date | null;
  gateOn: boolean;
  chargeOn: boolean;
  now: Date;
}): GraceFacts {
  const lapsed = accountStatus(i.profile, i.now.getTime()) === 'lapsed';
  const cancelAt = i.profile.subscription_cancel_at ? new Date(i.profile.subscription_cancel_at) : null;
  const ends = isCancelScheduled(i.profile, i.now.getTime()) && cancelAt && Number.isFinite(cancelAt.getTime()) ? cancelAt : null;
  return {
    siteLive: i.status === 'live',
    liveAt: i.liveAt,
    lastSeen: i.lastSeen,
    lastLead: i.lastLead,
    planLapsed: lapsed,
    planEndsAt: ends,
    unpaidDomain: i.chargeOn && i.unpaidSince !== null,
    unpaidSince: i.unpaidSince,
    gateOn: i.gateOn,
    chargeOn: i.chargeOn,
  };
}

// ── Keys, tags ──

/** website-grace:<website>:<episode ISO>:<stage> (the resend key of a warning). */
export function warningKey(websiteId: string, episodeStartedAt: Date | string, stage: number | string): string {
  const d = episodeStartedAt instanceof Date ? episodeStartedAt : new Date(episodeStartedAt);
  return `website-grace:${websiteId}:${Number.isFinite(d.getTime()) ? d.toISOString() : String(episodeStartedAt)}:${stage}`;
}

/** The switched-off email's key: the stage is the word "off". */
export const offKey = (websiteId: string, episodeStartedAt: Date | string): string => warningKey(websiteId, episodeStartedAt, 'off');

/** A short, stable tag for log lines (never an address or a name). */
export const tag = (websiteId: string): string => websiteId.slice(0, 8);

const msg = (err: unknown): string => (err as Error)?.message ?? String(err);

// ── The cap: one non-billing email a day ──

export type SendOutcome = { sent: boolean; reason?: string };
export type CapClaim = { ok: true; id: string } | { ok: false; reason: string };

export interface CapSendDeps {
  claimSlot(userId: string, kind: 'website_grace', now: Date): Promise<CapClaim>;
  releaseClaim(claimId: string): Promise<void>;
  /** About to send (the cap record); false: could not be written, so do not send. */
  markSending(claimId: string, summary: Record<string, unknown>): Promise<boolean>;
  /** The send did not go: the cap row is deleted so a later run may use the slot. */
  abandonSend(claimId: string): Promise<void>;
  finishSend(claimId: string, summary: Record<string, unknown>): Promise<void>;
}

export type CapSendResult = { status: 'sent' } | { status: 'waiting'; reason: string } | { status: 'failed'; reason: string };

/**
 * Send one email through the daily cap. Claims the slot first; with no slot
 * (used, or the record unreadable) `decide` says whether it waits (nothing is
 * written, tomorrow) or goes anyway under its own idempotency key (the day
 * before switch-off: nobody is switched off without the notice).
 */
export async function sendThroughCap(
  deps: CapSendDeps,
  a: { userId: string; now: Date; summary: Record<string, unknown>; decideWithoutSlot: () => 'send' | 'wait'; send: () => Promise<SendOutcome> },
): Promise<CapSendResult> {
  const claim = await deps.claimSlot(a.userId, 'website_grace', a.now);
  if (!claim.ok) {
    if (a.decideWithoutSlot() === 'wait') return { status: 'waiting', reason: claim.reason === 'slot_used' ? 'cap_used' : claim.reason };
    const res = await runSend(a.send);
    return res.sent ? { status: 'sent' } : { status: 'failed', reason: res.reason ?? 'send_failed' };
  }
  if (!(await deps.markSending(claim.id, a.summary))) {
    await deps.releaseClaim(claim.id);
    return { status: 'waiting', reason: 'cap_record_unavailable' };
  }
  const res = await runSend(a.send);
  if (!res.sent) {
    await deps.abandonSend(claim.id);
    return { status: 'failed', reason: res.reason ?? 'send_failed' };
  }
  await deps.finishSend(claim.id, a.summary);
  return { status: 'sent' };
}

async function runSend(send: () => Promise<SendOutcome>): Promise<SendOutcome> {
  try {
    return await send();
  } catch (err) {
    return { sent: false, reason: msg(err) };
  }
}

// ── The cron ──

export interface FinishOffResult {
  renewalBlocked: boolean;
  emailed: boolean;
  waiting: boolean;
  reason?: string;
}

export interface GraceRunDeps extends CapSendDeps {
  settings(): Promise<GraceSettings>;
  /** Live sites, and every site with an open or switched-off episode that is not deleted. */
  sites(now: Date): Promise<GraceSite[]>;
  /** Dry run only: owners who have used today's daily slot (null: unreadable, assume free). */
  slotsUsedToday(ownerIds: readonly string[], now: Date): Promise<Set<string> | null>;
  startEpisode(websiteId: string, reason: GraceReason, startedAt: Date, switchOffOn: UkDay): Promise<void>;
  cancelEpisode(websiteId: string, at: Date): Promise<void>;
  sendWarning(to: string | null, data: { reason: GraceReason; switchOffOn: UkDay; daysLeft: number }, idempotencyKey: string): Promise<SendOutcome>;
  /** Insert a notice row (on conflict do nothing); 'sent' also stamps sent_at. */
  recordNotice(websiteId: string, episodeStartedAt: Date, stage: number, status: 'sent' | 'skipped', at: Date): Promise<void>;
  /** switchOffWith for a cron switch-off. */
  switchOff(websiteId: string): Promise<{ ok: boolean; reason?: string }>;
  /** The renewal block and the switched-off email again, for a site switched off earlier whose email has not gone. */
  finishSwitchOff(websiteId: string, now: Date): Promise<FinishOffResult>;
  /** deleteWith for a cron deletion. */
  deleteData(websiteId: string): Promise<{ ok: boolean; reason?: string }>;
  log(line: string): void;
  /** Milliseconds, for the time budget (tests pass a fake clock). */
  clock?(): number;
}

export interface GraceEntry {
  websiteId: string;
  reason?: GraceReason;
  stage?: number;
  switchOffOn?: UkDay;
  why?: string;
}

export interface GraceRunResult {
  status: number;
  body: Record<string, unknown>;
}

const isOpen = (e: GraceEpisodeRow | null): e is GraceEpisodeRow => e !== null && e.cancelledAt === null && e.deletedAt === null;

export async function runWebsiteGrace(deps: GraceRunDeps, opts: { dry: boolean; now?: Date }): Promise<GraceRunResult> {
  const dry = opts.dry;
  const now = opts.now ?? new Date();
  const today = ukDayOf(now);
  const clock = deps.clock ?? (() => Date.now());
  const started = clock();
  let ranOutOfTime = false;
  const outOfTime = () => {
    if (clock() - started > TIME_BUDGET_MS) ranOutOfTime = true;
    return ranOutOfTime;
  };

  let settings: GraceSettings;
  let sites: GraceSite[];
  try {
    settings = await deps.settings();
  } catch (err) {
    return { status: 503, body: { error: `billing settings unreadable: ${msg(err)}` } };
  }
  try {
    sites = await deps.sites(now);
  } catch (err) {
    return { status: 503, body: { error: `website_grace unavailable (schema.sql not run?): ${msg(err)}` } };
  }

  const usedToday = dry && sites.length > 0 ? await deps.slotsUsedToday([...new Set(sites.map((s) => s.ownerId))], now).catch(() => null) : null;
  const stateOf = (s: GraceSite): GraceState => graceState(s.facts, s.episode, s.notices, settings, today);

  const cancelled: GraceEntry[] = [];
  const started_: GraceEntry[] = [];
  const warned: GraceEntry[] = [];
  const waiting: GraceEntry[] = [];
  const skipped: GraceEntry[] = [];
  const switchedOff: GraceEntry[] = [];
  const offEmails: GraceEntry[] = [];
  const deleted: GraceEntry[] = [];
  const errors: string[] = [];
  const fail = (s: GraceSite, what: string, why: string) => {
    errors.push(`${s.websiteId} ${what}: ${why}`);
    deps.log(`[website-grace] ${tag(s.websiteId)} ${what} failed: ${why}`);
  };

  // The sites whose switched-off email was already owed when the run began (not ones switched off by this run).
  const owedOffEmail = new Set(sites.filter((s) => isOpen(s.episode) && s.episode.switchedOffAt !== null && s.episode.offEmailedAt === null).map((s) => s.websiteId));

  // ── 1. Cancel episodes that are no longer due ──
  for (const s of sites) {
    if (outOfTime()) break;
    try {
      const st = stateOf(s);
      if (st.kind !== 'cancel' || !s.episode) continue;
      if (!dry) {
        await deps.cancelEpisode(s.websiteId, now);
        s.episode = { ...s.episode, cancelledAt: now };
        deps.log(`[website-grace] ${tag(s.websiteId)} cancelled (${st.reason})`);
      }
      cancelled.push({ websiteId: s.websiteId, reason: st.reason });
    } catch (err) {
      fail(s, 'cancel', msg(err));
    }
  }

  // ── 2. Start new episodes ──
  for (const s of sites) {
    if (outOfTime()) break;
    try {
      const st = stateOf(s);
      if (st.kind !== 'start') continue;
      if (!dry) await deps.startEpisode(s.websiteId, st.reason, now, st.switchOffOn);
      // In memory either way, so the dry run can show the first warning it would send.
      s.episode = { reason: st.reason, startedAt: now, cancelledAt: null, switchedOffAt: null, deletedAt: null, switchOffOn: st.switchOffOn, switchOffBy: null, offEmailedAt: null, deleteOn: null };
      s.notices = [];
      started_.push({ websiteId: s.websiteId, reason: st.reason, switchOffOn: st.switchOffOn });
      if (!dry) deps.log(`[website-grace] ${tag(s.websiteId)} episode started (${st.reason})`);
    } catch (err) {
      fail(s, 'start', msg(err));
    }
  }

  // ── 3. Warnings due: one per site per run ──
  for (const s of sites) {
    if (outOfTime()) break;
    try {
      const st = stateOf(s);
      if (st.kind !== 'warn' || !s.episode) continue;
      const episode = s.episode;
      const entry: GraceEntry = { websiteId: s.websiteId, reason: st.reason, stage: st.stage, switchOffOn: st.switchOffOn };
      const daysLeft = daysBetween(today, st.switchOffOn);

      if (dry) {
        const used = Boolean(usedToday?.has(s.ownerId));
        if (used && capDecision(true, today, st.switchOffOn) === 'wait') waiting.push({ ...entry, why: 'cap_used' });
        else warned.push(entry);
        continue;
      }

      const key = warningKey(s.websiteId, episode.startedAt, st.stage);
      const summary = { websiteGrace: true, stage: st.stage, reason: st.reason };
      const res = await sendThroughCap(deps, {
        userId: s.ownerId,
        now,
        summary,
        decideWithoutSlot: () => capDecision(true, today, st.switchOffOn),
        send: () => deps.sendWarning(s.email, { reason: st.reason, switchOffOn: st.switchOffOn, daysLeft }, key),
      });
      if (res.status === 'waiting') {
        // The slot is used: nothing recorded, the same stage is due again tomorrow.
        waiting.push({ ...entry, why: res.reason });
        continue;
      }
      if (res.status === 'failed') {
        fail(s, `warning ${st.stage}`, res.reason);
        continue;
      }
      // Sent. Earlier stages that were missed are recorded as skipped; then the one sent.
      try {
        for (const d of st.skipped) {
          await deps.recordNotice(s.websiteId, episode.startedAt, d, 'skipped', now);
          s.notices = [...s.notices, { stage: d, status: 'skipped', sentAt: now }];
          skipped.push({ websiteId: s.websiteId, stage: d, why: 'missed' });
        }
        await deps.recordNotice(s.websiteId, episode.startedAt, st.stage, 'sent', now);
        s.notices = [...s.notices, { stage: st.stage, status: 'sent', sentAt: now }];
      } catch (err) {
        // Logged to fix by hand: an unrecorded stage could go again tomorrow (the resend key lasts 24 hours).
        fail(s, `warning ${st.stage} notice`, msg(err));
      }
      warned.push(entry);
      deps.log(`[website-grace] ${tag(s.websiteId)} warning ${st.stage} sent`);
    } catch (err) {
      fail(s, 'warn', msg(err));
    }
  }

  // ── 4. Switch off what is due; finish the email/renewal owed from earlier runs ──
  for (const s of sites) {
    if (outOfTime()) break;
    try {
      const st = stateOf(s);
      if (st.kind === 'switch_off') {
        const entry: GraceEntry = { websiteId: s.websiteId, reason: st.reason, switchOffOn: st.switchOffOn };
        if (dry) {
          switchedOff.push(entry);
          continue;
        }
        const r = await deps.switchOff(s.websiteId);
        if (!r.ok) {
          fail(s, 'switch off', r.reason ?? 'failed');
          continue;
        }
        if (s.episode) s.episode = { ...s.episode, switchedOffAt: now };
        switchedOff.push(entry);
        deps.log(`[website-grace] ${tag(s.websiteId)} switched off (${st.reason})`);
      } else if (owedOffEmail.has(s.websiteId)) {
        if (dry) {
          offEmails.push({ websiteId: s.websiteId, why: 'email_owed' });
          continue;
        }
        const r = await deps.finishSwitchOff(s.websiteId, now);
        if (r.emailed && r.renewalBlocked) offEmails.push({ websiteId: s.websiteId });
        else if (r.waiting) waiting.push({ websiteId: s.websiteId, why: r.reason ?? 'cap_used' });
        else fail(s, 'switched-off email', r.reason ?? (r.renewalBlocked ? 'send_failed' : 'renewal_not_blocked'));
      }
    } catch (err) {
      fail(s, 'switch off', msg(err));
    }
  }

  // ── 5. Delete what is due ──
  for (const s of sites) {
    if (outOfTime()) break;
    try {
      const st = stateOf(s);
      if (st.kind !== 'delete_due') continue;
      const entry: GraceEntry = { websiteId: s.websiteId, why: `due_${st.deleteOn}` };
      if (dry) {
        deleted.push(entry);
        continue;
      }
      const r = await deps.deleteData(s.websiteId);
      if (!r.ok) {
        fail(s, 'delete', r.reason ?? 'failed');
        continue;
      }
      deleted.push(entry);
      deps.log(`[website-grace] ${tag(s.websiteId)} data deleted`);
    } catch (err) {
      fail(s, 'delete', msg(err));
    }
  }

  const ms = clock() - started;
  if (dry) {
    return {
      status: 200,
      body: { dry: true, sites: sites.length, wouldCancel: cancelled, wouldStart: started_, wouldWarn: warned, waiting, wouldSwitchOff: switchedOff, wouldFinishOffEmail: offEmails, wouldDelete: deleted, errors, ranOutOfTime, ms },
    };
  }
  deps.log(`[website-grace] sites ${sites.length}, cancelled ${cancelled.length}, started ${started_.length}, warned ${warned.length}, waiting ${waiting.length}, switched off ${switchedOff.length}, deleted ${deleted.length}, errors ${errors.length}`);
  return {
    status: 200,
    body: {
      dry: false,
      sites: sites.length,
      cancelled,
      started: started_,
      warned,
      skipped,
      waiting,
      switchedOff,
      offEmails,
      deleted,
      counts: { cancelled: cancelled.length, started: started_.length, warned: warned.length, waiting: waiting.length, switchedOff: switchedOff.length, deleted: deleted.length, errors: errors.length },
      errors,
      ranOutOfTime,
      ms,
    },
  };
}

// ── What a screen shows (derived, never the stored row) ──

export interface SiteGraceView {
  state: GraceState;
  /** The switch-off date to show the operator: only once a warning was sent, and not once a login cancelled it. */
  pendingSwitchOff: UkDay | null;
  reason: GraceReason | null;
  /** Switched off by us (status paused + switched_off_at), not switched back on, not deleted. */
  switchedOff: boolean;
  switchedOffAt: Date | null;
  /** The day the data is deleted if nothing changes (switched off + the delete days), or null. */
  deleteOn: UkDay | null;
  deleted: boolean;
}

export function siteGraceView(s: GraceSite, settings: GraceSettings, today: UkDay): SiteGraceView {
  const state = graceState(s.facts, s.episode, s.notices, settings, today);
  const ep = s.episode !== null && s.episode.cancelledAt === null ? s.episode : null;
  const deleted = ep?.deletedAt != null;
  const off = ep !== null && ep.switchedOffAt !== null && !deleted ? ep.switchedOffAt : null;
  return {
    state,
    pendingSwitchOff: pendingSwitchOff(state),
    reason: ep ? ep.reason : null,
    switchedOff: off !== null,
    switchedOffAt: off,
    deleteOn: off ? deleteOnFor(off, settings) : null,
    deleted,
  };
}

// ── Switch off ──

/** What switchOffWith needs about the site. */
export interface SiteLite {
  id: string;
  ownerId: string;
  /** websites.status */
  status: string;
  episode: GraceEpisodeRow | null;
}

export interface SwitchOffDeps {
  load(websiteId: string): Promise<SiteLite | null>;
  deleteAfterDays(): Promise<number>;
  /** Move the site to paused (a live site through setStatus; an admin may also pause any other). False: it did not move. */
  pause(site: SiteLite): Promise<boolean>;
  /** Write the website_grace row's switch-off stamps (creates the row when the site had no episode). */
  stamp(websiteId: string, f: { reason: GraceReason; at: Date; by: 'cron' | 'admin'; deleteOn: UkDay }): Promise<boolean>;
  /** The renewal block and the switched-off email (finishSwitchOffWith). */
  finish(websiteId: string, now: Date): Promise<FinishOffResult>;
}

export type SwitchOffResult =
  | { ok: true; changed: boolean; dryRun: boolean; plan?: { pause: boolean; blockRenewal: boolean; email: boolean; deleteOn: UkDay } }
  | { ok: false; reason: 'not_found' | 'deleted' | 'not_live' | 'conflict' | 'unavailable' };

/**
 * Switch a site off. The cron only switches off a live site; an admin may
 * also switch off a paused, preview or setup one by hand. Status first (so a
 * failure leaves nothing half done), then the stamps, then the renewal block
 * and the email (which the cron retries until they have both happened).
 * Leads, reports and deliveries are untouched: only the status flips.
 */
export async function switchOffWith(deps: SwitchOffDeps, websiteId: string, opts: { by: 'cron' | 'admin'; dryRun?: boolean; now?: Date }): Promise<SwitchOffResult> {
  const now = opts.now ?? new Date();
  const site = await deps.load(websiteId);
  if (!site) return { ok: false, reason: 'not_found' };
  const ep = site.episode;
  if (ep?.deletedAt) return { ok: false, reason: 'deleted' };
  if (isOpen(ep) && ep.switchedOffAt !== null) return { ok: true, changed: false, dryRun: Boolean(opts.dryRun) };
  if (opts.by === 'cron' && site.status !== 'live') return { ok: false, reason: 'not_live' };
  const deleteOn = addDays(ukDayOf(now), await deps.deleteAfterDays());
  if (opts.dryRun) return { ok: true, changed: true, dryRun: true, plan: { pause: site.status !== 'paused', blockRenewal: true, email: true, deleteOn } };

  if (site.status !== 'paused' && !(await deps.pause(site))) return { ok: false, reason: 'conflict' };
  const reason: GraceReason = isOpen(ep) ? ep.reason : 'abandoned';
  if (!(await deps.stamp(websiteId, { reason, at: now, by: opts.by, deleteOn }))) return { ok: false, reason: 'unavailable' };
  try {
    await deps.finish(websiteId, now);
  } catch {
    // The cron finishes it on its next run (the email is still owed).
  }
  return { ok: true, changed: true, dryRun: false };
}

export interface FinishOffDeps extends CapSendDeps {
  episode(websiteId: string): Promise<(GraceEpisodeRow & { ownerId: string; email: string | null }) | null>;
  /** The domain's renewal stopped (blockRenewal). True when it is (or there is no domain). */
  blockRenewal(websiteId: string): Promise<boolean>;
  sendOffEmail(to: string | null, data: { reason: GraceReason; deleteOn: UkDay }, idempotencyKey: string): Promise<SendOutcome>;
  stampEmailed(websiteId: string, at: Date): Promise<void>;
  deleteAfterDays(): Promise<number>;
}

/**
 * The part of a switch-off that can be retried: stop the domain renewing, and
 * send the "switched off" email through the cap. The email waits at most one
 * day for the slot: on the day after the switch-off it goes anyway. An owner
 * with no address is marked done (there is nothing to retry); an email that is
 * not configured is retried.
 */
export async function finishSwitchOffWith(deps: FinishOffDeps, websiteId: string, now: Date): Promise<FinishOffResult> {
  const ep = await deps.episode(websiteId);
  if (!ep || ep.deletedAt || ep.cancelledAt || !ep.switchedOffAt) return { renewalBlocked: false, emailed: false, waiting: false, reason: 'not_switched_off' };
  let renewalBlocked = false;
  try {
    renewalBlocked = await deps.blockRenewal(websiteId);
  } catch {
    renewalBlocked = false;
  }
  if (ep.offEmailedAt) return { renewalBlocked, emailed: true, waiting: false };

  const switchedDay = ukDayOf(ep.switchedOffAt);
  const today = ukDayOf(now);
  const deleteOn = addDays(switchedDay, await deps.deleteAfterDays());
  const res = await sendThroughCap(deps, {
    userId: ep.ownerId,
    now,
    summary: { websiteGrace: true, stage: 'off', reason: ep.reason },
    decideWithoutSlot: () => (today > switchedDay ? 'send' : 'wait'),
    send: () => deps.sendOffEmail(ep.email, { reason: ep.reason, deleteOn }, offKey(websiteId, ep.startedAt)),
  });
  if (res.status === 'sent' || (res.status === 'failed' && res.reason === 'no_recipient')) {
    await deps.stampEmailed(websiteId, now);
    return { renewalBlocked, emailed: true, waiting: false };
  }
  return { renewalBlocked, emailed: false, waiting: res.status === 'waiting', reason: res.reason };
}

// ── Switch back on ──

export interface SwitchOnSite {
  id: string;
  ownerId: string;
  slug: string;
  status: string;
  settings: SiteSettings;
  pages: SiteCopy | null;
  pausedAt: string | null;
  episode: GraceEpisodeRow | null;
}

export interface SwitchOnDeps {
  /** The owner's own site, by the signed-in owner's id. */
  load(ownerId: string): Promise<SwitchOnSite | null>;
  /** The plan gate: false when it is on and the plan is not paid (websiteAccess, go_live). */
  planOk(ownerId: string): Promise<boolean>;
  /** domain_charge_on and an unpaid charge for this site's domain. */
  unpaidDomain(websiteId: string): Promise<boolean>;
  /** The page model the public would get (aligned copy). */
  buildPages(site: SwitchOnSite): PageModel[] | null;
  fetchPage: PageFetch;
  baseUrl?: string;
  /** paused -> live (setStatus). */
  markLive(ownerId: string): Promise<boolean>;
  /** live -> paused again, restoring paused_at. */
  rollbackToPaused(ownerId: string, restore: { pausedAt: string | null }): Promise<boolean>;
  /** Mark the episode over (cancelled_at) / open again (a rollback). */
  clearEpisode(websiteId: string, at: Date): Promise<void>;
  reopenEpisode(websiteId: string): Promise<void>;
  /** renew_allowed true again. */
  allowRenewal(websiteId: string): Promise<boolean>;
  record(userId: string, kind: 'website_switched_on', opts: { dedupeKey: string }): Promise<void>;
  now(): Date;
}

export type SwitchOnReason = 'not_found' | 'not_switched_off' | 'deleted' | 'plan_required' | 'unpaid_domain' | 'checks' | 'no_pages' | 'status' | 'pages' | 'unavailable';
export type SwitchOnResult = { ok: true; renewalRestored: boolean } | { ok: false; reason: SwitchOnReason; messages: string[] };

const SWITCH_ON_MESSAGES: Record<'not_found' | 'not_switched_off' | 'deleted' | 'plan_required' | 'unpaid_domain' | 'unavailable', string> = {
  not_found: 'No website found.',
  not_switched_off: 'Your website is not switched off.',
  deleted: 'Your website was deleted, so it cannot be switched back on. Ask us for a new one.',
  plan_required: 'Your website needs a live plan. Start your plan again, then switch it back on.',
  unpaid_domain: "Your web address charge is unpaid. Pay it, then switch your website back on.",
  unavailable: 'Your website could not be switched back on just now. Please try again.',
};

/**
 * The operator's own "Switch back on": only for a site that is switched off
 * and not deleted, with the plan OK (when the gate is on) and no unpaid domain
 * charge (when charging is on). It runs the same checks and page fetch as
 * Approve and Publish (goLive): paused -> live, back to paused if any page
 * fails. On success the episode is over and the domain may renew again. If the
 * domain lapsed meanwhile the site simply returns on its /s/<slug> address.
 */
export async function switchOnWith(deps: SwitchOnDeps, ownerId: string): Promise<SwitchOnResult> {
  const site = await deps.load(ownerId);
  if (!site) return { ok: false, reason: 'not_found', messages: [SWITCH_ON_MESSAGES.not_found] };
  const ep = site.episode;
  if (ep?.deletedAt) return { ok: false, reason: 'deleted', messages: [SWITCH_ON_MESSAGES.deleted] };
  if (!isOpen(ep) || ep.switchedOffAt === null || site.status === 'live') return { ok: false, reason: 'not_switched_off', messages: [SWITCH_ON_MESSAGES.not_switched_off] };
  if (!(await deps.planOk(ownerId))) return { ok: false, reason: 'plan_required', messages: [SWITCH_ON_MESSAGES.plan_required] };
  if (await deps.unpaidDomain(site.id)) return { ok: false, reason: 'unpaid_domain', messages: [SWITCH_ON_MESSAGES.unpaid_domain] };

  const now = deps.now();
  const restore = { pausedAt: site.pausedAt };
  const goDeps: GoLiveDeps = {
    site: { slug: site.slug },
    settings: site.settings,
    pages: deps.buildPages(site),
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    fetchPage: deps.fetchPage,
    markLive: async () => {
      if (!(await deps.markLive(ownerId))) return false;
      try {
        await deps.clearEpisode(site.id, now);
      } catch {
        // A live site must never keep a deletion scheduled: put it back and say it did not work.
        await deps.rollbackToPaused(ownerId, restore);
        return false;
      }
      return true;
    },
    rollback: async () => {
      const back = await deps.rollbackToPaused(ownerId, restore);
      try {
        await deps.reopenEpisode(site.id);
      } catch {
        // The site is paused with its switch-off stamps still on the row; the cron's deletion rule stays safe (it needs the episode open).
      }
      return back;
    },
    // Approve's own events were recorded when the site first went live; this is a switch back on, recorded below.
    record: async () => {},
  };
  const result = await goLive(goDeps);
  if (!result.ok) {
    const messages = goLiveMessages(result);
    return { ok: false, reason: result.stage, messages: messages.length > 0 ? messages : [SWITCH_ON_MESSAGES.unavailable] };
  }

  let renewalRestored = false;
  try {
    renewalRestored = await deps.allowRenewal(site.id);
  } catch {
    renewalRestored = false;
  }
  try {
    await deps.record(ownerId, 'website_switched_on', { dedupeKey: `website_switched_on:${site.id}:${(ep.switchedOffAt ?? now).toISOString()}` });
  } catch {
    // A missed log line is not a reason to undo a live site.
  }
  return { ok: true, renewalRestored };
}

// ── Delete the site's data ──

export interface DeleteDeps {
  load(websiteId: string): Promise<SiteLite | null>;
  /** Everything of ours the site holds: logo and photo URLs from live, draft and every version; screenshot paths of its change requests; counts of the rows. */
  inventory(websiteId: string): Promise<{ files: string[]; screenshots: string[]; versions: number; requests: number; hasDraft: boolean }>;
  deleteFile(url: string): Promise<void>;
  deleteScreenshots(paths: string[]): Promise<void>;
  /** Delete the draft, the versions and the change requests. */
  deleteRows(websiteId: string): Promise<void>;
  /** Empty settings, pages and checks to {} (the stub row stays). */
  emptySite(websiteId: string): Promise<void>;
  /** Stamp website_grace.deleted_at. */
  stampDeleted(websiteId: string, at: Date): Promise<boolean>;
}

export type DeleteResult =
  | { ok: true; dryRun: boolean; plan: { files: number; screenshots: number; versions: number; requests: number; hasDraft: boolean }; removes: string[]; keeps: string[] }
  | { ok: false; reason: 'not_found' | 'not_switched_off' | 'already_deleted' | 'live' | 'unavailable' };

/** What a deletion removes and what it never touches, in words (shown on screen and in the console's dry run). */
export const DELETION_REMOVES = ['the website settings, pages and checks', 'the draft and every saved version', 'change requests and their screenshots', 'the logo and photo files'];
export const DELETION_KEEPS = ['your leads (under the usual lead retention) and where they came from', 'report records', 'charges', 'web address records', 'your funnel record', 'leads already sent to a lead database or CRM'];

/**
 * Delete a site's data: only a switched-off, not-yet-deleted site that is not
 * live. Files first (best effort, idempotent), then the rows, then the site is
 * emptied and deleted_at stamped last, so a failure part way is simply run
 * again. Nothing here names a lead, lead source, report, charge or domain
 * table: the stub websites row and everything that hangs on it stay.
 */
export async function deleteWith(deps: DeleteDeps, websiteId: string, opts: { dryRun?: boolean; now?: Date } = {}): Promise<DeleteResult> {
  const site = await deps.load(websiteId);
  if (!site) return { ok: false, reason: 'not_found' };
  const ep = site.episode;
  if (ep?.deletedAt) return { ok: false, reason: 'already_deleted' };
  if (!isOpen(ep) || ep.switchedOffAt === null) return { ok: false, reason: 'not_switched_off' };
  if (site.status === 'live') return { ok: false, reason: 'live' };

  const inv = await deps.inventory(websiteId);
  const plan = { files: inv.files.length, screenshots: inv.screenshots.length, versions: inv.versions, requests: inv.requests, hasDraft: inv.hasDraft };
  if (opts.dryRun) return { ok: true, dryRun: true, plan, removes: DELETION_REMOVES, keeps: DELETION_KEEPS };

  for (const url of inv.files) await deps.deleteFile(url);
  if (inv.screenshots.length > 0) await deps.deleteScreenshots(inv.screenshots);
  await deps.deleteRows(websiteId);
  await deps.emptySite(websiteId);
  if (!(await deps.stampDeleted(websiteId, opts.now ?? new Date()))) return { ok: false, reason: 'unavailable' };
  return { ok: true, dryRun: false, plan, removes: DELETION_REMOVES, keeps: DELETION_KEEPS };
}

/** Every logo and photo URL of the live site, the draft and the versions (what deletion removes). */
export function siteFiles(live: { settings: Pick<SiteSettings, 'logoUrl' | 'photoUrl'> | null }, draft: { settings: Pick<SiteSettings, 'logoUrl' | 'photoUrl'> | null } | null, versions: ReadonlyArray<{ settings: Pick<SiteSettings, 'logoUrl' | 'photoUrl'> | null }>): string[] {
  return [...filesInUse(live, draft, versions)];
}

// ── Export ──

export interface ExportDeps {
  site(websiteId: string): Promise<{ slug: string; status: string; settings: unknown; pages: unknown } | null>;
  draft(websiteId: string): Promise<{ settings: unknown; pages: unknown; baseVersion: number | null } | null>;
  versions(websiteId: string): Promise<Array<{ versionNo: number; kind: string; restoredFrom: number | null; publishedAt: string; settings: unknown; pages: unknown }>>;
  requests(websiteId: string): Promise<Array<{ id: string; status: string; body: string; adminNotes: string | null; createdAt: string; hasScreenshot: boolean }>>;
  now(): Date;
}

export interface SiteExport {
  exportedAt: string;
  site: { slug: string; status: string; settings: unknown; pages: unknown };
  draft: { settings: unknown; pages: unknown; baseVersion: number | null } | null;
  versions: Array<{ versionNo: number; kind: string; restoredFrom: number | null; publishedAt: string; settings: unknown; pages: unknown }>;
  changeRequests: Array<{ id: string; status: string; body: string; adminNotes: string | null; createdAt: string; hasScreenshot: boolean }>;
  /** Logo and photo URLs (live, draft and every version). */
  files: string[];
}

const fileUrlsOf = (settings: unknown): string[] => {
  const o = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
  return [o.logoUrl, o.photoUrl].filter((u): u is string => typeof u === 'string' && u.length > 0);
};

/** The site's data as JSON: settings, pages, the draft, the versions, the change request texts and the file URLs. The console offers it before Delete. */
export async function exportWith(deps: ExportDeps, websiteId: string): Promise<SiteExport | null> {
  const site = await deps.site(websiteId);
  if (!site) return null;
  const [draft, versions, requests] = await Promise.all([deps.draft(websiteId), deps.versions(websiteId), deps.requests(websiteId)]);
  const files = new Set<string>([...fileUrlsOf(site.settings), ...(draft ? fileUrlsOf(draft.settings) : []), ...versions.flatMap((v) => fileUrlsOf(v.settings))]);
  return {
    exportedAt: deps.now().toISOString(),
    site: { slug: site.slug, status: site.status, settings: site.settings, pages: site.pages },
    draft,
    versions: [...versions].sort((a, b) => a.versionNo - b.versionNo),
    changeRequests: requests,
    files: [...files],
  };
}
