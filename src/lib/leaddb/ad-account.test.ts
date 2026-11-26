import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adRouteStopped,
  adRouteVerdict,
  parseAdAccountState,
  rowToAdAccount,
  shouldApplyState,
  stateToRowPatch,
  type AdAccountState,
  type LeadDbAdAccount,
  type LeadDbAdAccountRow,
} from './ad-account.ts';

const NOW = new Date('2026-11-26T12:00:00Z');
const AS_OF = new Date('2026-11-26T09:00:00Z');

function acct(over: Partial<LeadDbAdAccount> = {}): LeadDbAdAccount {
  return {
    ownerId: 'owner-1',
    ldCustomerId: 'ld-1',
    linkId: 'link-1',
    allowed: true,
    cardOnFile: true,
    accountStatus: 'active',
    cancelEffectiveAt: null,
    lapsed: false,
    stateAsOf: AS_OF,
    ...over,
  };
}

const state = (over: Partial<AdAccountState> = {}): AdAccountState => ({
  accountStatus: 'active',
  cardOnFile: true,
  cancelEffectiveAt: null,
  lapsed: false,
  stateAsOf: '2026-11-26T09:00:00Z',
  ...over,
});

test('active with a card and allowed: not stopped, verdict ok', () => {
  assert.equal(adRouteStopped(acct(), NOW), false);
  assert.deepEqual(adRouteVerdict(acct(), NOW), { ok: true });
});

test('pending cancel before its date still works; at and after the date it stops', () => {
  const before = acct({ accountStatus: 'pending_cancel', cancelEffectiveAt: new Date('2026-12-01T00:00:00Z') });
  assert.equal(adRouteStopped(before, NOW), false);
  assert.deepEqual(adRouteVerdict(before, NOW), { ok: true });

  const at = acct({ accountStatus: 'pending_cancel', cancelEffectiveAt: NOW });
  assert.equal(adRouteStopped(at, NOW), true);
  assert.deepEqual(adRouteVerdict(at, NOW), { ok: false, reason: 'account_stopped' });

  const after = acct({ accountStatus: 'pending_cancel', cancelEffectiveAt: new Date('2026-11-20T00:00:00Z') });
  assert.equal(adRouteStopped(after, NOW), true);
  assert.deepEqual(adRouteVerdict(after, NOW), { ok: false, reason: 'account_stopped' });
});

test('paused is never read: a paused account is not stopped by itself', () => {
  for (const s of ['paused', 'PAUSED', 'Paused']) {
    assert.equal(adRouteStopped(acct({ accountStatus: s }), NOW), false);
    assert.deepEqual(adRouteVerdict(acct({ accountStatus: s }), NOW), { ok: true });
  }
});

test('lapsed stops, by flag or by status, in any case', () => {
  assert.equal(adRouteStopped(acct({ lapsed: true }), NOW), true);
  assert.equal(adRouteStopped(acct({ accountStatus: 'lapsed' }), NOW), true);
  assert.equal(adRouteStopped(acct({ accountStatus: ' LAPSED ' }), NOW), true);
  assert.deepEqual(adRouteVerdict(acct({ lapsed: true }), NOW), { ok: false, reason: 'account_stopped' });
});

test('cancelled stops, in any case', () => {
  assert.equal(adRouteStopped(acct({ accountStatus: 'cancelled' }), NOW), true);
  assert.equal(adRouteStopped(acct({ accountStatus: 'Cancelled' }), NOW), true);
  assert.deepEqual(adRouteVerdict(acct({ accountStatus: 'cancelled' }), NOW), { ok: false, reason: 'account_stopped' });
});

test('past due with a card on file is NOT stopped by itself (assumption for Zac)', () => {
  const a = acct({ accountStatus: 'past_due' });
  assert.equal(adRouteStopped(a, NOW), false);
  assert.deepEqual(adRouteVerdict(a, NOW), { ok: true });
});

test('no card stops the route and has its own reason', () => {
  const a = acct({ cardOnFile: false });
  assert.equal(adRouteStopped(a, NOW), true);
  assert.deepEqual(adRouteVerdict(a, NOW), { ok: false, reason: 'no_card' });
});

test('an account that never received a state is stopped (fail closed)', () => {
  const a = acct({ stateAsOf: null });
  assert.equal(adRouteStopped(a, NOW), true);
  assert.deepEqual(adRouteVerdict(a, NOW), { ok: false, reason: 'account_stopped' });
});

test('no account at all is stopped', () => {
  assert.equal(adRouteStopped(null, NOW), true);
  assert.deepEqual(adRouteVerdict(null, NOW), { ok: false, reason: 'no_account' });
});

test('not allowed is its own reason and does not make the account "stopped"', () => {
  const a = acct({ allowed: false });
  assert.equal(adRouteStopped(a, NOW), false);
  assert.deepEqual(adRouteVerdict(a, NOW), { ok: false, reason: 'not_allowed' });
});

test('reason order: no_account, account_stopped, no_card, not_allowed', () => {
  // Everything wrong at once: the first reason wins.
  const worst = acct({ lapsed: true, cardOnFile: false, allowed: false });
  assert.deepEqual(adRouteVerdict(worst, NOW), { ok: false, reason: 'account_stopped' });
  // Stopped state beats no card.
  assert.deepEqual(adRouteVerdict(acct({ stateAsOf: null, cardOnFile: false, allowed: false }), NOW), { ok: false, reason: 'account_stopped' });
  // No card beats not allowed.
  assert.deepEqual(adRouteVerdict(acct({ cardOnFile: false, allowed: false }), NOW), { ok: false, reason: 'no_card' });
  // Only not allowed left.
  assert.deepEqual(adRouteVerdict(acct({ allowed: false }), NOW), { ok: false, reason: 'not_allowed' });
  // No account beats everything.
  assert.deepEqual(adRouteVerdict(null, NOW), { ok: false, reason: 'no_account' });
});

test('a stale push is ignored; an equal time is applied; a newer one is applied', () => {
  const cur = { stateAsOf: new Date('2026-11-26T09:00:00Z') };
  assert.equal(shouldApplyState(cur, state({ stateAsOf: '2026-11-26T08:59:59Z' })), false);
  assert.equal(shouldApplyState(cur, state({ stateAsOf: '2026-11-26T09:00:00Z' })), true);
  assert.equal(shouldApplyState(cur, state({ stateAsOf: '2026-11-26T09:00:01Z' })), true);
  assert.equal(shouldApplyState(cur, state({ stateAsOf: '2026-11-26T10:00:00+01:00' })), true);
  assert.equal(shouldApplyState(cur, state({ stateAsOf: '2026-11-26T08:00:00-01:00' })), true);
});

test('a row with no state yet, or no row, takes any push', () => {
  assert.equal(shouldApplyState({ stateAsOf: null }, state()), true);
  assert.equal(shouldApplyState(null, state()), true);
});

test('parseAdAccountState accepts a good state, with optional fields absent or null', () => {
  assert.deepEqual(
    parseAdAccountState({ accountStatus: 'pending_cancel', cardOnFile: true, cancelEffectiveAt: '2026-12-01T00:00:00Z', lapsed: false, stateAsOf: '2026-11-26T09:00:00Z' }),
    { accountStatus: 'pending_cancel', cardOnFile: true, cancelEffectiveAt: '2026-12-01T00:00:00Z', lapsed: false, stateAsOf: '2026-11-26T09:00:00Z' },
  );
  assert.deepEqual(parseAdAccountState({ cardOnFile: false, lapsed: true, stateAsOf: '2026-11-26T09:00:00.000Z' }), {
    accountStatus: null,
    cardOnFile: false,
    cancelEffectiveAt: null,
    lapsed: true,
    stateAsOf: '2026-11-26T09:00:00.000Z',
  });
  assert.equal(parseAdAccountState({ accountStatus: null, cardOnFile: true, cancelEffectiveAt: null, lapsed: false, stateAsOf: '2026-11-26T09:00:00Z' })?.accountStatus, null);
});

test('parseAdAccountState rejects anything malformed and never throws', () => {
  const good = { accountStatus: 'active', cardOnFile: true, cancelEffectiveAt: null, lapsed: false, stateAsOf: '2026-11-26T09:00:00Z' };
  const bad: unknown[] = [
    null,
    undefined,
    'x',
    42,
    [],
    {},
    { ...good, stateAsOf: undefined },
    { ...good, stateAsOf: 'yesterday' },
    { ...good, stateAsOf: '2026-13-45T99:99:00Z' },
    { ...good, stateAsOf: 1764147600000 },
    { ...good, cardOnFile: 'true' },
    { ...good, cardOnFile: undefined },
    { ...good, lapsed: 0 },
    { ...good, lapsed: undefined },
    { ...good, accountStatus: 5 },
    { ...good, accountStatus: '' },
    { ...good, accountStatus: 'x'.repeat(65) },
    { ...good, cancelEffectiveAt: 'soon' },
    { ...good, cancelEffectiveAt: 12345 },
  ];
  for (const b of bad) assert.equal(parseAdAccountState(b), null, JSON.stringify(b));
  assert.notEqual(parseAdAccountState(good), null);
});

test('rowToAdAccount maps the row and parses the dates', () => {
  const row: LeadDbAdAccountRow = {
    owner_id: 'o',
    ld_customer_id: 'c',
    link_id: null,
    allowed: true,
    allowed_by: 'admin',
    allowed_at: '2026-11-20T00:00:00Z',
    card_on_file: true,
    account_status: 'pending_cancel',
    cancel_effective_at: '2026-12-01T00:00:00+00:00',
    lapsed: false,
    state_as_of: '2026-11-26T09:00:00+00:00',
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-26T09:00:00Z',
  };
  const a = rowToAdAccount(row);
  assert.equal(a.ownerId, 'o');
  assert.equal(a.ldCustomerId, 'c');
  assert.equal(a.linkId, null);
  assert.equal(a.allowed, true);
  assert.equal(a.cardOnFile, true);
  assert.equal(a.accountStatus, 'pending_cancel');
  assert.equal(a.cancelEffectiveAt?.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(a.stateAsOf?.toISOString(), '2026-11-26T09:00:00.000Z');
  const none = rowToAdAccount({ ...row, cancel_effective_at: null, state_as_of: null });
  assert.equal(none.cancelEffectiveAt, null);
  assert.equal(none.stateAsOf, null);
  assert.equal(adRouteStopped(none, NOW), true);
});

test('a state patch never carries the allowed columns', () => {
  const patch = stateToRowPatch(state());
  assert.deepEqual(Object.keys(patch).sort(), ['account_status', 'cancel_effective_at', 'card_on_file', 'lapsed', 'state_as_of']);
});
