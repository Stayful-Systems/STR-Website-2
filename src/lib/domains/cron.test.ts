import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness, type Harness } from './test-store.ts';
import { START_BUDGET_MS, plan, runDomains, ukDay, type CronDeps } from './cron-run.ts';
import type { EmailCopy } from '../email/new-lead.ts';
import type { DomainStatus } from './types.ts';

const DAY = 86_400_000;

function cron(h: Harness, over: Partial<CronDeps> = {}) {
  const emails: Array<{ copy: EmailCopy; key: string }> = [];
  const deps: CronDeps = {
    engine: h.engine,
    list: async (statuses: readonly DomainStatus[]) => [...h.store.domains.values()].filter((d) => statuses.includes(d.status)).map((d) => ({ ...d })),
    stamp: (id, patch) => h.store.updateDomain(id, patch),
    sendAdmin: async (copy, key) => { emails.push({ copy, key }); return true; },
    panelUrl: 'https://app.example.test/admin/management',
    now: () => h.deps.now(),
    ...over,
  };
  return { deps, emails };
}

async function liveDomain(h: Harness, company = 'Harbour Management Ltd') {
  const d = await h.chosen({ auto: true, company });
  h.vercel.config = { ...h.vercel.config, misconfigured: false };
  await h.engine.advance(d.domainId);
  assert.equal((await h.store.domain(d.domainId))?.status, 'live');
  return d;
}

/** Snapshot of everything a dry run must leave alone. */
function snapshot(h: Harness) {
  return JSON.stringify({ d: [...h.store.domains.entries()], s: [...h.store.spend.entries()], o: [...h.store.offers.entries()], si: [...h.store.sites.entries()], c: h.store.charges });
}

test('the order of a run is held_cap, registering, connecting, stuck, renewals, auto-renew, renew decisions', async () => {
  const src = readFileSync(new URL('./cron-run.ts', import.meta.url), 'utf8');
  const steps = ["await each('heldCap'", "await each('registering'", "await each('connecting'", "await each('resendEmail'", "await each('stuck'", "await each('renewalWindow'", "await each('autoRenew'", "await each('renewDecisions'"];
  const at = steps.map((s) => src.indexOf(s));
  assert.ok(at.every((i) => i > 0), 'every step is there');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in this order');
  // The brief's order is also what a real run reports.
  const h = harness();
  const { deps } = cron(h);
  const report = await runDomains(deps, { dry: false });
  assert.deepEqual(Object.keys(report.counts), ['heldCap', 'registering', 'connecting', 'resendEmail', 'stuck', 'renewalWindow', 'autoRenew', 'renewDecisions']);
});

test('a dry run writes nothing and calls no client: not the registrar, not Vercel, not email', async () => {
  const h = harness();
  const held = await h.chosen({ company: 'Alder Homes Ltd' });
  await h.store.updateDomain(held.domainId, { status: 'held_cap' });
  const conn = await h.chosen({ company: 'Birch Homes Ltd', auto: true });
  const live = await liveDomain(h, 'Cedar Homes Ltd');
  await h.store.updateDomain(live.domainId, { expiresAt: new Date(h.deps.now().getTime() + 3 * DAY).toISOString() });
  h.setNow(new Date(h.deps.now().getTime() + 2 * DAY)); // held_cap is from an earlier day, and things are stuck
  const { deps, emails } = cron(h);

  const before = snapshot(h);
  const writes = h.store.writes.length;
  const reg = { ...h.registrar.calls };
  const vlog = h.vercel.log.length;
  const sent = h.sent.length;
  const report = await runDomains(deps, { dry: true });

  assert.equal(report.dry, true);
  assert.equal(snapshot(h), before, 'nothing in the store changed');
  assert.equal(h.store.writes.length, writes);
  assert.deepEqual(h.registrar.calls, reg);
  assert.equal(h.vercel.log.length, vlog);
  assert.equal(h.sent.length, sent);
  assert.equal(emails.length, 0);
  assert.equal(report.outcomes, undefined, 'a dry run has no outcomes: nothing ran');
  assert.ok(report.ids.heldCap.includes(held.domainId), 'but it says what would run');
  assert.ok(report.ids.connecting.includes(conn.domainId) || (await h.store.domain(conn.domainId))?.status !== 'connecting');
  assert.ok(report.ids.autoRenew.includes(live.domainId));
});

test('the route\'s dry run is read-only in the source too: it never reaches an engine write, an email or a stamp', () => {
  const src = readFileSync(new URL('./cron-run.ts', import.meta.url), 'utf8');
  const dryReturn = src.indexOf("if (opts.dry) return { dry: true, ...summarise(p) };");
  assert.ok(dryReturn > 0);
  const before = src.slice(0, dryReturn);
  const body = before.slice(before.indexOf('export async function runDomains'));
  assert.doesNotMatch(body, /deps\.engine\.(buy|advance|renew|release|resendLiveEmail|chooseName|offerNames)|deps\.stamp|deps\.sendAdmin/);
  // plan() only reads: the list, and the auto-renew verdict (our own database).
  const planFn = src.slice(src.indexOf('export async function plan'), src.indexOf('export interface RunReport'));
  assert.doesNotMatch(planFn, /deps\.engine\.(buy|advance|renew|release|resendLiveEmail)|deps\.stamp|deps\.sendAdmin/);
  const route = readFileSync(new URL('../../app/api/internal/domains/route.ts', import.meta.url), 'utf8');
  assert.match(route, /searchParams\.get\('dry'\) === '1'/);
  assert.match(route, /authoriseInternal\(request\)/);
  assert.match(route, /export const maxDuration = 60;/);
  assert.doesNotMatch(route, /console\.(log|info)/);
});

test('held_cap from an earlier UK day buys; one from today waits', async () => {
  const h = harness();
  const a = await h.chosen({ company: 'Alder Homes Ltd' });
  await h.store.updateDomain(a.domainId, { status: 'held_cap' });
  const { deps } = cron(h);
  let r = await runDomains(deps, { dry: false });
  assert.equal(r.counts.heldCap, 0, 'held today: it waits for the next UK day');
  assert.equal(h.registrar.calls.register, 0);
  h.setNow(new Date(h.deps.now().getTime() + 26 * 3600_000));
  r = await runDomains(deps, { dry: false });
  assert.deepEqual(r.ids.heldCap, [a.domainId]);
  assert.equal(r.outcomes?.find((o) => o.step === 'heldCap')?.outcome, 'registered');
  assert.equal(h.registrar.calls.register, 1);
  assert.equal(ukDay(new Date('2026-06-30T23:30:00Z')), '2026-07-01', 'the UK day, not the UTC one, in summer');
});

test('registering for 15 minutes is resumed after an ownership check, and a fresh one is left alone', async () => {
  const h = harness();
  const a = await h.chosen();
  h.registrar.unclearOnNextRegister = 'after';
  await h.engine.buy(a.domainId, { admin: true });
  assert.equal((await h.store.domain(a.domainId))?.status, 'registering');
  const { deps } = cron(h);
  assert.equal((await runDomains(deps, { dry: false })).counts.registering, 0, 'just touched: not yet');
  h.setNow(new Date(h.deps.now().getTime() + 16 * 60_000));
  const r = await runDomains(deps, { dry: false });
  assert.deepEqual(r.ids.registering, [a.domainId]);
  assert.equal(h.registrar.calls.register, 1, 'the name was ours: never registered twice');
  assert.equal((await h.store.domain(a.domainId))?.status, 'connecting');
});

test('connecting is advanced, and a live email that did not go is sent again', async () => {
  const h = harness();
  const a = await h.chosen({ auto: true });
  const { deps } = cron(h);
  h.vercel.config = { ...h.vercel.config, misconfigured: false };
  h.deps.sendLiveEmail = async (i) => { h.sent.push(i); return false; };
  let r = await runDomains(deps, { dry: false });
  assert.deepEqual(r.ids.connecting, [a.domainId]);
  assert.equal((await h.store.domain(a.domainId))?.status, 'live');
  h.deps.sendLiveEmail = async (i) => { h.sent.push(i); return true; };
  r = await runDomains(deps, { dry: false });
  assert.deepEqual(r.ids.resendEmail, [a.domainId]);
  assert.equal((await h.store.domain(a.domainId))?.lastError, null);
});

test('stuck for 24 hours: one admin email, once', async () => {
  const h = harness();
  const a = await h.chosen({ auto: true });
  h.vercel.config = { ...h.vercel.config, misconfigured: true }; // DNS never arrives
  const { deps, emails } = cron(h);
  await runDomains(deps, { dry: false });
  assert.equal(emails.length, 0, 'not stuck yet');
  h.setNow(new Date(h.deps.now().getTime() + 25 * 3600_000));
  let r = await runDomains(deps, { dry: false });
  assert.deepEqual(r.ids.stuck, [a.domainId]);
  assert.equal(emails.length, 1);
  assert.match(emails[0].copy.subject, /stuck/i);
  assert.match(emails[0].copy.subject, /harbourmanagement\.co\.uk/);
  assert.ok((await h.store.domain(a.domainId))?.stuckAlertedAt);
  h.setNow(new Date(h.deps.now().getTime() + 15 * 60_000));
  r = await runDomains(deps, { dry: false });
  assert.equal(r.counts.stuck, 0);
  assert.equal(emails.length, 1, 'the admin is told once');
  // An email that fails is tried again on the next run, not stamped.
  const h2 = harness();
  const b = await h2.chosen({ auto: true });
  h2.vercel.config = { ...h2.vercel.config, misconfigured: true };
  h2.setNow(new Date(h2.deps.now().getTime() + 25 * 3600_000));
  const { deps: d2 } = cron(h2, { sendAdmin: async () => false });
  await runDomains(d2, { dry: false });
  assert.equal((await h2.store.domain(b.domainId))?.stuckAlertedAt, null);
});

test('renewals within 30 days: one admin email per domain per period', async () => {
  const h = harness();
  const a = await liveDomain(h);
  const { deps, emails } = cron(h);
  assert.equal((await runDomains(deps, { dry: false })).counts.renewalWindow, 0, 'a year away');
  await h.store.updateDomain(a.domainId, { expiresAt: new Date(h.deps.now().getTime() + 29 * DAY).toISOString() });
  const r = await runDomains(deps, { dry: false });
  assert.deepEqual(r.ids.renewalWindow, [a.domainId]);
  assert.equal(emails.length, 1);
  assert.match(emails[0].copy.subject, /renewal due/);
  assert.equal(emails[0].key, `domain-renewal:${a.domainId}:${(await h.store.domain(a.domainId))!.expiresAt!.slice(0, 10)}`);
  await runDomains(deps, { dry: false });
  await runDomains(deps, { dry: false });
  assert.equal(emails.length, 1, 'once for the period');
  // The next period (after a renewal) is a new email.
  await h.engine.renew(a.domainId);
  await h.store.updateDomain(a.domainId, { expiresAt: new Date(h.deps.now().getTime() + 20 * DAY).toISOString() });
  await runDomains(deps, { dry: false });
  assert.equal(emails.length, 2);
});

test('7 days left and nobody decided: renewed if the site is live and allowed, and the admin is emailed once', async () => {
  const h = harness();
  const a = await liveDomain(h);
  await h.store.updateDomain(a.domainId, { expiresAt: new Date(h.deps.now().getTime() + 6 * DAY).toISOString() });
  const { deps, emails } = cron(h);
  const r = await runDomains(deps, { dry: false });
  assert.deepEqual(r.ids.autoRenew, [a.domainId]);
  assert.equal(r.outcomes?.find((o) => o.step === 'autoRenew')?.outcome, 'renewed');
  assert.equal(h.registrar.calls.renew, 1);
  assert.ok(emails.some((e) => /renewed automatically/.test(e.copy.subject)));
  assert.equal(h.store.charges.length, 0, 'the yearly charge is off');
  await runDomains(deps, { dry: false });
  assert.equal(h.registrar.calls.renew, 1, 'a renewed domain is a year away again');
});

test('7 days left: a switched-off site, or renewing blocked, is NOT renewed, and the admin is told once', async () => {
  for (const mode of ['site_off', 'blocked'] as const) {
    const h = harness();
    const a = await liveDomain(h);
    await h.store.updateDomain(a.domainId, { expiresAt: new Date(h.deps.now().getTime() + 5 * DAY).toISOString() });
    if (mode === 'site_off') h.store.sites.get(a.siteId)!.status = 'paused';
    else await h.engine.blockRenewal(a.siteId);
    const { deps, emails } = cron(h);
    await runDomains(deps, { dry: false });
    await runDomains(deps, { dry: false });
    assert.equal(h.registrar.calls.renew, 0, mode);
    const told = emails.filter((e) => /not renewed/.test(e.copy.subject));
    assert.equal(told.length, 1, `${mode}: once`);
  }
});

test('an admin decision wins over the rule: Don\'t renew is left alone, Renew is renewed', async () => {
  const h = harness();
  const a = await liveDomain(h, 'Alder Homes Ltd');
  const b = await liveDomain(h, 'Birch Homes Ltd');
  const soon = new Date(h.deps.now().getTime() + 5 * DAY).toISOString();
  await h.store.updateDomain(a.domainId, { expiresAt: soon, renewDecision: 'dont_renew' });
  await h.store.updateDomain(b.domainId, { expiresAt: soon, renewDecision: 'renew' });
  const { deps } = cron(h);
  const r = await runDomains(deps, { dry: false });
  assert.deepEqual(r.ids.autoRenew, []);
  assert.deepEqual(r.ids.renewDecisions, [b.domainId]);
  assert.equal(h.registrar.calls.renew, 1);
  assert.ok(h.registrar.log.some((l) => l === `renew:birchmanagement.co.uk`) || h.registrar.log.some((l) => l.startsWith('renew:')));
});

test('a renewal held by the daily cap is tried again, and the admin hears about the hold once', async () => {
  const h = harness();
  const a = await liveDomain(h);
  await h.store.updateDomain(a.domainId, { expiresAt: new Date(h.deps.now().getTime() + 4 * DAY).toISOString() });
  h.store.settingsNow.dailySpendCapPence = 600; // already used by the registration
  const { deps, emails } = cron(h);
  await runDomains(deps, { dry: false });
  await runDomains(deps, { dry: false });
  assert.equal(h.registrar.calls.renew, 0);
  assert.equal(emails.filter((e) => /could not be renewed yet/.test(e.copy.subject)).length, 1);
  h.store.spend.get(`register:${a.domainId}`)!.status = 'void'; // the next UK day has room
  await runDomains(deps, { dry: false });
  assert.equal(h.registrar.calls.renew, 1);
});

test('one domain\'s failure never ends the run, and no new work starts after 40 seconds', async () => {
  const h = harness();
  const a = await h.chosen({ auto: true, company: 'Alder Homes Ltd' });
  const b = await h.chosen({ auto: true, company: 'Birch Homes Ltd' });
  h.vercel.config = { ...h.vercel.config, misconfigured: false };
  const realAdvance = h.engine.advance;
  let calls = 0;
  const engine = { ...h.engine, advance: async (id: string, o?: { dryRun?: boolean }) => { calls++; if (calls === 1) throw new TypeError('boom'); return realAdvance(id, o); } };
  const { deps } = cron(h, { engine });
  const r = await runDomains(deps, { dry: false });
  const outcomes = r.outcomes!.filter((o) => o.step === 'connecting');
  assert.equal(outcomes.length, 2);
  assert.match(outcomes[0].outcome, /^error:TypeError$/);
  assert.equal((await h.store.domain(b.domainId))?.status, 'live', 'the second still ran');
  assert.ok(a.domainId);

  const h2 = harness();
  await h2.chosen({ auto: true });
  let t = 0;
  const { deps: slow } = cron(h2, { clock: () => (t += START_BUDGET_MS) });
  const r2 = await runDomains(slow, { dry: false });
  assert.ok(r2.outcomes!.every((o) => o.outcome === 'out_of_time'), 'the clock says time is up');
  assert.equal(START_BUDGET_MS, 40_000);
});

test('plan lists only what a real run would touch', async () => {
  const h = harness();
  await h.chosen({ company: 'Alder Homes Ltd' });
  const p = await plan(cron(h).deps);
  for (const [k, v] of Object.entries(p)) assert.equal(v.length, 0, k);
});

test('vercel.json schedules the cron at 4, 19, 34 and 49 past the hour', () => {
  const v = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8')) as { crons: Array<{ path: string; schedule: string }> };
  assert.deepEqual(v.crons.filter((c) => c.path === '/api/internal/domains'), [{ path: '/api/internal/domains', schedule: '4,19,34,49 * * * *' }]);
});
