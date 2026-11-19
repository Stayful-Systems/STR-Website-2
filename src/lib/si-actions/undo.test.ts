import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimumWrite, restoreFor, sameValue, stageRestore, stageUnchanged, undoLine, undoOpen, undoUntil, writtenValue, type StageState } from './undo.ts';
import { applyAnswer, currentValue, type Answers } from '../profile/questions.ts';
import { DEFAULT_GOALS } from '../market/goals.ts';
import { DEFAULT_ABOUT } from '../profile/about.ts';

const now = new Date('2026-10-16T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

test('Undo is open for 24 hours on a done, undoable step, once', () => {
  assert.equal(undoOpen({ kind: 'pass', status: 'done', finishedAt: hoursAgo(23), undoneAt: null }, now, 24), true);
  assert.equal(undoOpen({ kind: 'pass', status: 'done', finishedAt: hoursAgo(25), undoneAt: null }, now, 24), false);
  assert.equal(undoOpen({ kind: 'pass', status: 'done', finishedAt: hoursAgo(1), undoneAt: hoursAgo(0.5) }, now, 24), false);
  assert.equal(undoOpen({ kind: 'pass', status: 'failed', finishedAt: hoursAgo(1), undoneAt: null }, now, 24), false);
});

test('a profile change with no earlier answer has no Undo (there is nothing to put back)', () => {
  const at = { kind: 'change_criteria' as const, status: 'done' as const, finishedAt: hoursAgo(1), undoneAt: null };
  assert.equal(undoOpen({ ...at, before: { value: null } }, now, 24), false);
  assert.equal(undoOpen({ ...at, before: null }, now, 24), false);
  assert.equal(undoOpen({ ...at, before: { value: 2 } }, now, 24), true);
});

test('a charge is never undone: analyses, searches and link checks have no Undo', () => {
  for (const kind of ['full_analysis', 'deep_report', 'deep_search', 'check_link'] as const) {
    assert.equal(undoOpen({ kind, status: 'done', finishedAt: hoursAgo(1), undoneAt: null }, now, 24), false, kind);
  }
});

test('the window runs from the last step to finish', () => {
  assert.equal(undoUntil([hoursAgo(3), null, hoursAgo(1)], 24), new Date(now.getTime() + 23 * 3_600_000).toISOString());
  assert.equal(undoUntil([null], 24), null);
});

const s = (stage: StageState['stage'], reaction: StageState['reaction'], row: string | null = null): StageState => ({ stage, reaction, checkedListingId: row });

test('a stage step is put back only if it is still as the step left it', () => {
  assert.equal(stageUnchanged(s('passed', 'pass'), s('passed', 'pass')), true);
  assert.equal(stageUnchanged(s('watching', 'keep'), s('passed', 'pass')), false);
});

test('how a stage step is put back', () => {
  assert.equal(stageRestore(s('watching', 'keep'), s('passed', 'pass')), 'stage');
  assert.equal(stageRestore(s(null, null), s('watching', 'keep')), 'clear');
  assert.equal(stageRestore(s(null, null), s('contacted', 'keep', 'row-1')), 'clear_and_row');
});

test('answers compare by value, whatever the key order', () => {
  assert.equal(sameValue({ mode: 'areas', areas: ['LS', 'BD'] }, { areas: ['LS', 'BD'], mode: 'areas' }), true);
  assert.equal(sameValue(['brrr', 'r2r'], ['r2r', 'brrr']), false);
  assert.equal(sameValue(2, '2'), false);
  assert.equal(sameValue(undefined, null), true);
});

test('what Undo says', () => {
  assert.equal(undoLine({ undone: 4, changed: 0, failed: 0 }), 'Done — put all 4 back.');
  assert.equal(undoLine({ undone: 1, changed: 0, failed: 0 }), 'Done — put back.');
  assert.equal(undoLine({ undone: 3, changed: 1, failed: 0 }), 'Put back 3 of 4. 1 had changed since, so I left it.');
  assert.equal(undoLine({ undone: 0, changed: 2, failed: 0 }), 'Nothing put back: it has changed since, so I left it.');
});

// Review R4 (R4-05, Zac 19 Nov 2026): the two minimum-profit figures stay separate, and Undo puts both back.
test('undoing a rent-to-rent minimum change for a member with two minimums restores both', () => {
  // An older Buy + R2R member: buying minimum £800, rent-to-rent £300. "Drop my rent-to-rent minimum to £250."
  const a: Answers = { goals: { ...DEFAULT_GOALS, dealTypes: ['buy_str', 'r2r'], finance: { ...DEFAULT_GOALS.finance, targetMarginPcm: 800 }, r2r: { ...DEFAULT_GOALS.r2r, minMarginPcm: 300 } }, about: DEFAULT_ABOUT, savedAreas: [] };
  const w = minimumWrite('r2r_min_profit', 250, a.goals);
  assert.equal(w.savedAs, 'r2r_min_profit', 'its own question, never the one minimum');
  assert.deepEqual(w.before, { buy: 800, r2r: 300 });
  const changed = applyAnswer(w.savedAs, w.value, a);
  assert.ok(changed.ok);
  assert.equal(changed.answers.goals.r2r.minMarginPcm, 250);
  assert.equal(changed.answers.goals.finance.targetMarginPcm, 800, 'the buying minimum is untouched');
  // Undo: the step is still as it left it, and both figures go back exactly.
  assert.equal(sameValue(currentValue(w.savedAs, changed.answers), writtenValue(w.value)), true);
  const back = restoreFor(w.savedAs, w.before);
  const undone = applyAnswer(back.questionId as never, back.value, changed.answers);
  assert.ok(undone.ok);
  assert.equal(undone.answers.goals.finance.targetMarginPcm, 800);
  assert.equal(undone.answers.goals.r2r.minMarginPcm, 300);
  // A buying-minimum change for the same member writes only the buying figure, and is undone the same way.
  const buy = minimumWrite('min_profit', 650, a.goals);
  assert.deepEqual(buy.value, { pcm: 650, only: 'buy' });
  const bought = applyAnswer(buy.savedAs, buy.value, a);
  assert.ok(bought.ok);
  assert.equal(bought.answers.goals.r2r.minMarginPcm, 300, 'the rent-to-rent minimum never moves');
  assert.equal(sameValue(currentValue(buy.savedAs, bought.answers), writtenValue(buy.value)), true);
  const buyBack = applyAnswer(restoreFor(buy.savedAs, buy.before).questionId as never, restoreFor(buy.savedAs, buy.before).value, bought.answers);
  assert.ok(buyBack.ok && buyBack.answers.goals.finance.targetMarginPcm === 800 && buyBack.answers.goals.r2r.minMarginPcm === 300);
  // A member whose figures are equal (a new member's one answer): the one minimum, both figures, as Batch 30 built it.
  const one = minimumWrite('min_profit', 400, { finance: { targetMarginPcm: 500 }, r2r: { minMarginPcm: 500 } });
  assert.equal(one.value, 400);
  // An older step that kept a single figure is put back as before.
  assert.deepEqual(restoreFor('bedrooms', '3'), { questionId: 'bedrooms', value: '3' });
});
