import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCESS_COLUMNS } from '../access.ts';
import { DEFAULT_LIFECYCLE, LIFECYCLE_KEYS, parseLifecycle } from '../lifecycle/settings.ts';
import { parseLifecycleForm } from '../lifecycle/admin-form.ts';

/**
 * The Batch 30 section of supabase/schema.sql, held to the rules every
 * section follows (idempotent, functions locked) and to the lifecycle
 * defaults, so the database and the code cannot disagree.
 */
const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const start = sql.indexOf('-- Batch 30: shorter signup questions');
const after = sql.indexOf('\n-- =========================\n-- Batch', start + 1);
const section = start === -1 ? '' : sql.slice(start, after === -1 ? undefined : after);

test('the section exists and ends by reloading the schema cache', () => {
  assert.ok(section.length > 0, 'no "Batch 30" section in schema.sql');
  assert.match(section.trimEnd(), /notify pgrst, 'reload schema';$/);
});

test('every statement can run twice', () => {
  for (const m of section.matchAll(/create (unique )?(table|index)\b(?! if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/add column (?!if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/create (or replace )?function/gi)) assert.ok(m[1], `${m[0]} must be "create or replace"`);
  assert.match(section, /on conflict \(key\) do nothing;/, 'the settings insert never moves quiz_shorter_from on a second run');
  assert.equal([...sql.matchAll(/create or replace function public\.sync_live_mortgage_rate\(/g)].length, 1);
});

test('the rate sync function is locked to the service role and never touches a rate the member set', () => {
  assert.match(section, /revoke all on function public\.sync_live_mortgage_rate\(numeric, date\) from public, anon, authenticated;/);
  assert.match(section, /grant execute on function public\.sync_live_mortgage_rate\(numeric, date\) to service_role;/);
  assert.equal([...section.matchAll(/coalesce\(\w+->'finance'->>'rateSet', 'false'\) <> 'true'/g)].length, 2, 'both the live profile and every saved search skip a member-set rate');
  const code = section.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /market_goals_updated_at/, 'the sync is not the member changing their goals');
});

test('no ACCESS_COLUMNS change: nothing in this section is a member-readable column', () => {
  assert.doesNotMatch(section, /grant (select|update|all)/i);
  assert.ok(!JSON.stringify(ACCESS_COLUMNS).includes('blocker_card_dismissed_at'));
});

test('the settings the section seeds match the code defaults', () => {
  assert.match(section, /\('home_blocker_card_day', '3'::jsonb\)/);
  assert.equal(DEFAULT_LIFECYCLE.homeBlockerCardDay, 3);
  assert.match(section, /\('quiz_shorter_from', to_jsonb\(now\(\)\)\)/);
  assert.equal(DEFAULT_LIFECYCLE.quizShorterFrom, null);
  const get = (k: string) => ({ [LIFECYCLE_KEYS.homeBlockerCardDay]: 0, [LIFECYCLE_KEYS.quizShorterFrom]: '2026-11-14T10:00:00.123+00:00' })[k];
  const s = parseLifecycle(get);
  assert.equal(s.homeBlockerCardDay, 0, '0 is allowed (a test shows the card from the first visit)');
  assert.equal(s.quizShorterFrom, '2026-11-14T10:00:00.123Z');
  assert.equal(parseLifecycle(() => 'junk').homeBlockerCardDay, 3);
  assert.equal(parseLifecycle(() => 'junk').quizShorterFrom, null);
});

test('the admin form saves the two new settings only when it sends them', () => {
  const base: Record<string, string> = { starter_pack_price_pence: '1000', starter_pack_credit_pence: '3000', starter_pack_snooze_days: '7', low_credit_pence: '500', inactive_reengage_days: '14', picks_pause_inactive_days: '25', starter_pack_from: '', inactivity_from: '' };
  const run = (extra: Record<string, string>) => parseLifecycleForm((n) => ({ ...base, ...extra })[n] ?? null, new Date('2026-11-14T10:00:00Z'));
  const without = run({});
  assert.ok(without.ok && !(LIFECYCLE_KEYS.homeBlockerCardDay in without.values) && !(LIFECYCLE_KEYS.quizShorterFrom in without.values), 'an older form changes neither');
  const day = run({ home_blocker_card_day: '0' });
  assert.ok(day.ok && day.values[LIFECYCLE_KEYS.homeBlockerCardDay] === 0);
  assert.equal(run({ home_blocker_card_day: '-1' }).ok, false);
  const now = run({ quiz_shorter_from_now: '1' });
  assert.ok(now.ok && now.values[LIFECYCLE_KEYS.quizShorterFrom] === '2026-11-14T10:00:00.000Z');
  assert.equal(run({ quiz_shorter_from: 'not a date' }).ok, false);
});
