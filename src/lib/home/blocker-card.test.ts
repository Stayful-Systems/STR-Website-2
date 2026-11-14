import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockerCardDue, daysSinceSignup, type BlockerCardFacts } from './blocker-card.ts';

const base: BlockerCardFacts = { signedUpAt: '2026-11-10T14:00:00Z', now: new Date('2026-11-13T08:00:00Z'), cardDay: 3, blocker: null, marked: false, dismissedAt: null, packCardShowing: false };

test('day 2 no, day 3 yes (UK days; the sign-up day is day 0)', () => {
  assert.equal(daysSinceSignup(base.signedUpAt, new Date('2026-11-12T20:00:00Z')), 2);
  assert.equal(blockerCardDue({ ...base, now: new Date('2026-11-12T20:00:00Z') }), false, 'day 2');
  assert.equal(blockerCardDue(base), true, 'day 3');
  assert.equal(blockerCardDue({ ...base, now: new Date('2026-12-01T08:00:00Z') }), true, 'and every day after, until answered or dismissed');
});

test('answered, marked, or dismissed: never', () => {
  assert.equal(blockerCardDue({ ...base, blocker: 'funding' }), false, 'answered (about you)');
  assert.equal(blockerCardDue({ ...base, marked: true }), false, 'the old quiz asked it, even "Not sure"');
  assert.equal(blockerCardDue({ ...base, dismissedAt: '2026-11-13T09:00:00Z' }), false, '"Not now"');
});

test('a starter pack card showing: this one waits (one prompt card at a time)', () => {
  assert.equal(blockerCardDue({ ...base, packCardShowing: true }), false);
  assert.equal(blockerCardDue({ ...base, packCardShowing: false }), true, 'and shows once the pack cards are gone');
});

test('the day setting is read: 0 shows it from the first visit, and an unreadable sign-up date shows nothing', () => {
  assert.equal(blockerCardDue({ ...base, cardDay: 0, now: new Date('2026-11-10T15:00:00Z') }), true);
  assert.equal(blockerCardDue({ ...base, cardDay: 5 }), false);
  assert.equal(blockerCardDue({ ...base, signedUpAt: null }), false);
  assert.equal(blockerCardDue({ ...base, signedUpAt: 'never' }), false);
});

test('the day is a UK day, not a UTC one', () => {
  // Signed up 23:30 UTC on 10 June = 00:30 BST on the 11th, so on the 14th it is day 3.
  assert.equal(daysSinceSignup('2026-06-10T23:30:00Z', new Date('2026-06-14T00:10:00Z')), 3);
});
