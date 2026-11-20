import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCESS_COLUMNS } from '../access.ts';

/**
 * The Batch 31 section of supabase/schema.sql, held to the rules every
 * section follows (idempotent, service role only, functions locked), so a
 * re-run of the file is safe. CI also runs the whole file twice and diffs
 * schema and data, and supabase/tests/websites-smoke.sql checks what the
 * functions do.
 */
const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const start = sql.indexOf('-- Batch 31: customer websites');
const after = sql.indexOf('\n-- =========================\n-- Batch', start + 1);
const section = start === -1 ? '' : sql.slice(start, after === -1 ? undefined : after);

const TABLES = ['websites', 'lead_sources', 'website_reports', 'website_report_slots', 'website_report_charges'];
const FUNCTIONS = ['website_uk_day', 'website_setting_int', 'website_free_report_claim', 'website_report_charge'];

test('the section ends by reloading the schema cache, and only Batch 32 (its own section) may follow it', () => {
  assert.ok(section.length > 0, 'no "Batch 31" section in schema.sql');
  // Batch 32 appends its own block after this one (it has its own checks in supabase/tests/leaddb-smoke.sql).
  if (after !== -1) assert.match(sql.slice(after, after + 120), /^\n-- =+\n-- Batch 32: /, 'only Batch 32 may follow the Batch 31 section');
  assert.match(section.trimEnd(), /notify pgrst, 'reload schema';$/);
});

test('every statement can run twice', () => {
  for (const m of section.matchAll(/create (unique )?(table|index)\b(?! if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/add column (?!if not exists)/gi)) assert.fail(`not idempotent: ${m[0]}`);
  for (const m of section.matchAll(/add constraint (\w+)/g)) assert.ok(section.includes(`drop constraint if exists ${m[1]};`), `${m[1]} is added without a guard`);
  for (const m of section.matchAll(/create (or replace )?function/gi)) assert.ok(m[1], `${m[0]} must be "create or replace"`);
  for (const m of section.matchAll(/create policy "([^"]+)"/g)) assert.ok(section.includes(`drop policy if exists "${m[1]}"`), `${m[1]} is created without a drop`);
  for (const m of section.matchAll(/create trigger (\w+)/g)) assert.ok(section.includes(`drop trigger if exists ${m[1]} `), `${m[1]} is created without a drop`);
  // Seeds never overwrite what an admin has set.
  const inserts = [...section.matchAll(/insert into public\.billing_settings[^;]*;/g)].map((m) => m[0]);
  assert.ok(inserts.length > 0);
  for (const s of inserts) assert.match(s, /on conflict \(key\) do nothing;$/);
  // A constraint is never rebuilt on a re-run in a way that rebuilds an index: only checks are dropped and re-added.
  for (const m of section.matchAll(/add constraint \w+ (primary key|unique)/gi)) assert.fail(`would rebuild an index on a second run: ${m[0]}`);
});

test('the tables are the five the plan names, each with row level security', () => {
  const tables = [...section.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, TABLES);
  for (const t of TABLES) assert.match(section, new RegExp(`alter table public\\.${t} enable row level security;`), t);
  for (const t of TABLES) assert.match(section, new RegExp(`revoke all on public\\.${t} from anon, authenticated;`), t);
});

test('only websites has a policy and a grant to members: select, on their own row', () => {
  assert.deepEqual([...section.matchAll(/create policy "([^"]+)"\s+on public\.(\w+) for (\w+)/g)].map((m) => `${m[2]}:${m[3]}`), ['websites:select']);
  assert.match(section, /using \(\(select auth\.uid\(\)\) = user_id\)/);
  assert.deepEqual([...section.matchAll(/grant ([^;]*?) on public\.(\w+) to (anon|authenticated)\b/gi)].map((m) => `${m[1].toLowerCase()} ${m[2]} ${m[3]}`), ['select websites authenticated']);
});

test('every function is locked to the service role', () => {
  const names = [...section.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(names, FUNCTIONS);
  for (const name of names) {
    assert.match(section, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`), name);
    assert.match(section, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`), name);
    assert.equal([...sql.matchAll(new RegExp(`create or replace function public\\.${name}\\(`, 'g'))].length, 1, `${name} is defined more than once`);
  }
});

test('the plan\'s columns and rules are there', () => {
  assert.match(section, /alter table public\.funnels add column if not exists kind text not null default 'form';/);
  assert.match(section, /check \(kind in \('form', 'website'\)\)/);
  assert.match(section, /user_id uuid not null unique references public\.profiles\(id\) on delete cascade/);
  assert.match(section, /funnel_id uuid not null unique references public\.funnels\(id\) on delete restrict/);
  assert.match(section, /slug text not null unique/);
  assert.match(section, /check \(slug ~ '\^\[a-z0-9-\]\{3,40\}\$'\)/);
  assert.match(section, /status in \('invited', 'setup', 'preview', 'live', 'paused'\)/);
  assert.match(section, /state in \('awaiting_address', 'held_cap', 'held_credit', 'held_self', 'running', 'done', 'failed', 'expired'\)/);
  assert.match(section, /billing_mode is null or billing_mode in \('free', 'charged'\)/);
  assert.match(section, /ad_code varchar\(40\)/);
  assert.match(section, /lead_id uuid primary key references public\.leads\(id\) on delete cascade/);
  // The slot and charge records outlive a purged lead: no foreign key to leads.
  const slots = section.slice(section.indexOf('create table if not exists public.website_report_slots'), section.indexOf('alter table public.website_report_slots enable'));
  const charges = section.slice(section.indexOf('create table if not exists public.website_report_charges'), section.indexOf('alter table public.website_report_charges drop'));
  assert.doesNotMatch(slots, /references public\.leads/);
  assert.doesNotMatch(charges, /references public\.leads/);
  assert.match(charges, /status text not null default 'unpaid'/);
  assert.match(section, /status in \('charged', 'unpaid'\)/);
});

test('the day is the UK day, computed in SQL', () => {
  assert.match(section, /select \(now\(\) at time zone 'Europe\/London'\)::date;/);
  assert.match(section, /v_day date := public\.website_uk_day\(\);/);
  assert.match(section, /pg_advisory_xact_lock/);
});

test('the charge goes through credit_debit_face, never the run\'s action id, and records unpaid instead of raising', () => {
  const fn = section.slice(section.indexOf('create or replace function public.website_report_charge'));
  assert.match(fn, /public\.credit_debit_face\(/);
  assert.match(fn, /exception when sqlstate 'P0402'/);
  assert.match(fn, /'already_charged'/);
  assert.doesNotMatch(fn, /action_id/);
});

test('the five settings are seeded, nothing touches profiles, and ACCESS_COLUMNS has nothing website', () => {
  for (const key of ['website_report_charge_on', 'website_report_pence', 'website_plan_gate_on', 'website_free_reports_per_day', 'website_free_reports_per_site_per_day']) {
    assert.match(section, new RegExp(`\\('${key}', '[^']*'\\)`), key);
  }
  assert.doesNotMatch(section, /alter table public\.profiles/);
  const access = ACCESS_COLUMNS.split(',').map((c) => c.trim());
  assert.ok(!access.some((c) => /website/.test(c)), 'no website column in ACCESS_COLUMNS');
});
