/**
 * Where a member is in the profile quiz: which questions they get, which
 * they have answered, what comes next, the percentage on the bar and the
 * "about N minutes left".
 *
 * Answered-ness is recorded (profile_quiz.answered, one mark per question),
 * not derived from the stored values: "Not sure" on a question whose stored
 * value is null would otherwise be indistinguishable from never asked. A
 * member who answered before the quiz existed (the welcome questions, the
 * Explorer's goals panel, a lead form) is seeded once from what those
 * answers cover (seedFromGoals), which is why they start part-way up the bar.
 *
 * Pure: no network, no database, no server-only.
 */
import { DEFAULT_FINANCE_GOALS } from '../market/goals.ts';
import { applyAnswer, isQuestionId, PREDECESSORS, questionsFor, type Answers, type Question, type QuestionId } from './questions.ts';
import { dealTypesFor, type DealType } from './deal-types.ts';

export interface AnsweredMark {
  /** When it was answered (ISO). */
  at: string;
  /** "Not sure" rather than a real answer. */
  notSure: boolean;
}

export type AnsweredMap = Partial<Record<QuestionId, AnsweredMark>>;

/** The profile_quiz row for a member. */
export interface QuizRecord {
  startedAt: string | null;
  completedAt: string | null;
  /** The last question they were on: where they stopped, for the admin drop-off table. */
  lastQuestion: QuestionId | null;
  answered: AnsweredMap;
  finishLaterAt: string | null;
  resumedAt: string | null;
  creditGrantId: string | null;
  creditSkippedReason: string | null;
  /** The Today-day (todayKey) the reminder card was collapsed for. */
  reminderCollapsedDay: string | null;
}

export const EMPTY_QUIZ: QuizRecord = {
  startedAt: null,
  completedAt: null,
  lastQuestion: null,
  answered: {},
  finishLaterAt: null,
  resumedAt: null,
  creditGrantId: null,
  creditSkippedReason: null,
  reminderCollapsedDay: null,
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** The marks from a stored jsonb value: unknown questions and malformed marks are dropped. */
export function parseAnswered(raw: unknown): AnsweredMap {
  const out: AnsweredMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, mark] of Object.entries(raw as Record<string, unknown>)) {
    if (!isQuestionId(id) || !mark || typeof mark !== 'object') continue;
    const m = mark as Record<string, unknown>;
    const at = str(m.at);
    if (!at || !Number.isFinite(Date.parse(at))) continue;
    out[id] = { at, notSure: m.notSure === true };
  }
  return out;
}

/** A profile_quiz row (snake_case) as a record; null when there is no row. */
export function parseQuizRow(row: unknown): QuizRecord | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const last = str(r.last_question);
  return {
    startedAt: str(r.started_at),
    completedAt: str(r.completed_at),
    lastQuestion: last && isQuestionId(last) ? last : null,
    answered: parseAnswered(r.answered),
    finishLaterAt: str(r.finish_later_at),
    resumedAt: str(r.resumed_at),
    creditGrantId: str(r.credit_grant_id),
    creditSkippedReason: str(r.credit_skipped_reason),
    reminderCollapsedDay: str(r.reminder_collapsed_day),
  };
}

/** How long a question takes, for "about N minutes left". */
export const SECONDS_PER_QUESTION = 20;

export interface Progress {
  /** The deal types the profile wants (chosen, or mapped from older answers); [] until known. */
  types: DealType[];
  /** The questions this member gets, in order. */
  questions: QuestionId[];
  /** Of those, the ones answered (a real answer or "Not sure"). */
  answered: QuestionId[];
  /** The first unanswered one; null once every question is answered. */
  next: QuestionId | null;
  percent: number;
  minutesLeft: number;
  complete: boolean;
  /** The applicable mandatory questions, and whether they are all answered: the gate on the rest of the app. */
  mandatory: QuestionId[];
  mandatoryDone: boolean;
  /** Answered with a real value (the mandatory ones always are). */
  real: number;
  notSure: number;
}

/**
 * Batch 30: the mark that counts for a question: its own, or, when it was not
 * asked, the one a question it replaced left (PREDECESSORS), preferring a real
 * answer over "Not sure". Null when neither was answered.
 */
export function markFor(id: QuestionId, answered: AnsweredMap): AnsweredMark | null {
  const own = answered[id];
  if (own) return own;
  const old = (PREDECESSORS[id] ?? []).map((p) => answered[p]).filter((m): m is AnsweredMark => Boolean(m));
  return old.find((m) => !m.notSure) ?? old[0] ?? null;
}

/**
 * Whether a question counts as answered: it was, or a question it replaced
 * was. The one rule progress(), the gate and "Start again" (profiles/reset.ts)
 * share, so a member who answered the old questions is never asked again and
 * never blocked.
 */
export function isAnswered(id: QuestionId, answered: AnsweredMap): boolean {
  return markFor(id, answered) !== null;
}

export function progress(a: Answers, quiz: QuizRecord): Progress {
  const qs = questionsFor(a);
  const answered = qs.filter((q) => isAnswered(q.id, quiz.answered)).map((q) => q.id);
  const next = qs.find((q) => !isAnswered(q.id, quiz.answered))?.id ?? null;
  const remaining = qs.length - answered.length;
  const mandatory = qs.filter((q) => q.mandatory).map((q) => q.id);
  const notSure = answered.filter((id) => markFor(id, quiz.answered)?.notSure).length;
  return {
    types: dealTypesFor({ goals: a.goals, about: a.about }),
    questions: qs.map((q) => q.id),
    answered,
    next,
    percent: qs.length === 0 ? 0 : Math.round((answered.length / qs.length) * 100),
    minutesLeft: remaining === 0 ? 0 : Math.max(1, Math.ceil((remaining * SECONDS_PER_QUESTION) / 60)),
    complete: next === null,
    mandatory,
    mandatoryDone: mandatory.every((id) => isAnswered(id, quiz.answered)),
    real: answered.length - notSure,
    notSure,
  };
}

/** "Profile 45%" for the header pill and the cards; "Profile" once complete. */
export function pillLabel(p: Pick<Progress, 'percent' | 'complete'>): string {
  return p.complete ? 'Profile' : `Profile ${p.percent}%`;
}

/** "about 3 minutes left" / "about 1 minute left". */
export function minutesLeftLabel(minutes: number): string {
  return `about ${minutes} minute${minutes === 1 ? '' : 's'} left`;
}

export function isMandatory(q: Question): boolean {
  return q.mandatory === true;
}

/**
 * The marks (and the answers) a member gets for what they told us before
 * the quiz existed. The welcome questions asked what they were looking for,
 * their money and where, so those count as answered; a lead form set some of
 * the same fields. Everything else is asked: a stored default cannot be told
 * from an answer, so management, risk and the rest start blank. Never called
 * twice: the seed is written with the quiz row, once.
 */
export function seedFromGoals(a: Answers, now: Date): { answers: Answers; answered: AnsweredMap } {
  const at = now.toISOString();
  const answered: AnsweredMap = {};
  let answers = a;

  // What they were looking for → which describes them, and which deals they want.
  const roles = a.goals.sourcingKind === 'rent' ? ['r2r'] : a.goals.sourcingKind === 'both' ? ['investor', 'r2r'] : ['investor'];
  const withRoles = applyAnswer('roles', roles, answers);
  if (withRoles.ok) {
    answers = withRoles.answers;
    answered.roles = { at, notSure: false };
  }
  const types = a.goals.sourcingKind === 'rent' ? ['r2r'] : a.goals.sourcingKind === 'both' ? ['buy_str', 'r2r'] : ['buy_str'];
  const withTypes = applyAnswer('deal_types', types, answers);
  if (withTypes.ok) {
    answers = withTypes.answers;
    answered.deal_types = { at, notSure: false };
  }

  // Where: a home postcode, chosen areas, or anywhere — the welcome always asked.
  const where = a.goals.home ? (a.goals.where === 'near_plus_best' ? 'near_plus_best' : 'near') : a.savedAreas.length > 0 ? 'areas' : 'anywhere';
  answers = { ...answers, goals: { ...answers.goals, where } };
  answered.where = { at, notSure: false };

  // The welcome's money questions, as they were asked then ("Not sure yet" was an answer too). The
  // marks are the old ids: they satisfy Buying cash and R2R setup cash through PREDECESSORS (Batch 30).
  const seeded = answers.goals.dealTypes ?? [];
  if (seeded.includes('buy_str')) answered.budget = { at, notSure: answers.goals.budget === null };
  if (seeded.includes('r2r')) answered.max_rent = { at, notSure: answers.goals.maxRentPcm === null };

  if (answers.goals.bedrooms !== null) answered.bedrooms = { at, notSure: false };
  const f = a.goals.finance;
  if (f.depositPct !== DEFAULT_FINANCE_GOALS.depositPct || f.mortgageRatePct !== DEFAULT_FINANCE_GOALS.mortgageRatePct) {
    answered.finance = { at, notSure: false };
    // They chose their own figures: today's average must not overwrite the rate (Batch 30).
    answers = { ...answers, goals: { ...answers.goals, finance: { ...answers.goals.finance, rateSet: true } } };
  }
  if (f.targetMarginPcm !== DEFAULT_FINANCE_GOALS.targetMarginPcm) {
    answered.min_profit = { at, notSure: false };
    // One answer then, two now: the rent-to-rent minimum starts as the same figure.
    answers = { ...answers, goals: { ...answers.goals, r2r: { ...answers.goals.r2r, minMarginPcm: answers.goals.r2r.minMarginPcm ?? f.targetMarginPcm } } };
    answered.r2r_min_profit = { at, notSure: false };
  }
  if (answers.goals.motivation.mode !== 'off') answered.motivated_sellers = { at, notSure: false };

  return { answers, answered };
}
