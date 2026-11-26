import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdAccountState, LeadDbAdAccount } from './ad-account.ts';
import { parseProvisionBody, runProvision, type EnsureSiteResult, type ProvisionDeps } from './provision-run.ts';

/** Batch 55 Part A, phase A3: the provision decision, with fake dependencies. */

const STATE: AdAccountState = { accountStatus: 'active', cardOnFile: true, cancelEffectiveAt: null, lapsed: false, stateAsOf: '2026-11-26T10:00:00Z' };
const BODY = { ld_customer_id: 'cust_1', email: 'Op@Example.com', company: 'Op Homes', phone: '07123 456789', state: STATE };

const account = (over: Partial<LeadDbAdAccount> = {}): LeadDbAdAccount => ({
  ownerId: 'owner-1', ldCustomerId: 'cust_1', linkId: null, allowed: false, cardOnFile: true, accountStatus: 'active',
  cancelEffectiveAt: null, lapsed: false, stateAsOf: new Date('2026-11-26T09:00:00Z'), ...over,
});

interface World {
  byCustomer: Map<string, LeadDbAdAccount>;
  byOwner: Map<string, LeadDbAdAccount>;
  profiles: Map<string, string>; // email -> id
  team: Set<string>;
  siteOwners: Set<string>;
  ensure: EnsureSiteResult;
  createMemberFails: boolean;
  calls: string[];
  created: Array<{ ownerId: string; ldCustomerId: string; state: AdAccountState }>;
  applied: Array<{ ownerId: string; state: AdAccountState }>;
  ensured: Array<{ ownerId: string; company: string; email: string; phone: string | null }>;
}

function world(over: Partial<World> = {}): { w: World; deps: ProvisionDeps } {
  const w: World = {
    byCustomer: new Map(), byOwner: new Map(), profiles: new Map(), team: new Set(), siteOwners: new Set(),
    ensure: { ok: true, slug: 'op-homes', created: true }, createMemberFails: false,
    calls: [], created: [], applied: [], ensured: [], ...over,
  };
  const deps: ProvisionDeps = {
    readAccountByCustomerId: async (id) => w.byCustomer.get(id) ?? null,
    readAccountByOwner: async (id) => w.byOwner.get(id) ?? null,
    applyState: async (ownerId, state) => { w.calls.push('apply'); w.applied.push({ ownerId, state }); return 'applied'; },
    createAccount: async (input) => {
      w.calls.push('create');
      w.created.push(input);
      const row = account({ ownerId: input.ownerId, ldCustomerId: input.ldCustomerId });
      w.byCustomer.set(input.ldCustomerId, row);
      w.byOwner.set(input.ownerId, row);
      return 'created';
    },
    findOwnerByEmail: async (email) => w.profiles.get(email) ?? null,
    isTeamMember: async (id) => w.team.has(id),
    hasSiteWebsite: async (id) => w.siteOwners.has(id),
    createMember: async (email) => {
      w.calls.push('createMember');
      if (w.createMemberFails) return null;
      w.profiles.set(email, 'new-owner');
      return 'new-owner';
    },
    ensureSite: async (input) => { w.calls.push('ensure'); w.ensured.push(input); return w.ensure; },
  };
  return { w, deps };
}

const parsed = () => {
  const p = parseProvisionBody(BODY);
  assert.ok(p);
  return p;
};

test('a new customer: member created, account stored (allowed false), site made', async () => {
  const { w, deps } = world();
  const out = await runProvision(deps, parsed());
  assert.deepEqual(out, { status: 200, body: { ok: true, code: 'created' } });
  assert.deepEqual(w.calls, ['createMember', 'create', 'ensure']);
  assert.equal(w.created[0].ownerId, 'new-owner');
  assert.deepEqual(w.ensured[0], { ownerId: 'new-owner', company: 'Op Homes', email: 'op@example.com', phone: '07123 456789' });
});

test('an existing owner with the same email is linked, not recreated', async () => {
  const { w, deps } = world({ profiles: new Map([['op@example.com', 'owner-9']]) });
  const out = await runProvision(deps, parsed());
  assert.equal(out.body.ok && out.body.code, 'created');
  assert.ok(!w.calls.includes('createMember'));
  assert.equal(w.created[0].ownerId, 'owner-9');
});

test('a repeat for the same ld_customer_id is 200 exists, applies the state, finishes the site, creates nothing', async () => {
  const { w, deps } = world();
  w.byCustomer.set('cust_1', account());
  const out = await runProvision(deps, parsed());
  assert.deepEqual(out, { status: 200, body: { ok: true, code: 'exists' } });
  assert.deepEqual(w.calls, ['apply', 'ensure']);
  assert.equal(w.applied[0].ownerId, 'owner-1');
  assert.deepEqual(w.applied[0].state, STATE);
});

test('a repeat whose site could not be made is a 500 so the lead database retries', async () => {
  const { w, deps } = world({ ensure: { ok: false, reason: 'failed' } });
  w.byCustomer.set('cust_1', account());
  const out = await runProvision(deps, parsed());
  assert.deepEqual(out, { status: 500, body: { ok: false, code: 'server_error' } });
});

test('an existing owner who has a website of their own is refused: 409 has_website, nothing created', async () => {
  const { w, deps } = world({ profiles: new Map([['op@example.com', 'owner-9']]), siteOwners: new Set(['owner-9']) });
  const out = await runProvision(deps, parsed());
  assert.deepEqual(out, { status: 409, body: { ok: false, code: 'has_website' } });
  assert.deepEqual(w.calls, []);
});

test('a team member is never linked: 409 conflict', async () => {
  const { w, deps } = world({ profiles: new Map([['op@example.com', 'member-1']]), team: new Set(['member-1']) });
  const out = await runProvision(deps, parsed());
  assert.deepEqual(out, { status: 409, body: { ok: false, code: 'conflict' } });
  assert.deepEqual(w.calls, []);
});

test('an owner with a DIFFERENT lead database account is a 409 conflict', async () => {
  const { w, deps } = world({ profiles: new Map([['op@example.com', 'owner-9']]) });
  w.byOwner.set('owner-9', account({ ownerId: 'owner-9', ldCustomerId: 'cust_other' }));
  const out = await runProvision(deps, parsed());
  assert.deepEqual(out, { status: 409, body: { ok: false, code: 'conflict' } });
  assert.deepEqual(w.calls, []);
});

test('createAccount saying conflict (the customer id is another owner\'s) is a 409 and makes no site', async () => {
  const { w, deps } = world({ profiles: new Map([['op@example.com', 'owner-9']]) });
  deps.createAccount = async () => 'conflict';
  const out = await runProvision(deps, parsed());
  assert.deepEqual(out, { status: 409, body: { ok: false, code: 'conflict' } });
  assert.ok(!w.calls.includes('ensure'));
});

test('losing a race to another identical call answers exists and applies the state', async () => {
  const { w, deps } = world({ profiles: new Map([['op@example.com', 'owner-9']]) });
  deps.createAccount = async () => 'exists';
  const out = await runProvision(deps, parsed());
  assert.deepEqual(out, { status: 200, body: { ok: true, code: 'exists' } });
  assert.deepEqual(w.calls, ['apply', 'ensure']);
});

test('a member that cannot be created is a 500 server_error and nothing else happens', async () => {
  const { w, deps } = world({ createMemberFails: true });
  const out = await runProvision(deps, parsed());
  assert.deepEqual(out, { status: 500, body: { ok: false, code: 'server_error' } });
  assert.deepEqual(w.calls, ['createMember']);
});

test('the site refusing for has_website after the account is made is 409 has_website; failing is 500', async () => {
  const a = world({ ensure: { ok: false, reason: 'has_website' } });
  assert.deepEqual(await runProvision(a.deps, parsed()), { status: 409, body: { ok: false, code: 'has_website' } });
  const b = world({ ensure: { ok: false, reason: 'failed' } });
  assert.deepEqual(await runProvision(b.deps, parsed()), { status: 500, body: { ok: false, code: 'server_error' } });
});

test('the response never carries the email, company or phone', async () => {
  const { deps } = world();
  const out = await runProvision(deps, parsed());
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /example\.com|Op Homes|07123/);
});

test('parseProvisionBody: strict about every field', () => {
  assert.ok(parseProvisionBody(BODY));
  assert.equal(parseProvisionBody(BODY)?.email, 'op@example.com');
  assert.equal(parseProvisionBody({ ...BODY, phone: null })?.phone, null);
  const { phone: _p, ...noPhone } = BODY;
  assert.equal(parseProvisionBody(noPhone)?.phone, null);
  assert.equal(parseProvisionBody({ ...BODY, phone: '  ' })?.phone, null);
  for (const bad of [
    null, [], 'x', 7,
    { ...BODY, ld_customer_id: '' },
    { ...BODY, ld_customer_id: 'has space' },
    { ...BODY, ld_customer_id: 5 },
    { ...BODY, ld_customer_id: 'x'.repeat(129) },
    { ...BODY, email: 'nope' },
    { ...BODY, email: 5 },
    { ...BODY, company: '' },
    { ...BODY, company: '   ' },
    { ...BODY, company: 'x'.repeat(121) },
    { ...BODY, company: 5 },
    { ...BODY, phone: 12345 },
    { ...BODY, phone: '<script>' },
    { ...BODY, state: undefined },
    { ...BODY, state: { ...STATE, cardOnFile: 'yes' } },
    { ...BODY, state: { ...STATE, stateAsOf: 'yesterday' } },
  ]) {
    assert.equal(parseProvisionBody(bad), null, JSON.stringify(bad));
  }
});
