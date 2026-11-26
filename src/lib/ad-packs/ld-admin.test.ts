import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LD_NOT_ALLOWED, leadDbAdminRunner, type LeadDbAdminDeps } from './ld-admin-run.ts';
import { accountLabel, adAccountAdminRow } from '../leaddb/ad-account-admin.ts';
import type { LeadDbAdAccount } from '../leaddb/ad-account.ts';

/**
 * Batch 55 (Part A), phase A8: the admin's "Allowed" switch and "Grant an extra round" on /admin/ad-packs. Admin only (the
 * verified session user decides), a reason is required and checked on the server, and the one audit line each writes carries
 * ids only: never the reason, an email or a name.
 */

const ADMIN_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
const OWNER = '3f9a2c11-1111-4111-8111-111111111111';
const ADMIN_EMAIL = 'zac.admin@example.test';
const REASON = 'SENTINEL-REASON their first set had the wrong logo';

type Calls = { setAllowed: [string, boolean, string][]; grantRound: [string, string, string][]; audit: string[]; reads: number };

function build(opts: { user?: { id?: string | null; email?: string | null } | null; admin?: boolean; accountExists?: boolean; throws?: boolean } = {}) {
  const calls: Calls = { setAllowed: [], grantRound: [], audit: [], reads: 0 };
  const user = opts.user === undefined ? { id: ADMIN_ID, email: ADMIN_EMAIL } : opts.user;
  const deps: LeadDbAdminDeps = {
    currentUser: async () => {
      calls.reads++;
      return user;
    },
    isAdmin: (email) => opts.admin !== false && email === ADMIN_EMAIL,
    setAllowed: async (o, a, by) => {
      if (opts.throws) throw new Error('boom: a body that must never be shown');
      calls.setAllowed.push([o, a, by]);
      return opts.accountExists !== false;
    },
    grantRound: async (o, by, why) => {
      if (opts.throws) throw new Error('boom: a body that must never be shown');
      calls.grantRound.push([o, by, why]);
      return opts.accountExists === false ? 'no_account' : 'granted';
    },
    audit: (line) => calls.audit.push(line),
  };
  return { calls, runner: leadDbAdminRunner(deps) };
}

test('a non-admin and a signed-out visitor are refused by both actions, and nothing is written or audited', async () => {
  for (const user of [null, { id: ADMIN_ID, email: 'someone.else@example.test' }, { id: ADMIN_ID, email: null }]) {
    const { calls, runner } = build({ user });
    assert.deepEqual(await runner.setAllowed(OWNER, true), { ok: false, message: LD_NOT_ALLOWED });
    assert.deepEqual(await runner.grantRound(OWNER, REASON), { ok: false, message: LD_NOT_ALLOWED });
    assert.deepEqual(calls.setAllowed, []);
    assert.deepEqual(calls.grantRound, []);
    assert.deepEqual(calls.audit, []);
  }
});

test('an admin session with no usable user id is refused too (the audit and the stamp both need the id)', async () => {
  const { calls, runner } = build({ user: { id: null, email: ADMIN_EMAIL } });
  assert.equal((await runner.setAllowed(OWNER, true)).ok, false);
  assert.equal((await runner.grantRound(OWNER, REASON)).ok, false);
  assert.equal(calls.setAllowed.length + calls.grantRound.length, 0);
});

test('Allowed: the admin’s own id (not an argument) is what is stamped; on and off both work; one audit line each, ids only', async () => {
  const { calls, runner } = build();
  const on = await runner.setAllowed(OWNER, true);
  assert.equal(on.ok, true);
  const off = await runner.setAllowed(OWNER, false);
  assert.equal(off.ok, true);
  assert.deepEqual(calls.setAllowed, [[OWNER, true, ADMIN_ID], [OWNER, false, ADMIN_ID]]);
  assert.equal(calls.audit.length, 2);
  for (const line of calls.audit) {
    assert.ok(line.includes(ADMIN_ID) && line.includes(OWNER));
    assert.ok(!line.includes(ADMIN_EMAIL) && !line.includes('@'), line);
  }
});

test('Allowed: a bad owner id or a value that is not on/off is refused before anything is written; an owner with no account says so', async () => {
  const { calls, runner } = build();
  for (const bad of [undefined, null, '', 'abc', 5, { id: OWNER }, `${OWNER}; drop table`]) assert.equal((await runner.setAllowed(bad, true)).ok, false);
  for (const bad of [undefined, null, 'true', 1, 0]) assert.equal((await runner.setAllowed(OWNER, bad)).ok, false);
  assert.deepEqual(calls.setAllowed, []);
  const none = build({ accountExists: false });
  const r = await none.runner.setAllowed(OWNER, true);
  assert.equal(r.ok, false);
  assert.match(r.message, /no lead database ad account/);
  assert.deepEqual(none.calls.audit, [], 'nothing changed, so nothing is audited');
});

test('Grant an extra round: a reason is REQUIRED on the server: missing, blank, whitespace, not text and over-long are all refused and nothing is written', async () => {
  const { calls, runner } = build();
  for (const bad of [undefined, null, '', '   ', '\n\t ', 7, {}, 'x'.repeat(501)]) {
    const r = await runner.grantRound(OWNER, bad);
    assert.equal(r.ok, false, String(bad));
    assert.match(r.message, /reason is needed/);
  }
  assert.deepEqual(calls.grantRound, []);
  assert.deepEqual(calls.audit, []);
});

test('Grant an extra round: with a reason it is recorded under the admin’s id with the reason trimmed, and the one audit line has ids only: never the reason, an email or a name', async () => {
  const { calls, runner } = build();
  const r = await runner.grantRound(OWNER, `  ${REASON}  `);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.grantRound, [[OWNER, ADMIN_ID, REASON]]);
  assert.equal(calls.audit.length, 1);
  assert.ok(calls.audit[0].includes(ADMIN_ID) && calls.audit[0].includes(OWNER));
  assert.ok(!calls.audit[0].includes('SENTINEL') && !calls.audit[0].includes(ADMIN_EMAIL) && !calls.audit[0].includes('logo'), calls.audit[0]);
  assert.ok(!r.message.includes('SENTINEL'), 'the reason is never echoed back');
});

test('Grant an extra round: a bad owner id is refused; an owner with no ad account says so and nothing is audited', async () => {
  const { calls, runner } = build();
  assert.equal((await runner.grantRound('not-an-id', REASON)).ok, false);
  assert.deepEqual(calls.grantRound, []);
  const none = build({ accountExists: false });
  const r = await none.runner.grantRound(OWNER, REASON);
  assert.equal(r.ok, false);
  assert.match(r.message, /no lead database ad account/);
  assert.deepEqual(none.calls.audit, []);
});

test('a failing write is one plain sentence, never an error body, and is not audited as a success', async () => {
  const { calls, runner } = build({ throws: true });
  for (const r of [await runner.setAllowed(OWNER, true), await runner.grantRound(OWNER, REASON)]) {
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.message, /boom|body/);
  }
  assert.deepEqual(calls.audit, []);
});

test('the admin check comes before anything else in each method (a non-admin’s arguments are never even read)', () => {
  const run = readFileSync(new URL('./ld-admin-run.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const fn of ['setAllowed', 'grantRound']) {
    const body = run.slice(run.indexOf(`async function ${fn}(`));
    const firstAwait = body.indexOf('await ');
    assert.match(body.slice(firstAwait, firstAwait + 40), /gate\(\)/, `${fn} checks the admin before anything else`);
  }
});

// ── Source pins ──

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the actions are thin hand-overs: use server, only async functions, one runner call each, no argument can name the admin', () => {
  const src = strip(read('../../app/admin/ad-packs/leaddb-actions.ts'));
  assert.match(src, /^\s*'use server';/);
  const exported = [...src.matchAll(/export async function (\w+)\(([^)]*)\)/g)];
  assert.deepEqual(exported.map((m) => m[1]), ['setAdAccountAllowedAction', 'grantExtraRoundAction']);
  for (const m of exported) assert.doesNotMatch(m[2], /email|admin|user/i, `${m[1]} takes no identity`);
  assert.equal((src.match(/liveLeadDbAdminRunner\(\)\./g) ?? []).length, 2);
  assert.match(src, /liveLeadDbAdminRunner\(\)\.setAllowed\(/);
  assert.match(src, /liveLeadDbAdminRunner\(\)\.grantRound\(/);
  assert.doesNotMatch(src, /createAdminClient|\.from\(|setAdAccountAllowed\(|insertRoundGrant|console\./, 'the actions never reach past the runner');
  assert.equal([...src.matchAll(/^export (?!async function)/gm)].length, 0, "a 'use server' module exports only async functions");
});

test('the live runner takes the user from the verified session, writes through the two server functions, and audits to [admin] with the runner’s ids-only line', () => {
  const server = strip(read('./ld-admin-server.ts'));
  assert.match(server, /supabase\.auth\.getUser\(\)/);
  assert.match(server, /setAdAccountAllowed\(ownerId, allowed, adminId\)/);
  assert.match(server, /insertRoundGrant\(ownerId, adminId, reason\)/);
  assert.match(server, /console\.info\(`\[admin\] ad-packs: \$\{line\}`\)/);
  assert.doesNotMatch(server, /email/);
  // The only audit calls in the runner are built from ids.
  const run = strip(read('./ld-admin-run.ts'));
  const lines = [...run.matchAll(/audit\(`([^`]*)`\)/g)].map((m) => m[1]);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.doesNotMatch(l, /reason|why|email|name/i, l);
});

test('the screen asks for a reason before the button works, and the page reads accounts only after the guard', () => {
  const ui = strip(read('../../app/admin/ad-packs/LeadDbAccounts.tsx'));
  assert.match(ui, /disabled=\{pending \|\| reason\.trim\(\) === ""\}/);
  assert.match(ui, /Grant an extra round/);
  const page = strip(read('../../app/admin/ad-packs/page.tsx'));
  assert.ok(page.indexOf('pageGuard(user)') < page.indexOf('listAdAccounts()'), 'nothing is read before the guard');
});

test('the account list reads flags and states only: no email, name or profile, and the accounts table is read-only here', () => {
  const server = strip(read('../leaddb/ad-account-server.ts'));
  const list = server.slice(server.indexOf('export async function listAdAccounts'));
  assert.doesNotMatch(list, /profiles|email|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  assert.match(list, /ad_pack_round_grants'\)\.select\('owner_id'\)\.is\('used_at', null\)/);
});

// ── What the screen shows ──

const account = (over: Partial<LeadDbAdAccount> = {}): LeadDbAdAccount => ({
  ownerId: OWNER,
  ldCustomerId: 'ld_1',
  linkId: null,
  allowed: true,
  cardOnFile: true,
  accountStatus: 'active',
  cancelEffectiveAt: null,
  lapsed: false,
  stateAsOf: new Date('2026-12-01T00:00:00Z'),
  ...over,
});
const NOW = new Date('2026-12-10T00:00:00Z');

test('the account row carries only flags, dates and plain labels', () => {
  const row = adAccountAdminRow(account(), '2026-11-30T09:00:00.000Z', 2, NOW);
  assert.deepEqual(row, {
    ownerId: OWNER,
    allowed: true,
    allowedAt: '2026-11-30T09:00:00.000Z',
    cardOnFile: true,
    accountLabel: 'Active',
    cancelEffectiveAt: null,
    lapsed: false,
    stateAsOf: '2026-12-01T00:00:00.000Z',
    routeOpen: true,
    routeReason: null,
    unusedRounds: 2,
  });
  assert.doesNotMatch(JSON.stringify(row), /ld_1|@/, 'the lead database customer id is not shown');
});

test('the route reasons are plain, in the lead database’s order, and an unknown account state reads Other (never its raw text)', () => {
  assert.equal(adAccountAdminRow(account({ allowed: false }), null, 0, NOW).routeReason, 'Not allowed yet');
  assert.equal(adAccountAdminRow(account({ cardOnFile: false }), null, 0, NOW).routeReason, 'No card on file');
  assert.equal(adAccountAdminRow(account({ lapsed: true }), null, 0, NOW).routeReason, 'Account stopped');
  assert.equal(adAccountAdminRow(account({ stateAsOf: null }), null, 0, NOW).routeReason, 'Account stopped');
  assert.equal(adAccountAdminRow(account({ accountStatus: 'paused' }), null, 0, NOW).routeOpen, true, 'pause is never read');
  const cancelled = adAccountAdminRow(account({ accountStatus: 'pending_cancel', cancelEffectiveAt: new Date('2026-12-05T00:00:00Z') }), null, 0, NOW);
  assert.equal(cancelled.routeOpen, false);
  assert.equal(cancelled.accountLabel, 'Cancelling');
  assert.equal(cancelled.cancelEffectiveAt, '2026-12-05T00:00:00.000Z');
  assert.equal(accountLabel('SOMETHING_NEW_FROM_THEM', true), 'Other');
  assert.equal(accountLabel(null, true), 'Not sent yet');
  assert.equal(accountLabel('active', false), 'Not sent yet');
  assert.equal(adAccountAdminRow(account(), null, -3, NOW).unusedRounds, 0);
});
