import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCESS_COLUMNS } from '../access.ts';

/**
 * The "Batch 55 step 5 (Phase 1)" section of supabase/schema.sql, held to the rules every section follows (idempotent,
 * no table, function, policy or grant, ends by reloading the schema cache). supabase/tests/batch55-smoke.sql checks
 * what the database enforces.
 */
const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const TITLE = '-- Batch 55 step 5 (Phase 1): the customer\'s brand comes across from the lead database';
const start = sql.indexOf(TITLE);
const after = sql.indexOf('\n-- =========================\n-- Batch', start + 1);
const section = start === -1 ? '' : sql.slice(start, after === -1 ? undefined : after);

test('the section exists after Batch 55 step 2 and ends by reloading the schema cache', () => {
  assert.ok(section.length > 0);
  assert.ok(sql.includes(`-- =========================\n${TITLE}\n-- =========================`));
  assert.ok(start > sql.indexOf('-- Batch 55 step 2: calculator leads go to the lead database as ad leads'));
  assert.match(section.trimEnd(), /notify pgrst, 'reload schema';$/);
});

test('every statement can run twice, and nothing else is added', () => {
  for (const m of section.matchAll(/create (unique )?(table|index)\b/gi)) assert.fail(`no table or index here: ${m[0]}`);
  for (const m of section.matchAll(/add column (?!if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/add constraint (\w+)/g)) assert.ok(section.includes(`drop constraint if exists ${m[1]};`), `${m[1]} is added without a guard`);
  assert.doesNotMatch(section, /create policy|create (or replace )?function|grant [^;]* to (anon|authenticated)\b/i);
});

test('the columns, and none of them is in ACCESS_COLUMNS', () => {
  for (const line of [
    'alter table public.leaddb_ad_accounts add column if not exists profile_as_of timestamptz;',
    'alter table public.leaddb_ad_accounts add column if not exists profile_pushed jsonb;',
    "alter table public.websites add column if not exists settings_edited jsonb not null default '{}'::jsonb;",
    'alter table public.ad_pack_ads add column if not exists concept_id text;',
    'alter table public.ad_pack_ads add column if not exists format text;',
  ]) assert.ok(section.includes(line), line);
  const access = ACCESS_COLUMNS.split(',').map((c) => c.trim());
  for (const c of ['profile_as_of', 'profile_pushed', 'settings_edited', 'concept_id', 'format']) assert.ok(!access.includes(c), c);
});
