import { test } from 'node:test';
import assert from 'node:assert/strict';
import { START_REFUSALS, canStart, methodFor, overlapDue, overlapEndsAt, stuckDue, type CanStartInput } from './transfer-rules.ts';

const CODE_FROM = '2027-02-09';

test('methodFor: the tag before 9 Feb 2027, the code on and after it', () => {
  assert.equal(methodFor(new Date('2027-02-08T23:59:59Z'), CODE_FROM, true), 'tag');
  assert.equal(methodFor(new Date('2027-02-09T00:00:00Z'), CODE_FROM, true), 'code');
  assert.equal(methodFor(new Date('2027-02-09T12:00:00Z'), CODE_FROM, true), 'code');
  assert.equal(methodFor(new Date('2026-11-21T10:00:00Z'), CODE_FROM, true), 'tag');
  assert.equal(methodFor(new Date('2028-01-01T00:00:00Z'), CODE_FROM, true), 'code');
});

test('methodFor: no domain means files only, whatever the date', () => {
  assert.equal(methodFor(new Date('2026-11-21T10:00:00Z'), CODE_FROM, false), 'none');
  assert.equal(methodFor(new Date('2027-06-01T10:00:00Z'), CODE_FROM, false), 'none');
});

const OK: CanStartInput = { isOwner: true, deleted: false, pageCount: 5, hasOpenTransfer: false, hasDomain: true, domainReady: true, domainUnpaid: false };

test('canStart: an owner of a normal site with a live, paid domain may start', () => {
  assert.deepEqual(canStart(OK), { ok: true });
  assert.deepEqual(canStart({ ...OK, hasDomain: false, domainReady: false }), { ok: true }, 'no domain: files only');
});

test('canStart: every refusal, with its code and plain message', () => {
  const cases: [Partial<CanStartInput>, keyof typeof START_REFUSALS][] = [
    [{ isOwner: false }, 'not_owner'],
    [{ deleted: true }, 'deleted'],
    [{ pageCount: 0 }, 'no_pages'],
    [{ hasOpenTransfer: true }, 'open_transfer'],
    [{ domainReady: false }, 'domain_not_ready'],
    [{ domainUnpaid: true }, 'unpaid_domain'],
  ];
  for (const [patch, code] of cases) {
    const r = canStart({ ...OK, ...patch });
    assert.equal(r.ok, false, code);
    if (!r.ok) {
      assert.equal(r.code, code);
      assert.equal(r.message, START_REFUSALS[code]);
    }
  }
  assert.equal(START_REFUSALS.domain_not_ready, 'Your domain is still being set up; try again once it is live.');
});

test('canStart: the first refusal wins, and a paused site is not a refusal', () => {
  const all = canStart({ isOwner: false, deleted: true, pageCount: 0, hasOpenTransfer: true, hasDomain: true, domainReady: false, domainUnpaid: true });
  assert.equal(!all.ok && all.code, 'not_owner');
  const noPages = canStart({ ...OK, pageCount: 0, hasOpenTransfer: true });
  assert.equal(!noPages.ok && noPages.code, 'no_pages');
  const notReady = canStart({ ...OK, domainReady: false, domainUnpaid: true });
  assert.equal(!notReady.ok && notReady.code, 'domain_not_ready');
});

test('overlapEndsAt: exactly the overlap days later', () => {
  assert.equal(overlapEndsAt(new Date('2026-11-21T10:00:00Z'), 30).toISOString(), '2026-12-21T10:00:00.000Z');
  assert.equal(overlapEndsAt(new Date('2026-11-21T10:00:00Z'), 1).toISOString(), '2026-11-22T10:00:00.000Z');
});

const ENDS = '2026-12-21T10:00:00.000Z';
const before = new Date('2026-12-21T09:59:59.000Z');
const at = new Date(ENDS);

test('overlapDue: not before the date, even when the domain has moved', () => {
  assert.equal(overlapDue({ overlap_ends_at: ENDS, domain_state: 'moved' }, before), false);
  assert.equal(overlapDue({ overlap_ends_at: ENDS, domain_state: 'none' }, before), false);
});

test('overlapDue: on the date, only when moved, no domain, or forced', () => {
  assert.equal(overlapDue({ overlap_ends_at: ENDS, domain_state: 'moved' }, at), true);
  assert.equal(overlapDue({ overlap_ends_at: ENDS, domain_state: 'none' }, at), true);
  for (const s of ['pending', 'manual', 'requested']) {
    assert.equal(overlapDue({ overlap_ends_at: ENDS, domain_state: s }, at), false, s);
    assert.equal(overlapDue({ overlap_ends_at: ENDS, domain_state: s, forced: true }, at), true, `${s} forced`);
  }
  assert.equal(overlapDue({ overlap_ends_at: new Date(ENDS), domain_state: 'moved' }, new Date('2027-01-30T00:00:00Z')), true);
});

test('overlapDue: never twice, never once cancelled, never without a date', () => {
  assert.equal(overlapDue({ overlap_ends_at: ENDS, domain_state: 'moved', overlap_ended_at: '2026-12-22T00:00:00Z' }, at), false);
  assert.equal(overlapDue({ overlap_ends_at: ENDS, domain_state: 'none', cancelled_at: '2026-12-01T00:00:00Z' }, at), false);
  assert.equal(overlapDue({ overlap_ends_at: null, domain_state: 'none' }, at), false);
  assert.equal(overlapDue({ overlap_ends_at: 'not a date', domain_state: 'none' }, at), false);
});

const ASKED = '2026-11-21T10:00:00.000Z';
const row = (over: Record<string, unknown> = {}) => ({ domain_state: 'requested', domain_requested_at: ASKED, stuck_alerted_at: null, cancelled_at: null, ...over });

test('stuckDue: only more than the days after the request', () => {
  const day = 86400000;
  const t = Date.parse(ASKED);
  assert.equal(stuckDue(row(), new Date(t + 5 * day), 5), false, 'exactly 5 days is not more than 5');
  assert.equal(stuckDue(row(), new Date(t + 5 * day + 1000), 5), true);
  assert.equal(stuckDue(row(), new Date(t + 2 * day), 5), false);
  assert.equal(stuckDue(row({ domain_state: 'manual' }), new Date(t + 9 * day), 5), true);
});

test('stuckDue: exactly once, and not for a moved, cancelled or never-requested domain', () => {
  const later = new Date(Date.parse(ASKED) + 10 * 86400000);
  assert.equal(stuckDue(row(), later, 5), true);
  assert.equal(stuckDue(row({ stuck_alerted_at: later.toISOString() }), later, 5), false, 'already alerted');
  assert.equal(stuckDue(row({ domain_state: 'moved' }), later, 5), false);
  assert.equal(stuckDue(row({ cancelled_at: ASKED }), later, 5), false);
  assert.equal(stuckDue(row({ domain_requested_at: null }), later, 5), false);
  assert.equal(stuckDue(row({ domain_state: 'none', domain_requested_at: null }), later, 5), false);
});
