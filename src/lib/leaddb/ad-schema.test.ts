import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCESS_COLUMNS } from '../access.ts';

/**
 * The "Batch 55 step 2" section of supabase/schema.sql, held to the rules every section follows (idempotent, service
 * role only, ends by reloading the schema cache). supabase/tests/batch55-smoke.sql checks what the database enforces.
 */
const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const HEADER = '-- =========================\n-- Batch 55 step 2: calculator leads go to the lead database as ad leads\n-- =========================';
const start = sql.indexOf('-- Batch 55 step 2: calculator leads go to the lead database as ad leads');
const after = sql.indexOf('\n-- =========================\n-- Batch', start + 1);
const section = start === -1 ? '' : sql.slice(start, after === -1 ? undefined : after);

const COLUMNS = [
  'lead_id', 'owner_id', 'ld_customer_id', 'status', 'phase_sent', 'attempts', 'next_attempt_at', 'lease_until', 'billable',
  'billable_reason', 'low_data', 'repeat_of_lead_id', 'outcome', 'last_error', 'created_at', 'updated_at',
];

test('the section has the exact header, comes after Batch 55 Part A and Batch 32, and ends by reloading the schema cache', () => {
  assert.ok(sql.includes(`\n${HEADER}\n`), 'the header is not exact');
  assert.ok(start > sql.indexOf('-- Batch 55 (Part A): the lead database ad route'));
  assert.ok(start > sql.indexOf('-- Batch 32: website leads go into the operator'));
  assert.match(section.trimEnd(), /notify pgrst, 'reload schema';$/);
});

test('every statement can run twice, and nothing else is added (no function, no policy, no grant)', () => {
  for (const m of section.matchAll(/create (unique )?(table|index)\b(?! if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/add column (?!if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/add constraint (\w+)/g)) assert.ok(section.includes(`drop constraint if exists ${m[1]};`), `${m[1]} is added without a guard`);
  assert.doesNotMatch(section, /create policy|create (or replace )?function|grant [^;]* to (anon|authenticated)\b/i);
});

test('leaddb_ad_deliveries: the columns, one row per lead, service role only', () => {
  const tables = [...section.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, ['leaddb_ad_deliveries']);
  const body = section.slice(section.indexOf('create table if not exists public.leaddb_ad_deliveries'), section.indexOf('alter table public.leaddb_ad_deliveries drop constraint'));
  const cols = [...body.matchAll(/^  (\w+) (?:uuid|text|integer|boolean|timestamptz)\b/gm)].map((m) => m[1]);
  assert.deepEqual(cols, COLUMNS);
  assert.match(body, /lead_id uuid primary key references public\.leads\(id\) on delete cascade/);
  assert.match(section, /status in \('pending', 'sent', 'failed'\)/);
  assert.match(section, /phase_sent is null or phase_sent in \('lead', 'report', 'report_failed'\)/);
  assert.match(section, /billable_reason is null or billable_reason in \('report_ran', 'low_data', 'repeat', 'test', 'no_figures'\)/);
  assert.match(section, /alter table public\.leaddb_ad_deliveries enable row level security;/);
  assert.match(section, /revoke all on public\.leaddb_ad_deliveries from anon, authenticated;/);
});

test('the account and lead columns, and none of it is in ACCESS_COLUMNS', () => {
  for (const c of ['unpaid_hold boolean not null default false', 'unpaid_hold_as_of timestamptz', 'owed_pence integer', 'pack_notice_pending boolean not null default false', 'pack_notice_sent_at timestamptz']) {
    assert.ok(section.includes(`alter table public.leaddb_ad_accounts add column if not exists ${c};`), c);
  }
  assert.ok(section.includes('alter table public.leads add column if not exists ld_stage_as_of timestamptz;'));
  const access = ACCESS_COLUMNS.split(',').map((c) => c.trim());
  for (const c of ['ld_stage_as_of', 'unpaid_hold', 'owed_pence', 'pack_notice_pending']) assert.ok(!access.includes(c), c);
});
