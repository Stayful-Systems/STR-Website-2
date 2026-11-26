import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STALE_REASONS, settleStale, staleCreditDue, staleCreditLine, stalePence, staleRunMode, staleSourceRef, staleVerdict, type LedgerRow, type StaleDeal, type StaleDeps, type StaleOpenFacts } from './stale-credit.ts';

const S = { staleCreditDays: 7 };
const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-11-10T10:00:00Z');
const at = (days: number) => new Date(T0 + days * DAY).toISOString();
const open = (over: Partial<StaleOpenFacts> = {}): StaleOpenFacts => ({ id: '11111111-1111-4111-8111-111111111111', user_id: 'u1', status: 'open', opened_at: at(0), stale_credit_at: null, ...over });
const gone = (over: Partial<StaleDeal> = {}): StaleDeal => ({ status: 'retired', retired_reason: 'sold', retired_at: at(3), ...over });

test('inside the window is due; outside it is not', () => {
  assert.equal(staleCreditDue(open(), gone({ retired_at: at(3) }), S), true);
  assert.equal(staleCreditDue(open(), gone({ retired_at: at(7) }), S), true, 'exactly 7 days is inside');
  assert.equal(staleCreditDue(open(), gone({ retired_at: at(7.01) }), S), false);
  assert.equal(staleVerdict(open(), gone({ retired_at: at(20) }), S), 'outside_window');
  assert.equal(staleCreditDue(open(), gone({ retired_at: at(20) }), S, { ignoreWindow: true }), true, 'the admin button ignores the window');
  assert.equal(staleCreditDue(open(), gone({ retired_at: at(3) }), { staleCreditDays: 2 }), false, 'the days are the setting');
});

test('the reasons that count, and the ones that do not', () => {
  for (const r of ['sold', 'under_offer', 'let_agreed', 'removed']) assert.equal(staleCreditDue(open(), gone({ retired_reason: r }), S), true, r);
  for (const r of ['unqualified', 'unsuitable', 'stale_listed', 'stale_unseen', 'unverifiable', 'admin', 'unchecked', 'not_project', null]) assert.equal(staleCreditDue(open(), gone({ retired_reason: r }), S), false, String(r));
  assert.deepEqual([...STALE_REASONS].sort(), ['let_agreed', 'removed', 'sold', 'under_offer']);
});

test('only an open, uncredited open on a retired deal', () => {
  assert.equal(staleVerdict(open({ status: 'pending' }), gone(), S), 'not_open');
  assert.equal(staleVerdict(open({ stale_credit_at: at(4) }), gone(), S), 'already_credited');
  assert.equal(staleVerdict(open(), gone({ status: 'live', retired_reason: null, retired_at: null }), S), 'not_retired');
  assert.equal(staleVerdict(open(), gone({ retired_at: null }), S), 'bad_dates');
  assert.equal(staleVerdict(open(), gone({ retired_at: at(-1) }), S), 'outside_window', 'gone before it was opened is not a credit');
});

const tx = (id: number, kind: string, amount: number, over: Partial<LedgerRow> = {}): LedgerRow => ({ id, user_id: 'u1', kind, amount_pence: amount, metadata: null, ...over });

test('the amount is the open plus the full report, from the debits', () => {
  const ledger = [tx(1, 'debit', -50), tx(2, 'debit', -400), tx(3, 'debit', -999)];
  assert.equal(stalePence(ledger, [1, 2], 'u1'), 450, 'tx 3 is not this deal');
  assert.equal(stalePence(ledger, [1], 'u1'), 50);
  assert.equal(stalePence(ledger, [], 'u1'), 0, 'nothing spent, nothing credited');
  assert.equal(stalePence([tx(1, 'debit', 0)], [1], 'u1'), 0, 'a free open is nothing');
});

test('refunds already made are taken off, and never below zero', () => {
  const ledger = [tx(1, 'debit', -100), tx(9, 'refund', 40, { metadata: { refund_of: 1 } })];
  assert.equal(stalePence(ledger, [1], 'u1'), 60);
  assert.equal(stalePence([tx(1, 'debit', -100), tx(9, 'refund', 100, { metadata: { refund_of: 1 } })], [1], 'u1'), 0);
  assert.equal(stalePence([tx(1, 'debit', -100), tx(9, 'refund', 500, { metadata: { refund_of: 1 } })], [1], 'u1'), 0);
  assert.equal(stalePence([tx(1, 'debit', -100), tx(9, 'refund', 40, { metadata: { refund_of: 77 } })], [1], 'u1'), 100, 'a refund of some other debit is not this one');
});

test('a team member paying: only what was taken from the payer, and a debit is counted once', () => {
  const ledger = [tx(1, 'debit', -50, { user_id: 'payer' }), tx(2, 'debit', -400, { user_id: 'payer' }), tx(3, 'debit', -25, { user_id: 'someone-else' })];
  assert.equal(stalePence(ledger, [1, 2, 3], 'payer'), 450);
  assert.equal(stalePence([...ledger, ledger[0]], [1, 1, 2], 'payer'), 450, 'the same debit twice is one debit');
  assert.equal(stalePence([tx(1, 'debit', '-12.5' as unknown as number)], [1], 'u1'), 12.5, 'amounts arrive as text');
  assert.equal(stalePence([tx(1, 'grant', 500)], [1], 'u1'), 0, 'only debits count');
});

function fake(spent: number, opts: { failGrant?: boolean; failStamp?: boolean } = {}) {
  const grants = new Map<string, { userId: string; pence: number; description: string }>();
  let grantCalls = 0;
  const stamped: { openId: string; pence: number }[] = [];
  const deps: StaleDeps = {
    spentPence: async () => spent,
    async grant(userId, pence, sourceRef, description) {
      grantCalls += 1;
      if (opts.failGrant) throw new Error('boom');
      if (!grants.has(sourceRef)) grants.set(sourceRef, { userId, pence, description }); // the ledger's unique source_ref
    },
    async stamp(openId, pence) {
      if (opts.failStamp) return false;
      stamped.push({ openId, pence });
      return true;
    },
  };
  return { deps, grants, stamped, calls: () => grantCalls };
}

test('a due open is granted once, as the actual spend, with its source_ref', async () => {
  const f = fake(450);
  const out = await settleStale(f.deps, open(), gone(), S, { now: new Date(T0 + 4 * DAY) });
  assert.deepEqual(out, { ok: true, pence: 450, granted: true });
  assert.deepEqual([...f.grants.keys()], [staleSourceRef(open().id)]);
  assert.equal(f.grants.get('stale:11111111-1111-4111-8111-111111111111')?.pence, 450);
  assert.match(f.grants.get('stale:11111111-1111-4111-8111-111111111111')?.description ?? '', /within 7 days/);
  assert.deepEqual(f.stamped, [{ openId: open().id, pence: 450 }]);
});

test('no double grant: two runs that race grant once (the source_ref), and a stamped open is not due again', async () => {
  const f = fake(450);
  await Promise.all([settleStale(f.deps, open(), gone(), S), settleStale(f.deps, open(), gone(), S)]);
  assert.equal(f.grants.size, 1, 'the ledger keeps one grant per source_ref');
  const again = await settleStale(f.deps, open({ stale_credit_at: at(4) }), gone(), S);
  assert.deepEqual(again, { ok: false, code: 'already_credited' });
  assert.equal(f.calls(), 2, 'the settled open made no third call');
});

test('nothing spent: nothing is granted, and the open is settled at 0', async () => {
  const f = fake(0);
  const out = await settleStale(f.deps, open(), gone(), S);
  assert.deepEqual(out, { ok: true, pence: 0, granted: false });
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.stamped, [{ openId: open().id, pence: 0 }]);
});

test('a dry run works out the amount and writes nothing', async () => {
  const f = fake(450);
  const out = await settleStale(f.deps, open(), gone(), S, { dry: true });
  assert.deepEqual(out, { ok: true, pence: 450, granted: false });
  assert.equal(f.calls(), 0);
  assert.equal(f.stamped.length, 0);
});

test('a failed grant stamps nothing; a failed stamp is retried by the next run without a second credit', async () => {
  const a = fake(450, { failGrant: true });
  assert.deepEqual(await settleStale(a.deps, open(), gone(), S), { ok: false, code: 'failed' });
  assert.equal(a.stamped.length, 0);
  const b = fake(450, { failStamp: true });
  assert.deepEqual(await settleStale(b.deps, open(), gone(), S), { ok: false, code: 'failed' });
  assert.deepEqual(await settleStale(b.deps, open(), gone(), S), { ok: false, code: 'failed' });
  assert.equal(b.grants.size, 1, 'granted twice in calls, once in the ledger');
});

test('a ledger that cannot be read grants nothing', async () => {
  const f = fake(450);
  f.deps.spentPence = async () => {
    throw new Error('down');
  };
  assert.deepEqual(await settleStale(f.deps, open(), gone(), S), { ok: false, code: 'failed' });
  assert.equal(f.calls(), 0);
});

test('an open that is not due is never granted, whatever was spent', async () => {
  const f = fake(450);
  assert.deepEqual(await settleStale(f.deps, open(), gone({ retired_reason: 'unqualified' }), S), { ok: false, code: 'not_a_gone_reason' });
  assert.deepEqual(await settleStale(f.deps, open(), gone({ retired_at: at(30) }), S), { ok: false, code: 'outside_window' });
  assert.equal(f.calls(), 0);
});

test('the switch: off does nothing, on does it, a dry run only lists and lists even while off', () => {
  assert.equal(staleRunMode({ staleCreditEnabled: false }, false), 'skip');
  assert.equal(staleRunMode({ staleCreditEnabled: true }, false), 'live');
  assert.equal(staleRunMode({ staleCreditEnabled: false }, true), 'dry');
  assert.equal(staleRunMode({ staleCreditEnabled: true }, true), 'dry');
});

test('the line on My opened deals', () => {
  assert.equal(staleCreditLine(7, 450), 'Gone within 7 days, £4.50 credited back');
  assert.equal(staleCreditLine(7, 400), 'Gone within 7 days, £4 credited back');
  assert.equal(staleCreditLine(7, 25), 'Gone within 7 days, £0.25 credited back');
});
