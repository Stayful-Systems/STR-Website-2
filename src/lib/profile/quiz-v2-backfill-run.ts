import 'server-only';

/**
 * The one-off move of existing profiles onto the shorter quiz (Batch 30), by
 * quiz-v2-backfill.ts (the rules are there). Shared by
 * /api/internal/quiz-v2-backfill. Run it straight after the release, before the
 * first rate sync (04:45 UK) and the 07:00 sourcing run. Review R4 (R4-33): a
 * real run that leaves nothing behind stamps billing_settings.quiz_v2_backfill_done_at,
 * which the rate sync waits for; the dry run writes nothing.
 *
 *   dry   every profile's before and after (short ids, option keys); writes nothing
 *   run   writes each profile that moves: the active one (or a member with no
 *         profile rows) through profiles.market_goals, which the Batch 13 trigger
 *         copies into its row, and its filter_modes on its search_profiles row; any
 *         other in its own search_profiles row. Each write is checked against the row
 *         as read (its updated-at), so a member editing at the same moment is never
 *         overwritten: that profile is left for the next run.
 *
 * Idempotent: a second run changes nothing. It logs no activity (the members did
 * nothing), costs nothing and never charges.
 */
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { parseAboutYou, type AboutYou } from './about';
import { parseAnswered, type AnsweredMap } from './state';
import { parseFilterModes, type FilterModes } from '../tailoring/profile';
import { backfillQuizV2, beforeOf, summarise, type QuizV2After, type QuizV2Before, type QuizV2Outcome } from './quiz-v2-backfill';
import { shortId } from './deal-types-backfill';
import { QUIZ_V2_BACKFILL_DONE_KEY, backfillDone } from './quiz-v2-backfill';
import { readBackfillStamp } from '../listing/live-rate-sync-server';

type Admin = ReturnType<typeof createAdminClient>;

const PAGE = 1000;
const TIME_BUDGET_MS = 50_000;

interface MemberRow {
  id: string;
  market_goals: unknown;
  market_goals_updated_at: string | null;
  about_you: unknown;
}
interface ProfileRow {
  id: string;
  user_id: string;
  criteria: unknown;
  answered: unknown;
  filter_modes?: unknown;
  is_active: boolean;
  updated_at: string;
}
interface QuizRow {
  user_id: string;
  answered: unknown;
}

export interface QuizV2Line {
  member: string | null;
  profile: string | null;
  active: boolean;
  status: 'map' | 'already' | 'no_goals';
  before: QuizV2Before | null;
  after: QuizV2After | null;
  /** The real run only: written, or left for the next run (changed meanwhile, or the write failed). */
  written?: boolean;
  reason?: string;
}

async function readAll<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await read(from, from + PAGE - 1);
    if (error) return { rows, error: error.message };
    const got = (data ?? []) as T[];
    rows.push(...got);
    if (got.length < PAGE) break;
  }
  return { rows, error: null };
}

interface Seat {
  member: MemberRow;
  about: AboutYou | null;
  profile: ProfileRow | null;
  /** The active profile, or a member with no profile rows: the member's own columns. */
  live: boolean;
  raw: unknown;
  marks: AnsweredMap;
  /** The profile's filter_modes, or null when they cannot be stored (no profile row, or the column is missing). */
  modes: FilterModes | null;
}

async function writeSeat(admin: Admin, seat: Seat, outcome: Extract<QuizV2Outcome, { status: 'map' }>, nowIso: string): Promise<{ ok: boolean; reason?: string }> {
  if (seat.live) {
    // Review R4 (R4-40): the switch first, so a failed switch leaves the old answer in place and the next run finds
    // the member again (written after the goals, a failed switch was never retried).
    if (outcome.modes && seat.profile) {
      const { error: modeErr } = await admin.from('search_profiles').update({ filter_modes: outcome.modes }).eq('id', seat.profile.id).eq('user_id', seat.member.id);
      if (modeErr) {
        console.warn('[quiz-v2 backfill] filter mode not written:', modeErr.message);
        return { ok: false, reason: 'write_failed' };
      }
    }
    let q = admin.from('profiles').update({ market_goals: outcome.goals, market_goals_updated_at: nowIso }).eq('id', seat.member.id);
    q = seat.member.market_goals_updated_at ? q.eq('market_goals_updated_at', seat.member.market_goals_updated_at) : q.is('market_goals_updated_at', null);
    const { data, error } = await q.select('id');
    if (error) return { ok: false, reason: 'write_failed' };
    if ((data ?? []).length === 0) return { ok: false, reason: 'changed_meanwhile' };
    return { ok: true };
  }
  const row = seat.profile!;
  const patch: Record<string, unknown> = { criteria: outcome.goals, updated_at: nowIso };
  if (outcome.modes) patch.filter_modes = outcome.modes;
  const { data, error } = await admin.from('search_profiles').update(patch).eq('id', row.id).eq('user_id', seat.member.id).eq('updated_at', row.updated_at).select('id');
  if (error) return { ok: false, reason: 'write_failed' };
  if ((data ?? []).length === 0) return { ok: false, reason: 'changed_meanwhile' };
  return { ok: true };
}

export async function runQuizV2Backfill(opts: { dry: boolean; triggeredBy: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!hasServiceRole()) return { status: 503, body: { error: 'The service role key is not set.' } };
  const started = Date.now();
  const nowIso = new Date().toISOString();
  const admin = createAdminClient();

  const [members, quizzes] = await Promise.all([
    readAll<MemberRow>((from, to) => admin.from('profiles').select('id, market_goals, market_goals_updated_at, about_you').order('id', { ascending: true }).range(from, to)),
    readAll<QuizRow>((from, to) => admin.from('profile_quiz').select('user_id, answered').order('user_id', { ascending: true }).range(from, to)),
  ]);
  if (members.error) return { status: 500, body: { error: `members unreadable: ${members.error}` } };
  if (quizzes.error) return { status: 500, body: { error: `quiz marks unreadable: ${quizzes.error}` } };
  // filter_modes may not exist on an old schema: then no switch is written (setup would stay a must-have), and the report says so.
  let withModes = true;
  let profiles = await readAll<ProfileRow>((from, to) => admin.from('search_profiles').select('id, user_id, criteria, answered, filter_modes, is_active, updated_at').is('deleted_at', null).order('id', { ascending: true }).range(from, to));
  if (profiles.error) {
    withModes = false;
    profiles = await readAll<ProfileRow>((from, to) => admin.from('search_profiles').select('id, user_id, criteria, answered, is_active, updated_at').is('deleted_at', null).order('id', { ascending: true }).range(from, to));
  }
  const profilesReadable = profiles.error === null;
  const byMember = new Map<string, ProfileRow[]>();
  for (const p of profilesReadable ? profiles.rows : []) byMember.set(p.user_id, [...(byMember.get(p.user_id) ?? []), p]);
  const quizOf = new Map(quizzes.rows.map((q) => [q.user_id, q]));
  const modesOf = (p: ProfileRow | null): FilterModes | null => (p && withModes ? parseFilterModes(p.filter_modes) : null);

  const seats: Seat[] = [];
  for (const m of members.rows) {
    const about = parseAboutYou(m.about_you);
    const memberMarks = parseAnswered(quizOf.get(m.id)?.answered ?? {});
    const rows = byMember.get(m.id) ?? [];
    if (rows.length === 0) {
      seats.push({ member: m, about, profile: null, live: true, raw: m.market_goals, marks: memberMarks, modes: null });
      continue;
    }
    for (const p of rows) {
      seats.push(p.is_active ? { member: m, about, profile: p, live: true, raw: m.market_goals, marks: memberMarks, modes: modesOf(p) } : { member: m, about, profile: p, live: false, raw: p.criteria, marks: parseAnswered(p.answered), modes: modesOf(p) });
    }
  }

  const lines: QuizV2Line[] = [];
  const counts = { written: 0, left: 0 };
  let outOfTime = false;
  for (const seat of seats) {
    const outcome = backfillQuizV2(seat.raw, seat.about, seat.marks, seat.modes);
    const line: QuizV2Line = { member: shortId(seat.member.id), profile: shortId(seat.profile?.id), active: seat.live, status: outcome.status, before: beforeOf(seat.raw, seat.modes), after: outcome.status === 'map' ? outcome.after : null };
    if (outcome.status === 'map' && !opts.dry) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        outOfTime = true;
        line.written = false;
        line.reason = 'out_of_time';
        counts.left += 1;
      } else {
        const res = await writeSeat(admin, seat, outcome, nowIso);
        line.written = res.ok;
        if (res.ok) counts.written += 1;
        else {
          counts.left += 1;
          line.reason = res.reason;
        }
      }
    }
    lines.push(line);
  }
  const order = { map: 0, already: 1, no_goals: 2 } as const;
  lines.sort((a, b) => order[a.status] - order[b.status] || (a.member ?? '').localeCompare(b.member ?? '') || (a.profile ?? '').localeCompare(b.profile ?? ''));
  const totals = summarise(lines.map((l) => l.status));

  if (!opts.dry) console.info(`[quiz-v2 backfill] by ${opts.triggeredBy}: ${counts.written} written, ${counts.left} left, ${totals.already} already moved`);
  // Review R4 (R4-33): a real run that leaves nothing behind stamps "done", which the daily rate sync waits for.
  // The dry run writes nothing (it only says whether the stamp is there).
  let stamp: string | null = null;
  if (!opts.dry && backfillDone({ profilesReadable, left: counts.left, outOfTime })) {
    const { error } = await admin.from('billing_settings').upsert({ key: QUIZ_V2_BACKFILL_DONE_KEY, value: nowIso, updated_at: nowIso }, { onConflict: 'key' });
    if (error) console.warn('[quiz-v2 backfill] done stamp not written:', error.message);
    else stamp = nowIso;
  } else {
    stamp = await readBackfillStamp(admin);
  }
  return {
    status: 200,
    body: {
      dry: opts.dry,
      profilesReadable,
      filterModesReadable: withModes,
      members: members.rows.length,
      profiles: seats.length,
      toMap: totals.toMap,
      alreadyMoved: totals.already,
      noGoals: totals.noGoals,
      ...(opts.dry ? {} : { written: counts.written, leftForNextRun: counts.left, outOfTime }),
      doneStamp: stamp,
      lines,
    },
  };
}
