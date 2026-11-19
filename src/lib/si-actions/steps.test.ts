import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextValue, priceCeilingFor } from './steps.ts';
import { budgetRestoreOf, restoreFor, sameValue, undoOpen, writtenValue } from './undo.ts';
import { applyAnswer, currentValue, type Answers } from '../profile/questions.ts';
import { DEFAULT_GOALS } from '../market/goals.ts';
import { DEFAULT_ABOUT } from '../profile/about.ts';
import { budgetFromCash } from '../profile/buying-power.ts';

// A Batch 30 member: Buy, Buying cash £30–60k on a mortgage. The cash answer wrote its own older budget.
function member(o: { cash?: '30-60' | '100-200'; funding?: 'cash' | 'btl'; budget?: Answers['goals']['budget'] } = {}): Answers {
  const cash = o.cash ?? '30-60';
  const funding = o.funding ?? 'btl';
  const budget = o.budget === undefined ? budgetFromCash(cash, funding) : o.budget;
  return { goals: { ...DEFAULT_GOALS, dealTypes: ['buy_str'], budget, buyer: { ...DEFAULT_GOALS.buyer, cashAvailable: cash, funding, cashFromBudget: false } }, about: DEFAULT_ABOUT, savedAreas: [] };
}

// Review R4 (R4-07, Zac 19 Nov 2026): "budget under £X" from Stayful Intelligence sets a price ceiling of £X only.
test('"under £100k" for a £30–60k member sets a £100k ceiling and leaves Buying cash as it was', () => {
  const a = member();
  const next = nextValue('budget', '100000', a);
  assert.ok(!('reason' in next), 'it is not "already there"');
  assert.equal(next.value, 'u100');
  assert.equal(next.label, 'Price ceiling: under £100k');
  const saved = applyAnswer('budget', next.value, a);
  assert.ok(saved.ok);
  assert.equal(saved.answers.goals.budget, 'u100');
  assert.equal(saved.answers.goals.buyer.cashAvailable, '30-60', 'Buying cash is untouched');
  assert.equal(saved.answers.goals.buyer.funding, 'btl');
});

test('a cash buyer on £100–200k asking for "under £100k" keeps their Buying cash', () => {
  const a = member({ cash: '100-200', funding: 'cash' });
  const next = nextValue('budget', 'under £100k', a);
  assert.ok(!('reason' in next) && next.value === 'u100');
  const saved = applyAnswer('budget', next.value, a);
  assert.ok(saved.ok && saved.answers.goals.buyer.cashAvailable === '100-200');
});

test('a ceiling the profile can’t hold is refused with words that say so; nothing is guessed', () => {
  assert.equal(priceCeilingFor('150000'), null);
  assert.equal(priceCeilingFor('£200k'), 'u200');
  assert.equal(priceCeilingFor('u100'), 'u100');
  const r = nextValue('budget', '150000', member());
  assert.ok('reason' in r && r.reason === 'bad_value' && /price ceiling of £100k or £200k/.test(r.message ?? ''));
});

test('Undo puts the ceiling back exactly, including none at all', () => {
  const a = member({ cash: '100-200', funding: 'btl', budget: null });
  const before = budgetRestoreOf(a.goals);
  assert.equal(undoOpen({ kind: 'change_criteria', status: 'done', finishedAt: new Date().toISOString(), undoneAt: null, before: { value: before } }, new Date(), 24), true, 'Undo is offered though there was no ceiling');
  const saved = applyAnswer('budget', 'u100', a);
  assert.ok(saved.ok);
  assert.equal(sameValue(currentValue('budget', saved.answers), writtenValue('u100')), true);
  const back = restoreFor('budget', before);
  const undone = applyAnswer(back.questionId as never, back.value, saved.answers);
  assert.ok(undone.ok);
  assert.equal(undone.answers.goals.budget, null);
  assert.equal(undone.answers.goals.buyer.cashAvailable, '100-200');
});

// Review R4 (R4-08): Buying cash, R2R setup cash and what they're after from buy to let.
test('Buying cash, R2R setup cash and the buy-to-let priority can be changed', () => {
  const a: Answers = { ...member(), goals: { ...member().goals, dealTypes: ['buy_str', 'r2r', 'btl'], r2r: { ...DEFAULT_GOALS.r2r, setupBudget: '15-20k' }, btl: { ...DEFAULT_GOALS.btl, priority: 'growth' } } };
  assert.deepEqual(nextValue('cash_available', '£75k', a), { value: '60-100', label: 'Buying cash: £60–100k' });
  assert.deepEqual(nextValue('setup_budget', '£8k', a), { value: 'u10k', label: 'R2R setup cash: Under £10k' });
  assert.deepEqual(nextValue('btl_priority', 'income', a), { value: 'income', label: 'Buy to let, what you’re after: Money each month' });
  assert.deepEqual(nextValue('cash_available', '30-60', a), { reason: 'already_there' });
});
