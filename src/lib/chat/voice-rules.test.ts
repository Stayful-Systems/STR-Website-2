import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHARS_PER_WORD, followOnAllowed, listenSeconds, QUICK_MAX_WORDS, speakCharsFor, speakPricePence, spokenFor, VOICE_FOLLOW_ONS_MAX } from './voice-rules.ts';

// The seed row: 0.01738p a character × 5 (src/lib/credit/costs.ts).
const ROW = { unitCostPence: 0.01738, markup: 5 };

test('a spoken answer is priced from the character row, markup included, for the surface’s word cap', () => {
  assert.equal(speakCharsFor(QUICK_MAX_WORDS), Math.round(QUICK_MAX_WORDS * CHARS_PER_WORD));
  // 60 words ≈ 330 characters ≈ 29p: the figure the review found, now the figure the member is told.
  assert.equal(speakPricePence(ROW, speakCharsFor(60)), 28.677);
  assert.equal(speakPricePence(ROW, speakCharsFor(80)), 38.236);
  assert.equal(speakPricePence(ROW, 0), null);
  assert.equal(speakPricePence(null, 330), null);
  assert.equal(speakPricePence({ unitCostPence: 0, markup: 5 }, 330), null);
  assert.equal(speakCharsFor(Number.NaN), 0);
});

test('after a spoken answer it listens again once per tap, then waits for a tap', () => {
  assert.equal(VOICE_FOLLOW_ONS_MAX, 1);
  assert.equal(followOnAllowed(0), true);
  assert.equal(followOnAllowed(1), false);
  assert.equal(followOnAllowed(5), false);
  assert.equal(followOnAllowed(-1), false);
  assert.equal(followOnAllowed(1, 2), true);
});

test('listening is charged for what was heard, never more than the page declared, within the cap', () => {
  assert.equal(listenSeconds({ declared: 12.4, heard: 7.2, max: 30 }), 8);
  assert.equal(listenSeconds({ declared: 12.4, heard: 20, max: 30 }), 13);
  assert.equal(listenSeconds({ declared: 12.4, heard: null, max: 30 }), 13);
  assert.equal(listenSeconds({ declared: 0.2, heard: 0.1, max: 30 }), 1);
  assert.equal(listenSeconds({ declared: 90, heard: 45, max: 30 }), 30);
  assert.equal(listenSeconds({ declared: Number.NaN, heard: null, max: 30 }), 30);
});

// Review R4 (R4-34): the guard for Review R3's R3-7.
test('R3-7: only an answer is read aloud; a free outcome is never spoken', () => {
  assert.equal(spokenFor({ state: 'answer', text: 'Between 50p and £3 to open a deal.' }), 'Between 50p and £3 to open a deal.');
  for (const state of ['unknown', 'top_up', 'full_view', 'failed', 'out_of_room', 'did_not_finish', 'seat_paused', 'uncharged_cap', 'off']) {
    assert.equal(spokenFor({ state, text: 'Some line the page shows' }), null, state);
  }
  assert.equal(spokenFor({ state: 'answer', text: '' }), null);
  assert.equal(spokenFor({ state: 'answer', text: null }), null);
});

test('R3-7: both chat surfaces decide what to speak with spokenFor, and end the spoken turn otherwise', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['QuickChat.tsx', 'FullChat.tsx']) {
    const src = readFileSync(new URL(`../../components/intelligence/chat/${file}`, import.meta.url), 'utf8');
    assert.match(src, /import \{[^}]*spokenFor[^}]*\} from "@\/lib\/chat\/voice-rules"/, file);
    assert.match(src, /const spoken = spokenFor\((r|reply)\);\s*if \(spoken\) spokenReply = spoken;\s*else voice\.endConversation\(\);/, file);
    // Nothing else sets what is spoken.
    assert.equal(src.match(/spokenReply = /g)?.length, 1, file);
  }
});
