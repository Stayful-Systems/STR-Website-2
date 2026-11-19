import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_REPLIES, linkReplyText } from './link.ts';

// Review R4 (R4-10): what proposeActions can return for a link-only message, with the notes it writes for the model.
const PLANS: Record<string, unknown>[] = [
  { ok: true, spend_line: null, not_enough_credit: 'It needs £0.40 and they don’t have enough credit, so nothing that costs anything will run. A top-up offer shows under your answer.', stop: null },
  { ok: false, code: 'rate_limited', note: 'They have given a lot of instructions in a short time: tell them to try again a little later. Nothing was done.' },
  { ok: false, code: 'one_plan', note: 'Only one plan per answer: the first one stands.' },
  { ok: false, note: 'Something else for the model: tell them later.' },
  { ok: true, spend_line: 'Checking the listing — 3p', not_enough_credit: null },
  { ok: true, spend_line: null, dropped: [{ target: 'rightmove', why: 'Listing checks aren’t on for your account.' }] },
];

test('no link reply contains "they", "your answer" or "tell them"', () => {
  for (const plan of PLANS) {
    const text = linkReplyText(plan);
    assert.doesNotMatch(text, /\bthey\b|\bthem\b|your answer|tell them/i, text);
    assert.notEqual(text.trim(), '');
  }
});

test('each case has its own words: not enough credit, too many instructions, the spend line, a reason left out', () => {
  assert.equal(linkReplyText(PLANS[0]), LINK_REPLIES.not_enough_credit);
  assert.equal(linkReplyText(PLANS[1]), LINK_REPLIES.rate_limited);
  assert.equal(linkReplyText(PLANS[4]), 'Checking the listing — 3p.');
  assert.equal(linkReplyText(PLANS[5]), 'Listing checks aren’t on for your account.');
});
