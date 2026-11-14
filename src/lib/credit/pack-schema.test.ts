import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCESS_COLUMNS } from '../access.ts';
import { DEFAULT_LIFECYCLE, LIFECYCLE_KEYS, parseLifecycle } from '../lifecycle/settings.ts';

/**
 * The Batch 29 section of supabase/schema.sql, held to the rules every
 * section follows (idempotent, service role only, functions locked) and to
 * the lifecycle defaults, so the database and the code cannot disagree.
 * CI also runs the whole file twice and diffs schema and data, and
 * supabase/tests/pack-smoke.sql checks what the functions do.
 */
const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const start = sql.indexOf('-- Batch 29: starter pack guardrails and the pay-again measure');
const after = sql.indexOf('\n-- =========================\n-- Batch', start + 1);
const section = start === -1 ? '' : sql.slice(start, after === -1 ? undefined : after);

const PACK_KEYS = [
  'packBonusExpiryDays',
  'packFreshReportCap',
  'packEarlyOfferPence',
  'packPicksPauseDays',
  'placesCacheDays',
  'packPayingHeadlineFloorPct',
  'packPayingHeadlineTargetPct',
  'packPayingRundownPaidFloorPct',
  'packPayingRundownPaidTargetPct',
  'packCostTargetPence',
  'packCostCeilingPence',
] as const;

test('the section exists and ends by reloading the schema cache', () => {
  assert.ok(section.length > 0, 'no "Batch 29" section in schema.sql');
  assert.match(section.trimEnd(), /notify pgrst, 'reload schema';$/);
});

test('every statement can run twice', () => {
  for (const m of section.matchAll(/create (unique )?(table|index)\b(?! if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/add column (?!if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/add constraint (\w+)/g)) assert.ok(section.includes(`drop constraint if exists ${m[1]};`), `${m[1]} is added without a guard`);
  for (const m of section.matchAll(/create (or replace )?function/gi)) assert.ok(m[1], `${m[0]} must be "create or replace"`);
  for (const m of section.matchAll(/create trigger (\w+)/g)) assert.ok(section.includes(`drop trigger if exists ${m[1]} `), `${m[1]} is created without a drop`);
  assert.match(section, /on conflict \(key\) do nothing;/);
  // The backfill runs once (its marker), never on a second run of the file.
  assert.match(section, /batch29_pack_bonus_marked_at/);
});

test('one create or replace per function in the whole file (R3i): Batch 29 edited the credit functions in place', () => {
  for (const name of ['credit_reserve', 'credit_debit', 'credit_debit_face', 'credit_refund', 'credit_expire_due', 'credit_bonus_pays_for', 'credit_spendable_for', 'credit_face_available_for']) {
    const n = [...sql.matchAll(new RegExp(`create or replace function public\\.${name}\\(`, 'g'))].length;
    assert.equal(n, 1, `${name} is defined ${n} times`);
  }
});

test('the new table is service role only, and every function is locked', () => {
  const tables = [...section.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, ['pack_fresh_reports']);
  assert.match(section, /alter table public\.pack_fresh_reports enable row level security;/);
  assert.match(section, /revoke all on public\.pack_fresh_reports from anon, authenticated;/);
  assert.doesNotMatch(section, /create policy/i);
  assert.doesNotMatch(section, /grant [^;]* to (anon|authenticated)\b/i);
  for (const m of section.matchAll(/create or replace function public\.(\w+)\(/g)) {
    assert.match(section, new RegExp(`revoke all on function public\\.${m[1]}\\([^)]*\\) from public, anon, authenticated;`), m[1]);
    assert.match(section, new RegExp(`grant execute on function public\\.${m[1]}\\([^)]*\\) to service_role;`), m[1]);
  }
});

test('ACCESS_COLUMNS is unchanged: nothing Batch 29 adds to profiles is an access column', () => {
  const added = [...section.matchAll(/alter table public\.profiles add column if not exists (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(added.sort(), ['pack_offer_dismissed_at', 'pack_offer_emailed_at', 'pack_offer_home_at', 'pack_picks_back_at', 'pack_picks_note_at', 'picks_paused_reason'].sort());
  const access = ACCESS_COLUMNS.split(',').map((c) => c.trim());
  for (const c of added) assert.ok(!access.includes(c), `${c} must not be an access column`);
  assert.ok(!access.some((c) => c.startsWith('pack_') || c === 'scope'), 'no pack column in ACCESS_COLUMNS');
});

test('the seeded settings are the lifecycle defaults', () => {
  const rows: Record<string, unknown> = {};
  for (const m of section.matchAll(/\('((?:pack|places)_\w+)', '([^']*)'\)/g)) rows[m[1]] = JSON.parse(m[2]);
  assert.deepEqual(Object.keys(rows).sort(), PACK_KEYS.map((k) => LIFECYCLE_KEYS[k]).sort());
  // The stored values themselves (not only what parsing falls back to) are the code's defaults.
  for (const k of PACK_KEYS) assert.equal(rows[LIFECYCLE_KEYS[k]], DEFAULT_LIFECYCLE[k], k);
  const parsed = parseLifecycle((key) => rows[key]);
  for (const k of PACK_KEYS) assert.equal(parsed[k], DEFAULT_LIFECYCLE[k], k);
});
