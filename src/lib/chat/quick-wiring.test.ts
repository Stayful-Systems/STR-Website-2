/**
 * Review R4 (R4-37): the quick box's activity rows. log_activity drops an
 * identical event inside 60 seconds unless it carries a dedupe key
 * (supabase/schema.sql), so every si_chat_quick row is keyed by its turn: two
 * answers in a minute are two rows, and a retried turn is still one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('every si_chat_quick activity log in quick-server.ts carries the turn as its dedupe key', () => {
  const src = readFileSync(new URL('./quick-server.ts', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/logActivity\([^;]*'si_chat_quick'[^;]*\);/g)].map((m) => m[0]);
  assert.ok(calls.length >= 2, `found ${calls.length}`);
  for (const c of calls) assert.match(c, /dedupeKey: `si_chat_quick:\$\{turn\.id\}`/, c);
});
