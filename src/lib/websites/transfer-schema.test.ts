import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCESS_COLUMNS } from '../access.ts';
import { WEBSITE_STATUSES } from './types.ts';

/**
 * The Batch 37 section of supabase/schema.sql, held to the rules every
 * section follows (idempotent, service role only), so a re-run of the file is
 * safe. CI also runs the whole file twice and diffs schema and data, and
 * supabase/tests/website-transfers-smoke.sql checks what the table enforces
 * (one open transfer per site, a unique ref, the checks).
 */
const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const HEADER = '-- =========================\n-- Batch 37: customer websites, Phase 5 (transfer to the operator)\n-- =========================';
const start = sql.indexOf('-- Batch 37: customer websites, Phase 5');
const after = sql.indexOf('\n-- =========================\n-- Batch', start + 1);
const section = start === -1 ? '' : sql.slice(start, after === -1 ? undefined : after);

const COLUMNS = [
  'id', 'website_id', 'owner_id', 'ref', 'provider_key', 'provider_name', 'ips_tag', 'method', 'domain_id', 'domain_name', 'snapshot',
  'export_state', 'export_path', 'export_attempts', 'export_error', 'export_ready_at', 'export_emailed_at', 'domain_state',
  'tag_claimed_at', 'domain_requested_at', 'code_sent_at', 'domain_moved_at', 'stuck_alerted_at', 'moved_emailed_at',
  'overlap_ends_at', 'overlap_ended_at', 'cancelled_at', 'cancelled_by', 'created_at', 'updated_at',
];

test('the section has the exact header, comes after Batches 31, 33 and 36 (all kept) and ends by reloading the schema cache', () => {
  assert.ok(sql.includes(`\n${HEADER}\n`), 'the Batch 37 header is not exact');
  for (const earlier of ['-- Batch 31: customer websites', '-- Batch 33: customer website domains', '-- Batch 36: customer websites, Phase 4']) {
    assert.ok(start > sql.indexOf(earlier), `Batch 37 must come after ${earlier}`);
  }
  assert.match(section.trimEnd(), /notify pgrst, 'reload schema';$/);
  assert.equal(sql.trimEnd().endsWith("notify pgrst, 'reload schema';"), true);
});

test('every statement can run twice', () => {
  for (const m of section.matchAll(/create (unique )?(table|index)\b(?! if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/add column (?!if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/add constraint (\w+)/g)) assert.ok(section.includes(`drop constraint if exists ${m[1]};`), `${m[1]} is added without a guard`);
  const inserts = [...section.matchAll(/insert into public\.billing_settings[^;]*;/g)].map((m) => m[0]);
  assert.equal(inserts.length, 1);
  for (const s of inserts) assert.match(s, /on conflict \(key\) do nothing;$/);
  assert.match(section, /insert into storage\.buckets[^;]*on conflict \(id\) do nothing;/);
  for (const m of section.matchAll(/add constraint \w+ (primary key|unique)/gi)) assert.fail(`would rebuild an index on a second run: ${m[0]}`);
  const adds = [...section.matchAll(/add constraint (\w+)/g)].map((m) => m[1]);
  assert.equal(new Set(adds).size, adds.length, 'a constraint name is added twice');
});

test('one table, website_transfers, with the plan\'s columns, service role only: RLS on, no policy, revoked from anon and authenticated', () => {
  const tables = [...section.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, ['website_transfers']);
  const body = section.slice(section.indexOf('create table if not exists public.website_transfers'), section.indexOf('alter table public.website_transfers drop constraint'));
  const cols = [...body.matchAll(/^  (\w+) (?:uuid|text|integer|jsonb|timestamptz)\b/gm)].map((m) => m[1]);
  assert.deepEqual(cols, COLUMNS);
  assert.match(section, /alter table public\.website_transfers enable row level security;/);
  assert.match(section, /revoke all on public\.website_transfers from anon, authenticated;/);
  assert.doesNotMatch(section, /create policy/i);
  assert.doesNotMatch(section, /grant [^;]* to (anon|authenticated)\b/i);
  assert.doesNotMatch(section, /create (or replace )?function/i, 'the batch adds no function');
});

test("the plan's states, checks, keys and indexes are there", () => {
  assert.match(section, /website_id uuid not null references public\.websites\(id\) on delete restrict/);
  assert.match(section, /method in \('tag', 'code', 'none'\)/);
  assert.match(section, /export_state in \('pending', 'ready', 'failed'\)/);
  assert.match(section, /domain_state in \('none', 'pending', 'manual', 'requested', 'moved'\)/);
  assert.match(section, /char_length\(export_error\) <= 200/);
  assert.match(section, /export_attempts >= 0/);
  assert.match(section, /ips_tag ~ '\^\[A-Z0-9\]\[A-Z0-9-\]\{1,30\}\$'/);
  assert.match(section, /ref text not null default replace\(gen_random_uuid\(\)::text, '-', ''\)/);
  assert.match(section, /create unique index if not exists website_transfers_ref_idx on public\.website_transfers \(ref\);/);
  assert.match(section, /create unique index if not exists website_transfers_open_idx on public\.website_transfers \(website_id\) where cancelled_at is null and overlap_ended_at is null;/);
  assert.match(section, /create index if not exists website_transfers_owner_idx on public\.website_transfers \(owner_id\);/);
  // The private bucket.
  assert.match(section, /values \('website-transfers', 'website-transfers', false,/);
});

test('the three settings are seeded as the plan says, and nothing here is an access column', () => {
  assert.match(section, /\('website_transfer_overlap_days', '30'::jsonb\)/);
  assert.match(section, /\('website_transfer_stuck_days', '5'::jsonb\)/);
  assert.match(section, /\('website_transfer_code_from', '"2027-02-09"'::jsonb\)/);
  assert.match(section, /Nothing here is in\s+-- ACCESS_COLUMNS/);
  const access = ACCESS_COLUMNS.split(',').map((c) => c.trim());
  assert.ok(!access.some((c) => /transfer|overlap|export_|tag_claimed|domain_moved/.test(c)), 'no Batch 37 column in ACCESS_COLUMNS');
});

test('no new status, no old constraint or foreign key changed, no earlier table altered', () => {
  assert.equal(WEBSITE_STATUSES.length, 5);
  assert.doesNotMatch(section, /websites_status_check/);
  assert.doesNotMatch(section, /drop constraint[^;]*(fkey|_fk)\b/i);
  const dropped = [...section.matchAll(/drop constraint if exists (\w+);/g)].map((m) => m[1]);
  for (const c of dropped) assert.match(c, /^website_transfers_/, `${c} is not this table's own constraint`);
  assert.doesNotMatch(section, /alter table public\.(?!website_transfers\b)/);
});
