import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCESS_COLUMNS } from '../access.ts';

/**
 * The Batch 33 section of supabase/schema.sql, held to the rules every
 * section follows (idempotent, service role only, functions locked), so a
 * re-run of the file is safe. CI also runs the whole file twice and diffs
 * schema and data, and supabase/tests/domains-smoke.sql checks what the
 * functions do (the cap, the keys, void, one domain per site, the charge).
 */
const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const start = sql.indexOf('-- Batch 33: customer website domains');
const after = sql.indexOf('\n-- =========================\n-- Batch', start + 1);
const section = start === -1 ? '' : sql.slice(start, after === -1 ? undefined : after);

const TABLES = ['website_domain_offers', 'website_domains', 'website_domain_spend', 'website_domain_charges'];
const FUNCTIONS = ['website_domain_spend_claim', 'website_domain_spend_settle', 'website_domain_charge'];

test('the section is after Batch 31 (both blocks kept, in merge order) and ends by reloading the schema cache', () => {
  assert.ok(section.length > 0, 'no "Batch 33" section in schema.sql');
  assert.ok(start > sql.indexOf('-- Batch 31: customer websites'), 'Batch 33 must come after the Batch 31 section');
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
});

test('the tables are the four the plan names, each with row level security and no member write', () => {
  const tables = [...section.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, TABLES);
  for (const t of TABLES) assert.match(section, new RegExp(`alter table public\\.${t} enable row level security;`), t);
  for (const t of TABLES) assert.match(section, new RegExp(`revoke all on public\\.${t} from anon, authenticated;`), t);
});

test('members read only their own offer and their own domain (listed columns), never the spend or the charges', () => {
  assert.deepEqual([...section.matchAll(/create policy "([^"]+)"\s+on public\.(\w+) for (\w+)/g)].map((m) => `${m[2]}:${m[3]}`), ['website_domain_offers:select', 'website_domains:select']);
  const grants = [...section.matchAll(/grant ([^;]*?) on public\.(\w+) to (anon|authenticated)\b/gi)].map((m) => `${m[2]} ${m[3]}`);
  assert.deepEqual(grants, ['website_domain_offers authenticated', 'website_domains authenticated']);
  const domainGrant = section.match(/grant select \(([^)]*)\) on public\.website_domains to authenticated;/);
  assert.ok(domainGrant, 'website_domains gets a column list, not the whole row');
  for (const secret of ['last_error', 'registrar_ref', 'cost_pence', 'attempts', 'owner_id', 'renew_decision']) {
    assert.ok(!domainGrant[1].split(',').map((c) => c.trim()).includes(secret), `a member must not read ${secret}`);
  }
  assert.match(section, /using \(owner_id = \(select auth\.uid\(\)\)\)/);
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
  assert.match(section, /website_id uuid not null references public\.websites\(id\) on delete restrict/);
  assert.match(section, /status in \('awaiting_admin', 'held_cap', 'registering', 'connecting', 'live', 'needs_choice', 'failed', 'releasing', 'released'\)/);
  assert.match(section, /renew_decision is null or renew_decision in \('renew', 'dont_renew'\)/);
  assert.match(section, /char_length\(last_error\) <= 200/);
  assert.match(section, /renew_allowed boolean not null default true/);
  for (const col of ['dns_set_at', 'vercel_added_at', 'https_ok_at', 'live_at', 'stuck_alerted_at', 'renewal_alerted_for', 'state_changed_at', 'expires_at', 'bought_at']) {
    assert.match(section, new RegExp(`\\b${col}\\b`), col);
  }
  // One active domain per site and per name; a released one frees both. One site per domain.
  assert.match(section, /create unique index if not exists website_domains_site_active_idx on public\.website_domains \(website_id\) where status <> 'released';/);
  assert.match(section, /create unique index if not exists website_domains_name_active_idx on public\.website_domains \(name\) where status <> 'released';/);
  assert.match(section, /create unique index if not exists websites_domain_unique_idx on public\.websites \(lower\(domain\)\) where domain is not null;/);
  // The name is a plain .co.uk label, never punycode.
  assert.match(section, /\^\[a-z0-9\]\(\[a-z0-9-\]\{0,61\}\[a-z0-9\]\)\?\\\.co\\\.uk\$/);
  assert.match(section, /xn--/);
  // Offers: at most six names.
  assert.match(section, /coalesce\(array_length\(names, 1\), 0\) <= 6/);
  // Spend: one key, claimed|bought|void, register|renew.
  assert.match(section, /kind in \('register', 'renew'\)/);
  assert.match(section, /status in \('claimed', 'bought', 'void'\)/);
  assert.match(section, /create unique index if not exists website_domain_spend_key_idx on public\.website_domain_spend \(key\);/);
  // Charges: domain + period is the guard, with no foreign key to the domain (what was charged stays).
  const charges = section.slice(section.indexOf('create table if not exists public.website_domain_charges'), section.indexOf('alter table public.website_domain_charges drop'));
  assert.match(charges, /primary key \(domain_id, period\)/);
  assert.doesNotMatch(charges, /references public\.website_domains/);
  assert.match(charges, /status text not null default 'unpaid'/);
  assert.match(section, /status in \('charged', 'unpaid'\)/);
});

test('the cap claim: UK day and cap read in SQL, one advisory lock per day, claimed plus bought counted, a bad cap never raises', () => {
  const fn = section.slice(section.indexOf('create or replace function public.website_domain_spend_claim'), section.indexOf('revoke all on function public.website_domain_spend_claim'));
  assert.match(fn, /v_day date := public\.website_uk_day\(\);/);
  assert.match(fn, /public\.website_setting_int\('domain_daily_spend_cap_pence', 5000\)/);
  assert.match(fn, /pg_advisory_xact_lock\(hashtextextended\('website_domain_spend_claim:' \|\| v_day::text, 0\)\)/);
  assert.match(fn, /status in \('claimed', 'bought'\)/);
  assert.match(fn, /'over_cap'/);
  assert.match(fn, /'already'/);
  // FOUND is overwritten by the aggregate select: the answer is kept in a variable (it was a real bug).
  assert.match(fn, /v_exists := found;/);
  assert.doesNotMatch(fn, /if found then/);
});

test('the charge goes through credit_debit_face, never an action id, and records unpaid instead of raising', () => {
  const fn = section.slice(section.indexOf('create or replace function public.website_domain_charge'));
  assert.match(fn, /public\.credit_debit_face\(/);
  assert.match(fn, /exception when sqlstate 'P0402'/);
  assert.match(fn, /'already_charged'/);
  assert.doesNotMatch(fn, /action_id/);
});

test('the three settings are seeded (charge OFF), nothing touches profiles, and ACCESS_COLUMNS has nothing domain', () => {
  assert.match(section, /\('domain_charge_on', 'false'\)/);
  assert.match(section, /\('domain_daily_spend_cap_pence', '5000'\)/);
  assert.match(section, /\('domain_auto_buy', 'true'\)/);
  assert.doesNotMatch(section, /alter table public\.profiles/);
  const access = ACCESS_COLUMNS.split(',').map((c) => c.trim());
  assert.ok(!access.some((c) => /domain/.test(c)), 'no domain column in ACCESS_COLUMNS');
});

test('re-run guards: the same unique and check constraint names are not added twice, and no function is created without or-replace', () => {
  const adds = [...section.matchAll(/add constraint (\w+)/g)].map((m) => m[1]);
  assert.equal(new Set(adds).size, adds.length, 'a constraint name is added twice');
  const idx = [...section.matchAll(/create unique index if not exists (\w+)/g)].map((m) => m[1]);
  assert.equal(new Set(idx).size, idx.length);
});
