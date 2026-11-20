import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLink, confirmLink, revokeLink, testPush, type LinkDeps, type LinkRecord } from './links.ts';
import type { LeadDbResult } from './client.ts';
import { leadDbMessage, leadDbBadge, needsAccount, NOT_AVAILABLE } from './messages.ts';

const OWNER = 'owner-1';
const ok = <T,>(data: T): LeadDbResult<T> => ({ ok: true, code: 'ok', retryable: false, status: 200, data });
const no = (code: string, status = 422): LeadDbResult<never> => ({ ok: false, code, retryable: false, status });

function make(over: Partial<LinkDeps> = {}, initial: LinkRecord | null = null) {
  let rec = initial;
  const calls: { fn: string; body?: unknown }[] = [];
  const deps: LinkDeps = {
    store: {
      async get() { return rec; },
      async saveCodeSent(o, linkId, email) { rec = { owner_id: o, link_id: linkId, email, lead_type: null, status: 'code_sent', connected_at: null, last_ok_at: null, last_error: null }; },
      async saveActive(_o, t) { if (rec) rec = { ...rec, status: 'active', lead_type: t, connected_at: 'now' }; },
      async saveRevoked() { if (rec) rec = { ...rec, status: 'revoked' }; },
      async saveError(_o, code) { if (rec) rec = { ...rec, last_error: code }; },
    },
    start: (async (b: unknown) => { calls.push({ fn: 'start', body: b }); return ok({ ok: true as const, link_id: 'link-1', status: 'code_sent' as const }); }) as LinkDeps['start'],
    confirm: (async (b: unknown) => { calls.push({ fn: 'confirm', body: b }); return ok({ ok: true as const, status: 'confirmed' as const, lead_type: 'management' as const }); }) as LinkDeps['confirm'],
    revoke: (async (b: unknown) => { calls.push({ fn: 'revoke', body: b }); return ok({}); }) as LinkDeps['revoke'],
    push: (async (b: unknown) => { calls.push({ fn: 'push', body: b }); return ok({ ok: true as const, outcome: 'created' as const, replayed: false, lead_id: 'l', url: 'u', report: 'coming' as const }); }) as LinkDeps['push'],
    randomId: () => 'test-id',
    ...over,
  };
  return { deps, calls, rec: () => rec };
}

test('start sends the member and a tidy email, and stores a pending link with no code', async () => {
  const m = make();
  assert.deepEqual(await startLink(OWNER, '  Owner@Example.COM ', m.deps), { ok: true, code: 'code_sent' });
  assert.deepEqual(m.calls[0], { fn: 'start', body: { si_member_id: OWNER, email: 'owner@example.com' } });
  assert.equal(m.rec()?.status, 'code_sent');
  assert.equal(m.rec()?.link_id, 'link-1');
});

test('start refuses a bad email before calling out; no_account and no_product come back as codes and store nothing', async () => {
  const m = make();
  assert.equal((await startLink(OWNER, 'not an email', m.deps)).code, 'bad_request');
  assert.equal(m.calls.length, 0);
  const none = make({ start: (async () => no('no_account')) as LinkDeps['start'] });
  assert.deepEqual(await startLink(OWNER, 'a@b.co', none.deps), { ok: false, code: 'no_account' });
  assert.equal(none.rec(), null);
  const nop = make({ start: (async () => no('no_product')) as LinkDeps['start'] });
  assert.equal((await startLink(OWNER, 'a@b.co', nop.deps)).code, 'no_product');
});

test('confirm needs a pending link and a 6-digit code; success activates it with the lead type', async () => {
  const empty = make();
  assert.equal((await confirmLink(OWNER, '123456', empty.deps)).code, 'unknown_link');
  const m = make({}, { owner_id: OWNER, link_id: 'link-1', email: 'a@b.co', lead_type: null, status: 'code_sent', connected_at: null, last_ok_at: null, last_error: null });
  assert.equal((await confirmLink(OWNER, '12 34', m.deps)).code, 'wrong_code');
  assert.equal(m.calls.length, 0);
  assert.deepEqual(await confirmLink(OWNER, '123 456', m.deps), { ok: true, code: 'confirmed' });
  assert.deepEqual(m.calls[0], { fn: 'confirm', body: { link_id: 'link-1', si_member_id: OWNER, code: '123456' } });
  assert.equal(m.rec()?.status, 'active');
  assert.equal(m.rec()?.lead_type, 'management');
});

test('a wrong or expired code leaves the link pending', async () => {
  for (const code of ['wrong_code', 'expired_code', 'too_many_attempts']) {
    const m = make({ confirm: (async () => no(code)) as LinkDeps['confirm'] }, { owner_id: OWNER, link_id: 'l', email: 'a@b.co', lead_type: null, status: 'code_sent', connected_at: null, last_ok_at: null, last_error: null });
    assert.equal((await confirmLink(OWNER, '123456', m.deps)).code, code);
    assert.equal(m.rec()?.status, 'code_sent');
  }
});

test('disconnect revokes locally even when the lead database cannot be reached', async () => {
  const m = make({ revoke: (async () => ({ ok: false, code: 'network', retryable: true, status: 0 })) as LinkDeps['revoke'] }, { owner_id: OWNER, link_id: 'l', email: 'a@b.co', lead_type: 'management', status: 'active', connected_at: 'x', last_ok_at: null, last_error: null });
  assert.deepEqual(await revokeLink(OWNER, m.deps), { ok: true, remote: false });
  assert.equal(m.rec()?.status, 'revoked');
  assert.deepEqual((await revokeLink(OWNER, make().deps)), { ok: true, remote: false });
});

test('test push needs an active link, sends test:true and no landlord details, and surfaces a link error', async () => {
  assert.equal((await testPush(OWNER, make().deps)).code, 'not_linked');
  const active: LinkRecord = { owner_id: OWNER, link_id: 'l', email: 'a@b.co', lead_type: 'management', status: 'active', connected_at: 'x', last_ok_at: null, last_error: null };
  const m = make({}, active);
  const r = await testPush(OWNER, m.deps);
  assert.equal(r.ok, true);
  const body = m.calls[0].body as { test: boolean; si_lead_id: string; lead: Record<string, string> };
  assert.equal(body.test, true);
  assert.equal(body.si_lead_id, 'test-id');
  assert.ok(Object.values(body.lead).every((v) => v === ''));
  const bad = make({ push: (async () => no('not_linked', 403)) as LinkDeps['push'] }, active);
  assert.equal((await testPush(OWNER, bad.deps)).code, 'not_linked');
  assert.equal(bad.rec()?.last_error, 'not_linked');
});

test('messages: plain English, never the raw code, and the not-available line', () => {
  assert.equal(leadDbMessage('not_configured'), NOT_AVAILABLE);
  assert.equal(NOT_AVAILABLE, 'Lead database link not available yet');
  for (const c of ['no_account', 'no_product', 'wrong_code', 'expired_code', 'too_many_attempts', 'rate_limited', 'network']) {
    assert.ok(leadDbMessage(c).length > 20 && !leadDbMessage(c).includes('_'), c);
  }
  assert.doesNotMatch(leadDbMessage('some_internal_thing'), /some_internal_thing/);
  assert.equal(needsAccount('no_account'), true);
  assert.equal(needsAccount('no_product'), false);
  assert.equal(leadDbBadge(null), null);
  assert.equal(leadDbBadge({ deliveryStatus: 'sent', leadSent: false, reportSent: false }), null);
  assert.equal(leadDbBadge({ deliveryStatus: 'sent', leadSent: true, reportSent: false }), 'In your lead database · report coming');
  assert.equal(leadDbBadge({ deliveryStatus: 'sent', leadSent: true, reportSent: true }), 'In your lead database');
  assert.equal(leadDbBadge({ deliveryStatus: 'sent', leadSent: true, reportSent: false, noReport: true }), 'In your lead database');
});
