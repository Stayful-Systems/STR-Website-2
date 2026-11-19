import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestLanding, lowCreditRecheck, lowCreditTriggered, spentFromLedger, toldSinceLanding, type GrantRow } from './low-credit.ts';
import { DEFAULT_VOICE } from './settings.ts';

const g = (id: string, kind: string, amount: number, ref: string | null, at: string): GrantRow => ({ id, kind, amount_pence: amount, source_ref: ref, created_at: at });

test('the newest top-up or plan credit is the landing; referral, promo and admin credit are not', () => {
  const l = latestLanding([
    g('a', 'topup', 2500, 'pi:1', '2026-10-01T10:00:00Z'),
    g('b', 'adjustment', 1000, 'referral:x:y', '2026-10-03T10:00:00Z'),
    g('c', 'welcome', 500, 'profile_complete:u', '2026-10-04T10:00:00Z'),
    g('d', 'adjustment', 0, 'overdraft:u', '2026-10-05T10:00:00Z'),
  ]);
  assert.deepEqual(l, { id: 'a', amountPence: 2500, landedAt: new Date('2026-10-01T10:00:00Z') });
  assert.equal(latestLanding([g('p', 'plan', 1900, 'inv:1', '2026-10-02T00:00:00Z'), g('a', 'topup', 1000, 'pi:1', '2026-10-01T00:00:00Z')])?.id, 'p');
  assert.equal(latestLanding([g('b', 'adjustment', 1000, 'code:x:u', '2026-10-03T10:00:00Z')]), null);
});

test('the starter pack\'s two grants are one landing of £30', () => {
  const l = latestLanding([
    g('paid', 'topup', 1000, 'pi:ABC', '2026-10-01T10:00:00.100Z'),
    g('bonus', 'welcome', 2000, 'pack_bonus:ABC', '2026-10-01T10:00:00.200Z'),
  ]);
  assert.deepEqual(l, { id: 'paid', amountPence: 3000, landedAt: new Date('2026-10-01T10:00:00.100Z') });
});

const landing = { id: 'a', amountPence: 2500, landedAt: new Date('2026-10-01T10:00:00Z') };
const input = (o = {}) => ({ balancePence: 450, lowCreditPence: 500, landing, spentSincePence: 2050, now: new Date('2026-10-05T10:00:00Z'), settings: DEFAULT_VOICE, ...o });

test('fires at £5 left with 80% of a fresh top-up spent inside 7 days', () => {
  assert.equal(lowCreditTriggered(input()), true);
  assert.equal(lowCreditTriggered(input({ spentSincePence: 2000 })), true); // exactly 80%
  assert.equal(lowCreditTriggered(input({ spentSincePence: 1999 })), false);
  assert.equal(lowCreditTriggered(input({ balancePence: 501 })), false);
  assert.equal(lowCreditTriggered(input({ now: new Date('2026-10-08T10:00:01Z') })), false); // more than 7 days after
  assert.equal(lowCreditTriggered(input({ landing: null })), false);
});

test('spend from the ledger: debits less refunds, in face pence', () => {
  assert.equal(spentFromLedger([{ kind: 'debit', amount_pence: -100 }, { kind: 'debit', amount_pence: -65 }, { kind: 'refund', amount_pence: 40 }, { kind: 'grant', amount_pence: 2500 }]), 125);
});

test('R3-12: a notice stamped told at or after the landing means this credit was told; before it, or never, means not', () => {
  const landing = { id: 'g1', amountPence: 2_500, landedAt: new Date('2026-10-01T09:00:00Z') };
  assert.equal(toldSinceLanding('2026-10-05T07:10:00Z', landing), true);
  assert.equal(toldSinceLanding('2026-10-01T09:00:00Z', landing), true);
  assert.equal(toldSinceLanding('2026-09-20T07:10:00Z', landing), false);
  assert.equal(toldSinceLanding(null, landing), false);
  assert.equal(toldSinceLanding('not a date', landing), false);
  assert.equal(toldSinceLanding('2026-10-05T07:10:00Z', null), false);
});

// Review R4 (R4-34): the guard for Review R3's R3-14 (and R3-45). A queued low-credit call is tested again just before it rings.
test('R3-14: the low-credit call is dropped when the member topped up, a newer credit landed, or a nudge went instead', () => {
  const due = { balancePence: 450, lowCreditPence: 500, triggerRef: 'a' };
  assert.deepEqual(lowCreditRecheck(due), { ok: true });
  assert.deepEqual(lowCreditRecheck({ ...due, balancePence: 501 }), { ok: false, reason: 'topped_up' }, 'balance back above the mark');
  assert.deepEqual(lowCreditRecheck({ ...due, balancePence: null }), { ok: false, reason: 'topped_up' }, 'an unread balance never rings');
  assert.deepEqual(lowCreditRecheck({ ...due, balancePence: 500 }), { ok: true }, 'at the mark still rings');
  assert.deepEqual(lowCreditRecheck({ ...due, latestLandingId: 'b' }), { ok: false, reason: 'topped_up' }, 'a newer landing: the call is about credit that is gone');
  assert.deepEqual(lowCreditRecheck({ ...due, latestLandingId: 'a', nudged: true }), { ok: false, reason: 'nudged' });
  assert.deepEqual(lowCreditRecheck({ ...due, latestLandingId: 'a', nudged: false }), { ok: true });
  assert.deepEqual(lowCreditRecheck({ ...due, latestLandingId: null }), { ok: true }, 'unreadable grants leave the queue-time landing standing');
  assert.deepEqual(lowCreditRecheck({ ...due, triggerRef: null, latestLandingId: 'b', nudged: true }), { ok: true }, 'an older row with no landing rings on the balance alone');
});

test('R3-14: the queue re-checks a low-credit call just before it dials, and blocks it when it is no longer due', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const queue = read('./queue-server.ts');
  const check = queue.indexOf("if (type === 'low_credit') {");
  const recheck = queue.indexOf('await lowCreditStillDue(m.userId, call.trigger_ref, now)', check);
  const dial = queue.indexOf('const config = voiceConfig();');
  assert.ok(check > 0 && recheck > check && dial > recheck, 'the re-check runs before the call is placed');
  assert.match(queue.slice(recheck, dial), /if \(!still\.ok\) \{\s*if \(o\.apply\) await dropOrBlock\(call, still\.reason\);\s*return \{ outcome: 'blocked', reason: still\.reason \};/);
  const server = read('./low-credit-recheck-server.ts');
  assert.ok((server.match(/lowCreditRecheck\(/g) ?? []).length >= 3, 'every answer the re-check gives is lowCreditRecheck\'s');
  assert.doesNotMatch(server, /return \{ ok: (true|false)/, 'the server never decides on its own');
});
