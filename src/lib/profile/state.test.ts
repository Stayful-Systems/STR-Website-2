import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_QUIZ, SECONDS_PER_QUESTION, minutesLeftLabel, parseAnswered, parseQuizRow, pillLabel, progress, seedFromGoals, type AnsweredMap, type QuizRecord } from './state.ts';
import { applyAnswer, emptyAnswers, questionsFor, type Answers, type QuestionId } from './questions.ts';
import { DEFAULT_GOALS, parseMarketGoals } from '../market/goals.ts';

const NOW = new Date('2026-09-28T09:00:00Z');
const AT = NOW.toISOString();

const fresh = (): Answers => emptyAnswers(DEFAULT_GOALS, null, []);
const quiz = (answered: AnsweredMap, over: Partial<QuizRecord> = {}): QuizRecord => ({ ...EMPTY_QUIZ, answered, ...over });

function answer(a: Answers, id: QuestionId, value: unknown): Answers {
  const r = applyAnswer(id, value, a);
  assert.ok(r.ok, `${id}: ${r.ok ? '' : r.error}`);
  return r.answers;
}

test('a new member: nothing answered, the first question next, the gate closed', () => {
  const p = progress(fresh(), EMPTY_QUIZ);
  assert.equal(p.percent, 0);
  assert.equal(p.next, 'deal_types');
  assert.equal(p.complete, false);
  assert.equal(p.mandatoryDone, false);
  assert.deepEqual(p.mandatory, ['deal_types', 'where']);
  assert.deepEqual(p.types, [], 'no deal types yet, and nothing throws');
  assert.ok(p.minutesLeft >= 1);
  assert.equal(pillLabel(p), 'Profile 0%');
});

test('answers move the bar, "Not sure" counts for the bar but not as real, and the last one completes it', () => {
  let a = answer(fresh(), 'deal_types', ['buy_str']);
  a = answer(a, 'where', { mode: 'anywhere' });
  a = answer(a, 'cash_available', '30-60');
  const marks: AnsweredMap = { deal_types: { at: AT, notSure: false }, where: { at: AT, notSure: false }, cash_available: { at: AT, notSure: false } };
  let p = progress(a, quiz(marks));
  assert.equal(p.mandatoryDone, true, 'the mandatory answers open the app');
  assert.deepEqual(p.mandatory, ['deal_types', 'where', 'cash_available']);
  assert.deepEqual(p.types, ['buy_str']);
  assert.equal(p.next, 'funding', 'straight on to question 4');
  assert.equal(p.answered.length, 3);
  assert.equal(p.real, 3);
  const total = questionsFor(a).length;
  assert.equal(total, 12);
  assert.equal(p.percent, Math.round((3 / total) * 100));
  assert.equal(p.minutesLeft, Math.ceil(((total - 3) * SECONDS_PER_QUESTION) / 60));

  for (const q of questionsFor(a)) marks[q.id] = marks[q.id] ?? { at: AT, notSure: q.id === 'property' };
  p = progress(a, quiz(marks));
  assert.equal(p.complete, true);
  assert.equal(p.percent, 100);
  assert.equal(p.next, null);
  assert.equal(p.minutesLeft, 0);
  assert.equal(p.notSure, 1);
  assert.equal(p.real, total - 1);
  assert.equal(pillLabel(p), 'Profile');
});

test('a question that stops applying drops out of the count; marks for it are ignored', () => {
  const a = answer(fresh(), 'deal_types', ['buy_str', 'r2r']);
  const marks: AnsweredMap = { deal_types: { at: AT, notSure: false }, cash_available: { at: AT, notSure: false }, setup_budget: { at: AT, notSure: false }, funding: { at: AT, notSure: true } };
  const both = progress(a, quiz(marks));
  assert.ok(both.questions.includes('setup_budget') && both.answered.includes('setup_budget'));
  assert.ok(both.answered.includes('funding'));
  assert.equal(both.notSure, 1);
  const buyOnly = progress(answer(a, 'deal_types', ['buy_str']), quiz(marks));
  assert.ok(!buyOnly.questions.includes('setup_budget'), 'a rent-to-rent question is not this member’s');
  assert.ok(!buyOnly.answered.includes('setup_budget'));
  const r2rOnly = progress(answer(a, 'deal_types', ['r2r']), quiz(marks));
  assert.ok(!r2rOnly.questions.includes('cash_available') && !r2rOnly.answered.includes('cash_available'), 'and the other way round');
});

test('the mandatory questions are one money question per chosen type (Q27)', () => {
  const marks: AnsweredMap = { deal_types: { at: AT, notSure: false }, where: { at: AT, notSure: false } };
  const two = answer(fresh(), 'deal_types', ['buy_str', 'r2r']);
  const p = progress(two, quiz(marks));
  assert.deepEqual(p.mandatory, ['deal_types', 'where', 'setup_budget', 'cash_available']);
  assert.equal(p.mandatoryDone, false);
  assert.equal(p.next, 'setup_budget');
  const all = answer(two, 'deal_types', ['all']);
  assert.deepEqual(progress(all, quiz(marks)).mandatory, ['deal_types', 'where', 'setup_budget', 'cash_available', 'btl_priority'], 'All: Buying cash once, R2R setup cash, and Buy to let’s priority');
  const before = answer(two, 'deal_types', ['buy_str', 'brrr', 'r2r']);
  assert.deepEqual(progress(before, quiz(marks)).mandatory, ['deal_types', 'where', 'setup_budget', 'cash_available'], 'an "All" profile from before Buy to let: as it was');
  const exploring = answer(fresh(), 'deal_types', ['exploring']);
  assert.deepEqual(progress(exploring, EMPTY_QUIZ).mandatory, ['deal_types', 'where', 'setup_budget', 'cash_available', 'btl_priority'], 'exploring is shown every type');
  assert.deepEqual(progress(answer(fresh(), 'deal_types', ['r2r']), EMPTY_QUIZ).mandatory, ['deal_types', 'where', 'setup_budget'], 'R2R alone: no buying question');
});

test('Batch 30: a member who answered the old questions is never blocked and never asked again', () => {
  const m = (...ids: QuestionId[]): AnsweredMap => Object.fromEntries(ids.map((id) => [id, { at: AT, notSure: false }]));
  // A buyer from before: roles, deal types, where, budget — and a rent-to-rent one with a rent ceiling.
  const buyer = answer(answer(fresh(), 'roles', ['investor']), 'deal_types', ['buy_str']);
  const pb = progress(buyer, quiz(m('roles', 'deal_types', 'where', 'budget', 'deals_done', 'units_now', 'leasehold', 'restricted_areas', 'property_type', 'bedrooms', 'r2r_min_profit')));
  assert.equal(pb.mandatoryDone, true);
  for (const id of ['cash_available', 'stage', 'property', 'short_let_rules', 'min_profit'] as QuestionId[]) assert.ok(pb.answered.includes(id), `${id} counts: the old question was answered`);
  assert.ok(!pb.answered.includes('funding') && pb.next === 'funding', 'what was never asked is still asked');
  const rent = answer(answer(fresh(), 'roles', ['r2r']), 'deal_types', ['r2r']);
  assert.equal(progress(rent, quiz(m('roles', 'deal_types', 'where', 'max_rent'))).mandatoryDone, true);
  const brrr = answer(answer(fresh(), 'roles', ['investor']), 'deal_types', ['brrr']);
  assert.equal(progress(brrr, quiz(m('roles', 'deal_types', 'where', 'brrr_budget'))).mandatoryDone, true);
  const btl = answer(answer(fresh(), 'roles', ['investor']), 'deal_types', ['btl']);
  assert.equal(progress(btl, quiz(m('roles', 'deal_types', 'where', 'btl_cash', 'btl_priority'))).mandatoryDone, true);
  // A "Not sure" on the old question carries over as not real.
  const unsure = progress(buyer, quiz({ ...m('roles', 'deal_types', 'where'), budget: { at: AT, notSure: true } }));
  assert.ok(unsure.answered.includes('cash_available'));
  assert.equal(unsure.notSure, 1);
  // A new member has to answer what they are looking for, where, and their cash.
  const fresh30 = progress(answer(fresh(), 'deal_types', ['buy_str']), quiz(m('deal_types')));
  assert.equal(fresh30.mandatoryDone, false);
  assert.equal(fresh30.next, 'where');
  assert.equal(progress(answer(fresh(), 'deal_types', ['buy_str']), quiz(m('deal_types', 'where'))).mandatoryDone, false, 'Buying cash is still to answer');
  // A mark for a question and its predecessor count once.
  assert.equal(progress(buyer, quiz(m('deal_types', 'where', 'cash_available', 'budget'))).answered.filter((id) => id === 'cash_available').length, 1);

});

test('a member from before the quiz is seeded from what they already told us', () => {
  const stored = parseMarketGoals({ version: 1, home: { postcode: 'NG2 5GB', lat: 52.9, lng: -1.1 }, maxDistanceMiles: 25, budget: '200-350', bedrooms: 2, sourcingKind: 'sale', finance: { depositPct: 20, mortgageRatePct: 6 } })!;
  const { answers, answered } = seedFromGoals(emptyAnswers(stored, null, []), NOW);
  assert.deepEqual(answers.about.roles, ['investor']);
  assert.equal(answers.goals.path, 'buy');
  assert.equal(answers.goals.where, 'near');
  assert.deepEqual(Object.keys(answered).sort(), ['bedrooms', 'budget', 'deal_types', 'finance', 'roles', 'where']);
  assert.deepEqual(answers.goals.dealTypes, ['buy_str']);
  assert.equal(answered.budget?.notSure, false);
  const p = progress(answers, quiz(answered));
  assert.equal(p.mandatoryDone, true, 'never blocked: they answered the welcome questions');
  assert.ok(p.percent > 0 && p.percent < 100, 'part-way up the bar');
  assert.equal(p.next, 'funding');
  assert.equal(answers.goals.finance.rateSet, true, 'their own deposit and rate are theirs: today’s average will not overwrite them');
});

test('seeding: "not sure yet" on money counts as answered but not real; both kinds leave the main role open; areas and anywhere are kept', () => {
  const rent = parseMarketGoals({ version: 1, sourcingKind: 'rent', maxRentPcm: null })!;
  const r = seedFromGoals(emptyAnswers(rent, null, ['NG']), NOW);
  assert.deepEqual(r.answers.about.roles, ['r2r']);
  assert.equal(r.answers.goals.where, 'areas');
  assert.equal(r.answered.max_rent?.notSure, true);
  assert.equal(progress(r.answers, quiz(r.answered)).mandatoryDone, true);

  const both = seedFromGoals(emptyAnswers(parseMarketGoals({ version: 1, sourcingKind: 'both', finance: { targetMarginPcm: 700 } })!, null, []), NOW);
  assert.deepEqual(both.answers.about.roles, ['investor', 'r2r']);
  assert.deepEqual(both.answers.goals.dealTypes, ['buy_str', 'r2r']);
  assert.equal(both.answers.goals.where, 'anywhere');
  assert.equal(both.answered.budget?.notSure, true, 'a money question per type, "not sure yet" as then');
  assert.equal(both.answered.max_rent?.notSure, true);
  assert.equal(both.answers.goals.r2r.minMarginPcm, 700, 'the one minimum they gave then is the rent-to-rent one too');
  const p = progress(both.answers, quiz(both.answered));
  assert.equal(p.mandatoryDone, true);
  assert.equal(p.next, 'funding');
});

test('quiz rows and marks are read tolerantly', () => {
  assert.equal(parseQuizRow(null), null);
  const rec = parseQuizRow({ started_at: AT, completed_at: null, last_question: 'budget', answered: { roles: { at: AT, notSure: false }, nope: { at: AT }, where: { at: 'never' }, risk: { at: AT, notSure: 'yes' } }, credit_grant_id: 'g1', reminder_collapsed_day: '2026-09-28' })!;
  assert.equal(rec.startedAt, AT);
  assert.equal(rec.lastQuestion, 'budget');
  assert.deepEqual(rec.answered, { roles: { at: AT, notSure: false }, risk: { at: AT, notSure: false } });
  assert.equal(rec.creditGrantId, 'g1');
  assert.equal(rec.reminderCollapsedDay, '2026-09-28');
  assert.equal(parseQuizRow({ last_question: 'made_up' })!.lastQuestion, null);
  assert.deepEqual(parseAnswered('junk'), {});
  assert.equal(minutesLeftLabel(1), 'about 1 minute left');
  assert.equal(minutesLeftLabel(4), 'about 4 minutes left');
});
