import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { isAdminEmail } from '../admin';
import { ACCESS_COLUMNS, accountStatus, isCancelScheduled, type AccessProfile } from '../access';
import { getBillingSettings } from '../credit/unit-costs';
import { QUALIFYING_KINDS } from '../activity/kinds';
import { payersForStrict } from '../team';
import { EMAIL_ENGAGEMENT_KINDS, ENGAGED_EXTRA_KINDS, ENGAGED_KINDS, inactivityChange, inactivityEligible, inactivityState } from './rules';
import { isPackOnly, packPauseDue } from '../credit/pack-rules';

/**
 * Inactivity (Batch 20, Part C; the rules are in ./rules.ts).
 *
 *   runInactivityStep   the nightly, database only: brings member_active_days
 *                       and member_engaged_days up to date from the activity
 *                       log (from a watermark, never a rescan), then sets
 *                       reengage_since at 14 quiet days and
 *                       picks_paused_inactive_at at 25, and clears both for
 *                       anyone active again (engaging by email or text
 *                       counts). The first step of
 *                       /api/internal/monday-funnel's nightly, before any
 *                       Monday call. `apply: false` writes nothing.
 *   inactivePausedIds   whose daily picks are paused (the picks run skips
 *                       them, the digest drops their Today's 5).
 *
 * Batch 29, section D: the same step pauses a pack-only member's picks once
 * they have not been in the app for pack_picks_pause_days (7; their
 * profiles.last_seen_at, or the pack itself when they have not visited since:
 * packPauseDue in src/lib/credit/pack-rules.ts). It runs even while
 * inactivity_from is empty (the 25-day rule for everyone else stays off), is
 * written with picks_paused_reason 'pack', sends no letter
 * (src/lib/listing/picks-paused-run.ts skips it), and ends on their next visit
 * (resumePackPause in ./came-back.ts, from AppShell).
 *
 * An engaging action clears both at once: ./came-back.ts, from
 * src/lib/activity/log.ts.
 *
 * Every read of the Batch 20 columns is its own query: before the schema is
 * run it fails, and nothing is paused or marked.
 */

type Admin = ReturnType<typeof createAdminClient>;

const PAGE = 1000;
const ID_CHUNK = 300;

type ProfileRow = AccessProfile & { id: string; email: string | null; created_at: string | null; welcome_checked_at: string | null };
type MarkRow = { id: string; reengage_since: string | null; picks_paused_inactive_at: string | null };

export interface InactivityOutcome {
  ok: boolean;
  error?: string;
  dry: boolean;
  /** The rules are off until billing_settings.inactivity_from is set. */
  rulesOn: boolean;
  activeDays: { added: number; upTo: number | null; more: boolean } | null;
  /**
   * The activity log was not read to the end in the time allowed: nobody is
   * newly marked (their latest actions may not be counted yet), only cleared,
   * and the nightly runs the step again.
   */
  incomplete: boolean;
  considered: number;
  eligible: number;
  reengage: { set: number; cleared: number };
  paused: { set: number; cleared: number };
  /** Batch 29: of `paused`, the pack-only members paused for no visit in pack_picks_pause_days (null: the pack state was unreadable, so nobody). */
  packPaused: { set: number; cleared: number } | null;
  /** Who moves tonight (the dry run's list). */
  changes: { user: string; email: string | null; days: number | null; reengage: 'set' | 'clear' | null; picks: 'pause' | 'restart' | null; why?: 'pack' }[];
  ms: number;
}

/**
 * Brings member_active_days up to date. A dry run only counts what it would
 * add, and returns each member's latest day among the actions not yet
 * counted (`pending`), so its preview is as of now, not as of last night.
 */
async function syncActiveDays(admin: Admin, apply: boolean, deadline: number): Promise<{ added: number; upTo: number | null; more: boolean; pending: Map<string, string> } | { error: string }> {
  let added = 0;
  let upTo: number | null = null;
  const pending = new Map<string, string>();
  for (;;) {
    // Batch 21 (E7): the extension and the API count as engaging too.
    const { data, error } = await admin.rpc('lifecycle_active_days_sync', { p: { qualifying: QUALIFYING_KINDS, engaged: [...EMAIL_ENGAGEMENT_KINDS, ...ENGAGED_EXTRA_KINDS], apply, limit: 50000 } });
    if (error) return { error: `active days not synced (schema behind?): ${error.message}` };
    const r = (data ?? {}) as { added?: number; to?: number | null; more?: boolean; pending?: { u: string; day: string }[] | null };
    added += Number(r.added) || 0;
    upTo = r.to ?? upTo;
    for (const x of r.pending ?? []) if (x?.u && x.day) pending.set(x.u, x.day);
    // A dry run does not move the watermark, so one pass is all it can count.
    if (!r.more || !apply || Date.now() > deadline) return { added, upTo, more: Boolean(r.more), pending };
  }
}

export async function runInactivityStep(opts: { apply: boolean; now?: Date; budgetMs?: number }): Promise<InactivityOutcome> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const out: InactivityOutcome = { ok: true, dry: !opts.apply, rulesOn: false, activeDays: null, incomplete: false, considered: 0, eligible: 0, reengage: { set: 0, cleared: 0 }, paused: { set: 0, cleared: 0 }, packPaused: null, changes: [], ms: 0 };
  const fail = (error: string): InactivityOutcome => ({ ...out, ok: false, error, ms: Date.now() - started });
  if (!hasServiceRole()) return fail('Storage not configured');
  const admin = createAdminClient();
  const settings = (await getBillingSettings()).lifecycle;
  out.rulesOn = Boolean(settings.inactivityFrom);

  const synced = await syncActiveDays(admin, opts.apply, started + (opts.budgetMs ?? 20_000));
  if ('error' in synced) return fail(synced.error);
  out.activeDays = { added: synced.added, upTo: synced.upTo, more: synced.more };
  out.incomplete = opts.apply && synced.more;

  // Everyone, with the plan columns (the rules need the plan holder's).
  const profiles: ProfileRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from('profiles').select(`id, email, created_at, welcome_checked_at, ${ACCESS_COLUMNS}`).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) return fail(`profiles read failed: ${error.message}`);
    profiles.push(...((data ?? []) as unknown as ProfileRow[]));
    if ((data?.length ?? 0) < PAGE) break;
  }
  out.considered = profiles.length;
  // The marks, in a read of their own.
  const marks = new Map<string, MarkRow>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from('profiles').select('id, reengage_since, picks_paused_inactive_at').order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) return fail(`inactivity columns unreadable (schema not run?): ${error.message}`);
    for (const r of (data ?? []) as MarkRow[]) marks.set(r.id, r);
    if ((data?.length ?? 0) < PAGE) break;
  }
  const ids = profiles.map((p) => p.id);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  // A team member follows their owner's plan: never guessed, so a failed lookup stops the step.
  const payers = await payersForStrict(ids);
  if (!payers) return fail('team lookup failed: nobody marked');
  // Batch 21 (E8, Q10): the admin's "Exclude from metrics" switch leaves an
  // account out of the nightly entirely (never marked; marks cleared).
  const excluded = new Set<string>();
  {
    const { data, error } = await admin.from('activity_excluded_accounts').select('user_id');
    if (error) return fail(`excluded accounts unreadable: ${error.message}`);
    for (const r of (data ?? []) as { user_id: string }[]) excluded.add(r.user_id);
  }
  const lastDay = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await admin.rpc('lifecycle_member_stats', { p: { users: ids.slice(i, i + ID_CHUNK) } });
    if (error) return fail(`member stats unreadable: ${error.message}`);
    // The last day they engaged at all (by email or text included: ./rules.ts), not only the weekly-active one.
    for (const r of (data ?? []) as { u: string; last_day: string | null; last_engaged?: string | null }[]) lastDay.set(r.u, r.last_engaged ?? r.last_day ?? null);
  }
  // A dry run cannot count the actions since the last nightly into the table: its preview adds them here.
  for (const [u, day] of synced.pending) {
    const had = lastDay.get(u) ?? null;
    if (!had || day > had) lastDay.set(u, day);
  }
  // Batch 29: the pack pause's facts (null when unreadable: no pack pause is set or cleared tonight).
  const pack = await packPauseFacts(admin, profiles, byId, payers, now);

  const groups = { setReengage: [] as string[], clearReengage: [] as string[], setPaused: [] as string[], clearPaused: [] as string[], setPack: [] as string[], clearPack: [] as string[] };
  for (const p of profiles) {
    // A team member follows their owner's plan; their own activity counts.
    const holder = byId.get(payers.get(p.id)?.payerId ?? p.id) ?? p;
    // A cancellation booked and still to come; a plan granted by hand is never one (a stale date may be left on it).
    const cancelBooked = holder.plan_source !== 'manual' && isCancelScheduled(holder, now.getTime());
    // Batch 21 (E3): an account that never signed in (welcome_checked_at unset) is not a quiet member, it is an unconfirmed sign-up.
    const eligible = Boolean(p.welcome_checked_at) && !excluded.has(p.id) && inactivityEligible({ planStatus: accountStatus(holder, now.getTime()), cancelBooked, admin: isAdminEmail(p.email), email: p.email });
    if (eligible) out.eligible += 1;
    const rule = inactivityState({ eligible, lastActiveDay: lastDay.get(p.id) ?? null, createdAt: p.created_at }, settings, now);
    const mark = marks.get(p.id);
    // Batch 29: a pack-only member away for pack_picks_pause_days is paused too. While the pack state is
    // unreadable, a pack pause already written is left exactly as it is (never cleared by a failed read).
    const packAway = pack.away ? eligible && pack.away.has(p.id) : false;
    const storedPack = Boolean(mark?.picks_paused_inactive_at) && pack.reasons.get(p.id) === 'pack';
    const keepPack = !pack.away && storedPack;
    const target = { ...rule, picksPaused: rule.picksPaused || packAway || keepPack };
    const change = inactivityChange({ reengageSince: mark?.reengage_since ?? null, picksPausedAt: mark?.picks_paused_inactive_at ?? null }, target);
    if (change.setReengage) groups.setReengage.push(p.id);
    if (change.clearReengage) groups.clearReengage.push(p.id);
    // A new pause for the pack alone is written with its reason; one Batch 20's rule also wants is Batch 20's.
    if (change.setPaused) (packAway && !rule.picksPaused ? groups.setPack : groups.setPaused).push(p.id);
    if (change.clearPaused) (storedPack ? groups.clearPack : groups.clearPaused).push(p.id);
    if (change.setReengage || change.clearReengage || change.setPaused || change.clearPaused) {
      const why = (change.setPaused && packAway && !rule.picksPaused) || (change.clearPaused && storedPack) ? { why: 'pack' as const } : {};
      out.changes.push({ user: p.id, email: p.email, days: target.days, reengage: change.setReengage ? 'set' : change.clearReengage ? 'clear' : null, picks: change.setPaused ? 'pause' : change.clearPaused ? 'restart' : null, ...why });
    }
  }
  out.reengage = { set: groups.setReengage.length, cleared: groups.clearReengage.length };
  out.paused = { set: groups.setPaused.length + groups.setPack.length, cleared: groups.clearPaused.length + groups.clearPack.length };
  out.packPaused = pack.away ? { set: groups.setPack.length, cleared: groups.clearPack.length } : null;
  if (!opts.apply) return { ...out, ms: Date.now() - started };

  // Batch 21 (E22): a member who engaged in the seconds between the sync's
  // read and this write is not marked tonight: one read of the log past the
  // watermark for the members about to be marked.
  if (synced.upTo !== null && (groups.setReengage.length > 0 || groups.setPaused.length > 0 || groups.setPack.length > 0)) {
    const about = [...new Set([...groups.setReengage, ...groups.setPaused, ...groups.setPack])];
    const back = new Set<string>();
    for (let i = 0; i < about.length; i += ID_CHUNK) {
      const { data, error } = await admin.from('activity_events').select('user_id').gt('id', synced.upTo).in('kind', ENGAGED_KINDS).in('user_id', about.slice(i, i + ID_CHUNK));
      if (error) return fail(`late activity unreadable: ${error.message}`);
      for (const r of (data ?? []) as { user_id: string }[]) back.add(r.user_id);
    }
    if (back.size > 0) {
      groups.setReengage = groups.setReengage.filter((id) => !back.has(id));
      groups.setPaused = groups.setPaused.filter((id) => !back.has(id));
      groups.setPack = groups.setPack.filter((id) => !back.has(id));
      out.reengage.set = groups.setReengage.length;
      out.paused.set = groups.setPaused.length + groups.setPack.length;
      if (out.packPaused) out.packPaused.set = groups.setPack.length;
    }
  }
  const nowIso = now.toISOString();
  const write = async (list: string[], patch: Record<string, unknown>, onlyIfNull?: string): Promise<string | null> => {
    for (let i = 0; i < list.length; i += ID_CHUNK) {
      let q = admin.from('profiles').update(patch).in('id', list.slice(i, i + ID_CHUNK));
      if (onlyIfNull) q = q.is(onlyIfNull, null);
      const { error } = await q;
      if (error) return error.message;
    }
    return null;
  };
  // Clears are always safe; new marks only once every action has been counted.
  const errors = [
    out.incomplete ? null : await write(groups.setReengage, { reengage_since: nowIso }, 'reengage_since'),
    await write(groups.clearReengage, { reengage_since: null }),
    // A new pause gets its own "while you're away" letter.
    out.incomplete ? null : await write(groups.setPaused, { picks_paused_inactive_at: nowIso, picks_paused_inactive_email_at: null }, 'picks_paused_inactive_at'),
    await write(groups.clearPaused, { picks_paused_inactive_at: null, picks_paused_inactive_email_at: null }),
    // Batch 29: the pack pause (no letter: picks-paused-run.ts skips reason 'pack'). Its end is noted on Home.
    out.incomplete ? null : await write(groups.setPack, { picks_paused_inactive_at: nowIso, picks_paused_inactive_email_at: null, picks_paused_reason: 'pack' }, 'picks_paused_inactive_at'),
    await write(groups.clearPack, { picks_paused_inactive_at: null, picks_paused_inactive_email_at: null, picks_paused_reason: null, pack_picks_back_at: nowIso }),
  ].filter((e): e is string => e !== null);
  if (out.incomplete) {
    out.reengage.set = 0;
    out.paused.set = 0;
    if (out.packPaused) out.packPaused.set = 0;
  }
  if (errors.length > 0) return fail(`inactivity not written: ${errors[0]}`);
  return { ...out, ms: Date.now() - started };
}

/**
 * Batch 29: each paused member's stored reason, and who is a pack-only member
 * away for pack_picks_pause_days. Their own reads (the Batch 29 columns and
 * functions). Reasons unreadable: the column is not there, so no pack pause
 * was ever written. `away` unreadable (null): no pack pause is set or cleared
 * tonight. A team member follows their payer's pack.
 */
async function packPauseFacts(admin: Admin, profiles: ProfileRow[], byId: Map<string, ProfileRow>, payers: Map<string, { payerId: string }>, now: Date): Promise<{ away: Set<string> | null; reasons: Map<string, string | null> }> {
  const reasons = new Map<string, string | null>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from('profiles').select('id, picks_paused_reason').not('picks_paused_inactive_at', 'is', null).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) {
      console.warn('[inactivity] pack pause skipped tonight (schema.sql Batch 29 section not run?):', error.message);
      return { away: null, reasons: new Map() };
    }
    for (const r of (data ?? []) as { id: string; picks_paused_reason: string | null }[]) reasons.set(r.id, r.picks_paused_reason);
    if ((data?.length ?? 0) < PAGE) break;
  }
  return { away: await packAwayIds(admin, profiles, byId, payers, now), reasons };
}

async function packAwayIds(admin: Admin, profiles: ProfileRow[], byId: Map<string, ProfileRow>, payers: Map<string, { payerId: string }>, now: Date): Promise<Set<string> | null> {
  try {
    const pauseDays = (await getBillingSettings()).lifecycle.packPicksPauseDays;
    const packAt = new Map<string, string>();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin.from('starter_pack_purchases').select('user_id, granted_at, created_at').eq('status', 'granted').not('user_id', 'is', null).order('payment_intent_id', { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as { user_id: string; granted_at: string | null; created_at: string }[]) packAt.set(r.user_id, r.granted_at ?? r.created_at);
      if ((data?.length ?? 0) < PAGE) break;
    }
    const away = new Set<string>();
    if (packAt.size === 0) return away;
    // Pack-only per buyer: no further payment, no live / trialling / past-due / paused plan.
    const packOnly = new Map<string, boolean>();
    const buyers = [...packAt.keys()];
    for (let i = 0; i < buyers.length; i += 8) {
      await Promise.all(
        buyers.slice(i, i + 8).map(async (u) => {
          const { data, error } = await admin.rpc('member_paid_again_at', { p_user: u });
          if (error) throw new Error(error.message);
          const holder = byId.get(u);
          packOnly.set(u, Boolean(holder) && isPackOnly({ bought: true, paidAgainAt: (data as string | null) ?? null, planStatus: accountStatus(holder!, now.getTime()) }));
        }),
      );
    }
    const members = profiles.filter((p) => packOnly.get(payers.get(p.id)?.payerId ?? p.id) === true);
    for (let i = 0; i < members.length; i += ID_CHUNK) {
      const some = members.slice(i, i + ID_CHUNK);
      const { data, error } = await admin.from('profiles').select('id, last_seen_at').in('id', some.map((p) => p.id));
      if (error) throw new Error(error.message);
      const seen = new Map(((data ?? []) as { id: string; last_seen_at: string | null }[]).map((r) => [r.id, r.last_seen_at]));
      for (const p of some) {
        const payer = payers.get(p.id)?.payerId ?? p.id;
        if (packPauseDue({ packOnly: true, lastSeenAt: seen.get(p.id) ?? null, packAt: packAt.get(payer) ?? null, pauseDays }, now)) away.add(p.id);
      }
    }
    return away;
  } catch (err) {
    console.warn('[inactivity] pack pause skipped tonight (schema.sql Batch 29 section not run?):', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Members whose daily picks are paused for inactivity. Unreadable (schema not run): nobody. */
export async function inactivePausedIds(admin: Admin): Promise<Set<string>> {
  const out = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from('profiles').select('id').not('picks_paused_inactive_at', 'is', null).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) {
      console.warn('[inactivity] paused members unreadable (schema not run?):', error.message);
      return new Set();
    }
    for (const r of (data ?? []) as { id: string }[]) out.add(r.id);
    if ((data?.length ?? 0) < PAGE) break;
  }
  return out;
}
