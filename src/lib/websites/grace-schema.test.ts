import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCESS_COLUMNS } from '../access.ts';
import { WEBSITE_STATUSES } from './types.ts';

/**
 * The Batch 36 section of supabase/schema.sql, held to the rules every
 * section follows (idempotent, service role only, functions locked), so a
 * re-run of the file is safe. CI also runs the whole file twice and diffs
 * schema and data, and supabase/tests/websites-p4-smoke.sql checks what the
 * functions do (stale base, the 10-version cap, one snapshot, one notice).
 */
const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const start = sql.indexOf('-- Batch 36: customer websites, Phase 4');
const after = sql.indexOf('\n-- =========================\n-- Batch', start + 1);
const section = start === -1 ? '' : sql.slice(start, after === -1 ? undefined : after);

const TABLES = ['website_drafts', 'website_versions', 'website_change_requests', 'website_grace', 'website_grace_notices'];
const FUNCTIONS = ['website_version_snapshot', 'website_version_publish'];

test('the section is after Batches 31, 32 and 33 (all kept, in merge order) and ends by reloading the schema cache', () => {
  assert.ok(section.length > 0, 'no "Batch 36" section in schema.sql');
  for (const earlier of ['-- Batch 31: customer websites', '-- Batch 32: website leads', '-- Batch 33: customer website domains']) {
    assert.ok(start > sql.indexOf(earlier), `Batch 36 must come after ${earlier}`);
  }
  assert.match(section.trimEnd(), /notify pgrst, 'reload schema';$/);
});

test('every statement can run twice', () => {
  for (const m of section.matchAll(/create (unique )?(table|index)\b(?! if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/add column (?!if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/add constraint (\w+)/g)) assert.ok(section.includes(`drop constraint if exists ${m[1]};`), `${m[1]} is added without a guard`);
  for (const m of section.matchAll(/create (or replace )?function/gi)) assert.ok(m[1], `${m[0]} must be "create or replace"`);
  for (const m of section.matchAll(/create policy "([^"]+)"/g)) assert.ok(section.includes(`drop policy if exists "${m[1]}"`), `${m[1]} is created without a drop`);
  for (const m of section.matchAll(/create trigger (\w+)/g)) assert.ok(section.includes(`drop trigger if exists ${m[1]} `), `${m[1]} is created without a drop`);
  const inserts = [...section.matchAll(/insert into public\.billing_settings[^;]*;/g)].map((m) => m[0]);
  assert.ok(inserts.length > 0);
  for (const s of inserts) assert.match(s, /on conflict \(key\) do nothing;$/);
  for (const m of section.matchAll(/add constraint \w+ (primary key|unique)/gi)) assert.fail(`would rebuild an index on a second run: ${m[0]}`);
  const adds = [...section.matchAll(/add constraint (\w+)/g)].map((m) => m[1]);
  assert.equal(new Set(adds).size, adds.length, 'a constraint name is added twice');
});

test('the tables are the five the plan names, each service role only: no policy, no member grant', () => {
  const tables = [...section.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, TABLES);
  for (const t of TABLES) {
    assert.match(section, new RegExp(`alter table public\\.${t} enable row level security;`), t);
    assert.match(section, new RegExp(`revoke all on public\\.${t} from anon, authenticated;`), t);
  }
  assert.doesNotMatch(section, /create policy/i);
  assert.doesNotMatch(section, /grant [^;]* to (anon|authenticated)\b/i);
});

test('every function is locked to the service role, defined once in the file', () => {
  const names = [...section.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(names, FUNCTIONS);
  for (const name of names) {
    assert.match(section, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`), name);
    assert.match(section, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`), name);
    assert.equal([...sql.matchAll(new RegExp(`create or replace function public\\.${name}\\(`, 'g'))].length, 1, `${name} is defined more than once`);
  }
});

test("the plan's columns, states and rules are there", () => {
  // The monthly allowance, on websites.
  assert.match(section, /alter table public\.websites add column if not exists edit_rewrites_month text;/);
  assert.match(section, /alter table public\.websites add column if not exists edit_rewrites_used integer not null default 0;/);
  assert.match(section, /check \(edit_rewrites_used >= 0\)/);
  // Draft: one per site, cascades, pending pages.
  assert.match(section, /website_id uuid primary key references public\.websites\(id\) on delete cascade/);
  assert.match(section, /pending_pages text\[\] not null default '\{\}'/);
  assert.match(section, /base_version integer/);
  // Versions: kind, one number per site.
  assert.match(section, /kind in \('approved', 'publish', 'restore'\)/);
  assert.match(section, /create unique index if not exists website_versions_site_no_idx on public\.website_versions \(website_id, version_no\);/);
  // Change requests: 1 to 2000 characters, four statuses, notes up to 2000.
  assert.match(section, /char_length\(body\) between 1 and 2000/);
  assert.match(section, /status in \('new', 'in_progress', 'done', 'declined'\)/);
  assert.match(section, /char_length\(admin_notes\) <= 2000/);
  for (const col of ['screenshot_path', 'closed_at', 'closed_emailed_at']) assert.match(section, new RegExp(`\\b${col}\\b`), col);
  // Grace: three reasons, cron or admin, every date the plan names.
  assert.match(section, /reason in \('abandoned', 'cancelled', 'unpaid'\)/);
  assert.match(section, /switch_off_by is null or switch_off_by in \('cron', 'admin'\)/);
  for (const col of ['episode_started_at', 'switch_off_on', 'cancelled_at', 'switched_off_at', 'off_emailed_at', 'delete_on', 'deleted_at']) assert.match(section, new RegExp(`\\b${col}\\b`), col);
  // Notices: the key is the whole guard.
  assert.match(section, /primary key \(website_id, episode_started_at, stage\)/);
  assert.match(section, /status in \('sent', 'skipped'\)/);
});

test('no new status, no foreign key changed: a websites row with a domain row is still never deleted', () => {
  assert.equal(WEBSITE_STATUSES.length, 5);
  assert.doesNotMatch(section, /websites_status_check/);
  assert.doesNotMatch(section, /switched_off'/);
  assert.doesNotMatch(section, /drop constraint[^;]*(fkey|_fk)\b/i);
  assert.doesNotMatch(section, /on delete restrict/i, 'Batch 36 adds no restrict (and removes none)');
  assert.doesNotMatch(section, /alter table public\.(profiles|funnels|leads|website_domains|website_reports)\b/);
});

test('the publish function: base-version check under the row lock, then insert, copy, delete the draft, keep 10', () => {
  const fn = section.slice(section.indexOf('create or replace function public.website_version_publish'), section.indexOf('revoke all on function public.website_version_publish'));
  assert.match(fn, /from public\.websites where id = p_website for update/);
  assert.match(fn, /p_base_version is distinct from v_max/);
  assert.match(fn, /'stale'/);
  assert.match(fn, /'published'/);
  assert.match(fn, /update public\.websites set settings = p_settings, pages = p_pages/);
  assert.match(fn, /delete from public\.website_drafts where website_id = p_website/);
  assert.match(fn, /order by version_no desc offset 10/);
  assert.match(fn, /p_kind not in \('publish', 'restore'\)/);
});

test('the snapshot function: version 1 once, approved, under the row lock', () => {
  const fn = section.slice(section.indexOf('create or replace function public.website_version_snapshot'), section.indexOf('revoke all on function public.website_version_snapshot'));
  assert.match(fn, /for update/);
  assert.match(fn, /if v_max is not null then return v_max; end if;/);
  assert.match(fn, /'approved'/);
});

test('the three settings are seeded as the plan says, and nothing here is an access column', () => {
  assert.match(section, /\('website_abandon_days', '90'\)/);
  assert.match(section, /\('website_warning_days', '"30,14,3"'\)/);
  assert.match(section, /\('website_delete_after_days', '90'\)/);
  const access = ACCESS_COLUMNS.split(',').map((c) => c.trim());
  assert.ok(!access.some((c) => /grace|draft|version|edit_rewrites|change_request/.test(c)), 'no Batch 36 column in ACCESS_COLUMNS');
});
