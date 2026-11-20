import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSOLE_KINDS,
  consoleRunner,
  isConsoleKind,
  loadConsole,
  planConsoleAction,
  type ConsoleDeps,
  type ConsoleKind,
  type ConsoleSite,
  type ConsoleSource,
  type GraceViewLite,
} from './grace-admin.ts';
import { DELETION_KEEPS, DELETION_REMOVES } from './grace-run.ts';
import { DEFAULT_GRACE } from './grace-settings.ts';

const TODAY = '2026-11-20';
const OPTS = { deleteAfterDays: 90, today: TODAY };

const site = (over: Partial<ConsoleSite> = {}): ConsoleSite => ({
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  slug: 'harbour',
  ownerId: 'oooooooo-1111-4111-8111-111111111111',
  member: 'owner@example.test',
  status: 'live',
  display: 'live',
  switchedOff: false,
  deleted: false,
  domain: null,
  leads30: 0,
  lastLogin: null,
  lastEnquiry: null,
  warningsSent: 0,
  switchOffOn: null,
  deleteOn: null,
  reason: null,
  requestsNew: 0,
  requestsOpen: 0,
  ...over,
});
const OFF = (over: Partial<ConsoleSite> = {}) => site({ status: 'paused', display: 'switched off', switchedOff: true, ...over });
const GONE = () => site({ status: 'paused', display: 'deleted', deleted: true });

test('the six actions are a closed set', () => {
  assert.deepEqual([...CONSOLE_KINDS], ['pause', 'resume', 'switch_off', 'switch_on', 'export', 'delete']);
  assert.equal(isConsoleKind('delete'), true);
  for (const bad of ['drop', 'DELETE', '', null, undefined, 3]) assert.equal(isConsoleKind(bad), false, String(bad));
});

test('Delete is only allowed on a switched-off site', () => {
  for (const s of [site(), site({ status: 'paused', display: 'paused' }), site({ status: 'preview', display: 'preview' }), GONE()]) {
    const p = planConsoleAction('delete', s, OPTS);
    assert.equal(p.ok, false, s.display);
  }
  assert.match(planConsoleAction('delete', site(), OPTS).lines[0], /only allowed on a switched-off site/);
  const ok = planConsoleAction('delete', OFF(), OPTS);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.removes, [...DELETION_REMOVES]);
  assert.deepEqual(ok.keeps, [...DELETION_KEEPS]);
  assert.ok(ok.keeps!.some((k) => /leads/.test(k)), 'the plan says leads are kept');
});

test('switch off states the email, the renewal block, the delete date and that leads carry on', () => {
  const p = planConsoleAction('switch_off', site(), OPTS);
  assert.equal(p.ok, true);
  assert.equal(p.emails.length, 1);
  assert.match(p.emails[0], /switched off/i);
  assert.match(p.emails[0], /daily cap/i);
  const text = p.lines.join(' ');
  assert.match(text, /stops renewing/);
  assert.match(text, /2027-02-18/, '20 Nov + 90 days');
  assert.match(text, /carry on/);
  assert.equal(planConsoleAction('switch_off', OFF(), OPTS).ok, false);
  assert.equal(planConsoleAction('switch_off', GONE(), OPTS).ok, false);
});

test('pause and resume only apply to a live / admin-paused site; a switched-off one uses Switch back on', () => {
  assert.deepEqual([planConsoleAction('pause', site(), OPTS).ok, planConsoleAction('pause', site(), OPTS).to], [true, 'paused']);
  assert.equal(planConsoleAction('pause', OFF(), OPTS).ok, false);
  const paused = site({ status: 'paused', display: 'paused' });
  assert.deepEqual([planConsoleAction('resume', paused, OPTS).ok, planConsoleAction('resume', paused, OPTS).to], [true, 'live']);
  assert.equal(planConsoleAction('resume', site(), OPTS).ok, false);
  const r = planConsoleAction('resume', OFF(), OPTS);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /Switch back on/);
});

test('switch back on needs a switched-off, not deleted, site; export is always allowed and read only', () => {
  assert.equal(planConsoleAction('switch_on', OFF(), OPTS).ok, true);
  assert.equal(planConsoleAction('switch_on', site(), OPTS).ok, false);
  assert.equal(planConsoleAction('switch_on', GONE(), OPTS).ok, false);
  for (const s of [site(), OFF(), GONE()]) {
    const p = planConsoleAction('export', s, OPTS);
    assert.equal(p.ok, true);
    assert.deepEqual(p.emails, []);
  }
});

// ── The loader ──

function fakeSource(): ConsoleSource & { calls: string[] } {
  const calls: string[] = [];
  const sites = [
    { id: 's1', userId: 'u1', funnelId: 'f1', slug: 'harbour', status: 'live', domain: null },
    { id: 's2', userId: 'u2', funnelId: 'f2', slug: 'bay', status: 'paused', domain: null },
    { id: 's3', userId: 'u3', funnelId: 'f3', slug: 'gone', status: 'paused', domain: 'gone.co.uk' },
    { id: 's4', userId: 'u4', funnelId: 'f4', slug: 'held', status: 'paused', domain: null },
  ];
  return {
    calls,
    sites: async () => (calls.push('sites'), sites),
    emails: async () => new Map([['u1', 'one@example.test'], ['u2', 'two@example.test'], ['u3', null], ['u4', 'four@example.test']]),
    lastSeen: async () => new Map([['u1', '2026-11-19T10:00:00Z'], ['u2', '2026-08-01T10:00:00Z']]),
    recentLeads: async () => [
      { funnelId: 'f1', createdAt: '2026-11-10T10:00:00Z' },
      { funnelId: 'f1', createdAt: '2026-11-15T10:00:00Z' },
    ],
    lastLead: async (ids) => (calls.push(`lastLead:${ids.join(',')}`), new Map([['f2', '2026-07-01T10:00:00Z']])),
    graceRows: async () => [
      { websiteId: 's2', episodeStartedAt: '2026-09-01T06:45:00Z', cancelledAt: null },
      { websiteId: 's3', episodeStartedAt: '2026-05-01T06:45:00Z', cancelledAt: null },
    ],
    sentNotices: async () => [
      { websiteId: 's2', episodeStartedAt: '2026-09-01T06:45:00Z' },
      { websiteId: 's2', episodeStartedAt: '2026-09-01T06:45:00Z' },
      { websiteId: 's2', episodeStartedAt: '2025-01-01T00:00:00Z' }, // an earlier, cancelled episode
    ],
    domains: async () => new Map([['s1', 'harbour.co.uk']]),
    requestCounts: async () => new Map([['s1', { new: 1, open: 2 }]]),
  };
}

const VIEWS: Record<string, GraceViewLite> = {
  s2: { pendingSwitchOff: null, reason: 'abandoned', switchedOff: true, switchedOffAt: new Date('2026-10-01T06:47:00Z'), deleteOn: '2026-12-30', deleted: false },
  s3: { pendingSwitchOff: null, reason: 'unpaid', switchedOff: true, switchedOffAt: new Date('2026-06-01T06:47:00Z'), deleteOn: null, deleted: true },
};

test('the console derives status, dates and counts: switched off, deleted, leads, last enquiry, warnings, requests', async () => {
  const src = fakeSource();
  const rows = await loadConsole(src, async (id) => VIEWS[id] ?? null, { now: new Date('2026-11-20T12:00:00Z') });
  const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
  assert.equal(by.harbour.display, 'live');
  assert.equal(by.harbour.member, 'one@example.test');
  assert.equal(by.harbour.leads30, 2);
  assert.equal(by.harbour.lastEnquiry, '2026-11-15T10:00:00Z');
  assert.equal(by.harbour.lastLogin, '2026-11-19T10:00:00Z');
  assert.equal(by.harbour.domain, 'harbour.co.uk');
  assert.equal(by.harbour.requestsNew, 1);
  assert.equal(by.harbour.requestsOpen, 2);

  assert.equal(by.bay.display, 'switched off');
  assert.equal(by.bay.switchedOff, true);
  assert.equal(by.bay.switchOffOn, '2026-10-01', 'the day it was switched off');
  assert.equal(by.bay.deleteOn, '2026-12-30');
  assert.equal(by.bay.warningsSent, 2, 'only this episode’s sent warnings');
  assert.equal(by.bay.lastEnquiry, '2026-07-01T10:00:00Z', 'older than 30 days: found by the per-funnel lookup');
  assert.equal(by.bay.leads30, 0);

  assert.equal(by.gone.display, 'deleted');
  assert.equal(by.gone.deleted, true);
  assert.equal(by.gone.switchedOff, false);
  assert.equal(by.gone.domain, 'gone.co.uk');
  assert.equal(by.gone.member, 'u3', 'a missing email falls back to the id');

  assert.equal(by.held.display, 'paused', 'an admin-paused site has no grace row: plain paused');
  // Only the funnels with nothing recent are asked about; and only sites with a grace row get a derived view.
  assert.ok(src.calls.some((c) => c.startsWith('lastLead:') && !c.includes('f1')));
});

test('a login that cancelled a pending switch-off shows no pending date (the view decides, not the row)', async () => {
  const src = fakeSource();
  const pending: GraceViewLite = { pendingSwitchOff: '2026-12-15', reason: 'abandoned', switchedOff: false, switchedOffAt: null, deleteOn: null, deleted: false };
  const rows = await loadConsole(src, async (id) => (id === 's2' ? pending : null));
  const s2 = rows.find((r) => r.slug === 'bay')!;
  assert.equal(s2.switchOffOn, '2026-12-15');
  assert.equal(s2.display, 'paused');
  const cancelled = await loadConsole(src, async () => ({ ...pending, pendingSwitchOff: null }));
  assert.equal(cancelled.find((r) => r.slug === 'bay')!.switchOffOn, null);
});

test('a failing derived view for one site does not take the console down', async () => {
  const rows = await loadConsole(fakeSource(), async () => {
    throw new Error('boom');
  });
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => !r.switchedOff && !r.deleted));
});

// ── The runner ──

function fakeDeps(sites: ConsoleSite[]) {
  const log = { writes: [] as string[], dry: [] as string[], audit: [] as string[], reads: [] as string[] };
  const deps: ConsoleDeps = {
    loadSite: async (id) => (log.reads.push(`load:${id}`), sites.find((s) => s.id === id) ?? null),
    settings: async () => DEFAULT_GRACE,
    today: () => TODAY,
    setStatus: async (ownerId, to) => (log.writes.push(`setStatus:${ownerId}:${to}`), { ok: true }),
    switchOff: async (id, o) => (o.dryRun ? log.dry.push(`switchOff:${id}`) : log.writes.push(`switchOff:${id}`), { ok: true }),
    switchOn: async (ownerId) => (log.writes.push(`switchOn:${ownerId}`), { ok: true }),
    deleteData: async (id, o) => (o.dryRun ? log.dry.push(`delete:${id}`) : log.writes.push(`delete:${id}`), { ok: true }),
    exportData: async (id) => (log.reads.push(`export:${id}`), { settings: {}, pages: {}, versions: [] }),
    audit: (line) => log.audit.push(line),
  };
  return { deps, log };
}

test('every dry run writes nothing: no status change, switch off, switch on, delete or audit line', async () => {
  const live = site();
  const off = OFF({ id: 'bbbbbbbb-2222-4222-8222-222222222222' });
  const paused = site({ id: 'cccccccc-3333-4333-8333-333333333333', status: 'paused', display: 'paused' });
  const { deps, log } = fakeDeps([live, off, paused]);
  const run = consoleRunner(deps);
  for (const kind of CONSOLE_KINDS) {
    for (const s of [live, off, paused]) await run.dryRun(kind, s.id);
  }
  assert.deepEqual(log.writes, [], 'no write of any kind');
  assert.deepEqual(log.audit, [], 'a dry run leaves no audit line');
  // The engines were only asked with their dry-run flag.
  assert.ok(log.dry.length > 0);
});

test('a dry run for switch off, delete and export reports what happens and offers Run only when it passes', async () => {
  const off = OFF({ id: 'bbbbbbbb-2222-4222-8222-222222222222' });
  const { deps } = fakeDeps([site(), off]);
  const run = consoleRunner(deps);
  const d = await run.dryRun('delete', off.id);
  assert.equal(d.ok, true);
  assert.equal(d.canRun, true);
  assert.deepEqual(d.removes, [...DELETION_REMOVES]);
  assert.deepEqual(d.keeps, [...DELETION_KEEPS]);
  const refused = await run.dryRun('delete', site().id);
  assert.equal(refused.ok, false);
  assert.equal(refused.canRun, false);
  const sw = await run.dryRun('switch_off', site().id);
  assert.equal(sw.canRun, true);
  assert.equal(sw.emails.length, 1);
  assert.equal((await run.dryRun('pause', 'missing')).canRun, false);
});

test('Run Delete is refused unless the site is switched off, and deleteData is never called', async () => {
  const live = site();
  const paused = site({ id: 'cccccccc-3333-4333-8333-333333333333', status: 'paused', display: 'paused' });
  const gone = { ...GONE(), id: 'dddddddd-4444-4444-8444-444444444444' };
  const { deps, log } = fakeDeps([live, paused, gone]);
  const run = consoleRunner(deps);
  for (const s of [live, paused, gone]) {
    const r = await run.run('delete', s.id);
    assert.equal(r.ok, false, s.display);
  }
  assert.deepEqual(log.writes, []);
  assert.deepEqual(log.audit, []);
});

test('Run uses the site’s own owner id for pause, resume and switch back on, never anything from the caller', async () => {
  const live = site();
  const off = OFF({ id: 'bbbbbbbb-2222-4222-8222-222222222222', ownerId: 'oooooooo-2222-4222-8222-222222222222' });
  const paused = site({ id: 'cccccccc-3333-4333-8333-333333333333', ownerId: 'oooooooo-3333-4333-8333-333333333333', status: 'paused', display: 'paused' });
  const { deps, log } = fakeDeps([live, off, paused]);
  const run = consoleRunner(deps);
  assert.equal((await run.run('pause', live.id)).ok, true);
  assert.equal((await run.run('resume', paused.id)).ok, true);
  assert.equal((await run.run('switch_on', off.id)).ok, true);
  assert.equal((await run.run('switch_off', live.id)).ok, true);
  assert.equal((await run.run('delete', off.id)).ok, true);
  assert.deepEqual(log.writes, [
    `setStatus:${live.ownerId}:paused`,
    `setStatus:${paused.ownerId}:live`,
    `switchOn:${off.ownerId}`,
    `switchOff:${live.id}`,
    `delete:${off.id}`,
  ]);
});

test('export returns JSON and changes nothing', async () => {
  const { deps, log } = fakeDeps([OFF()]);
  const r = await consoleRunner(deps).run('export', OFF().id);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(JSON.parse(r.data!)), ['settings', 'pages', 'versions']);
  assert.deepEqual(log.writes, []);
});

test('a refused switch back on says why and a failed run leaves a refused audit code only', async () => {
  const off = OFF();
  const { deps, log } = fakeDeps([off]);
  deps.switchOn = async () => ({ ok: false, messages: ['Your plan has ended.'] });
  const r = await consoleRunner(deps).run('switch_on', off.id);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'Your plan has ended.');
  assert.deepEqual(log.audit, [`switch_on ${off.id.slice(0, 8)}: refused refused`]);
});

test('audit lines carry the kind, a short id and a code: never the member’s address or a message', async () => {
  const off = OFF({ id: 'bbbbbbbb-2222-4222-8222-222222222222', member: 'secret.person@example.test' });
  const { deps, log } = fakeDeps([site(), off]);
  const run = consoleRunner(deps);
  await run.run('delete', off.id);
  await run.run('pause', site().id);
  assert.equal(log.audit.length, 2);
  for (const line of log.audit) {
    assert.doesNotMatch(line, /@|example\.test|secret/);
    assert.match(line, /^[a-z_]+ [0-9a-f]{8}: (ok|refused \w+)$/);
  }
});

test('the kinds, as a type, cover the runner (no unhandled action)', () => {
  const k: ConsoleKind[] = [...CONSOLE_KINDS];
  assert.equal(k.length, 6);
});
