import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TIME_BUDGET_MS,
  deleteWith,
  exportWith,
  finishSwitchOffWith,
  graceFactsOf,
  offKey,
  runWebsiteGrace,
  siteGraceView,
  switchOffWith,
  switchOnWith,
  warningKey,
  type DeleteDeps,
  type ExportDeps,
  type FinishOffDeps,
  type GraceEpisodeRow,
  type GraceRunDeps,
  type GraceSite,
  type SiteLite,
  type SwitchOffDeps,
  type SwitchOnDeps,
  type SwitchOnSite,
} from './grace-run.ts';
import { addDays, ukDayOf, type GraceFacts, type GraceNotice } from './grace-rules.ts';
import { DEFAULT_GRACE } from './grace-settings.ts';
import { buildSitePages } from './page-model.ts';
import { SAMPLE_COPY, SAMPLE_SETTINGS, SAMPLE_SITE } from './sample-site.ts';

const at = (day: string, time = '12:00:00') => new Date(`${day}T${time}Z`);
const OWNER_EMAIL = 'owner.private@example.test';
const BODY_TEXT = 'My private change request text';

// ── A fake world: stores rows, counts every write, claim, send and storage delete ──

interface Row {
  websiteId: string;
  ownerId: string;
  status: string;
  email: string | null;
  facts: GraceFacts;
  episode: GraceEpisodeRow | null;
  notices: GraceNotice[];
}

class World {
  rows = new Map<string, Row>();
  writes = 0;
  claims = 0;
  sends: { websiteId: string; kind: 'warn' | 'off'; stage?: number; key: string; claimed: boolean }[] = [];
  storageDeletes = 0;
  activity = 0;
  blockRenewals: string[] = [];
  deletedSites: string[] = [];
  usedSlots = new Set<string>();
  cancels: string[] = [];
  logs: string[] = [];
  sendFails = false;
  /** The clock the next run uses. */
  now = at('2026-03-02', '06:45:00');
  clockMs = 0;

  add(websiteId: string, facts: Partial<GraceFacts> = {}, over: Partial<Row> = {}): Row {
    const row: Row = {
      websiteId,
      ownerId: `owner-${websiteId}`,
      status: 'live',
      email: OWNER_EMAIL,
      facts: { siteLive: true, liveAt: at('2025-06-01'), lastSeen: at('2026-01-01'), lastLead: null, planLapsed: false, planEndsAt: null, unpaidDomain: false, unpaidSince: null, gateOn: false, chargeOn: false, ...facts },
      episode: null,
      notices: [],
      ...over,
    };
    this.rows.set(websiteId, row);
    return row;
  }

  /** What a write costs: counted, so a dry run can be shown to make none. */
  private w(): void {
    this.writes++;
  }

  lite(id: string): SiteLite | null {
    const r = this.rows.get(id);
    return r ? { id, ownerId: r.ownerId, status: r.status, episode: r.episode } : null;
  }

  switchOffDeps(): SwitchOffDeps {
    return {
      load: async (id) => this.lite(id),
      deleteAfterDays: async () => DEFAULT_GRACE.deleteAfterDays,
      pause: async (site) => {
        this.w();
        const r = this.rows.get(site.id)!;
        r.status = 'paused';
        r.facts = { ...r.facts, siteLive: false };
        return true;
      },
      stamp: async (id, f) => {
        this.w();
        const r = this.rows.get(id)!;
        const open = r.episode && !r.episode.cancelledAt && !r.episode.deletedAt;
        r.episode = open
          ? { ...r.episode!, switchedOffAt: f.at, switchOffBy: f.by, deleteOn: f.deleteOn }
          : { reason: f.reason, startedAt: f.at, cancelledAt: null, switchedOffAt: f.at, deletedAt: null, switchOffOn: null, switchOffBy: f.by, offEmailedAt: null, deleteOn: f.deleteOn };
        return true;
      },
      finish: (id, now) => finishSwitchOffWith(this.finishDeps(), id, now),
    };
  }

  capDeps() {
    return {
      claimSlot: async (userId: string) => {
        this.claims++;
        if (this.usedSlots.has(userId)) return { ok: false as const, reason: 'slot_used' };
        this.usedSlots.add(userId);
        return { ok: true as const, id: `claim-${this.claims}` };
      },
      releaseClaim: async (id: string) => {
        this.w();
        void id;
      },
      markSending: async () => {
        this.w();
        return true;
      },
      abandonSend: async (id: string) => {
        this.w();
        // The slot comes back.
        for (const u of [...this.usedSlots]) if (id.startsWith('claim')) this.usedSlots.delete(u);
      },
      finishSend: async () => {
        this.w();
      },
    };
  }

  finishDeps(): FinishOffDeps {
    return {
      ...this.capDeps(),
      episode: async (id) => {
        const r = this.rows.get(id);
        return r?.episode ? { ...r.episode, ownerId: r.ownerId, email: r.email } : null;
      },
      blockRenewal: async (id) => {
        this.w();
        this.blockRenewals.push(id);
        return true;
      },
      sendOffEmail: async (_to, _data, key) => {
        const id = key.split(':')[1];
        const claimed = this.usedSlots.has(this.rows.get(id)!.ownerId);
        this.sends.push({ websiteId: id, kind: 'off', key, claimed });
        return this.sendFails ? { sent: false, reason: 'send_failed' } : { sent: true };
      },
      stampEmailed: async (id, when) => {
        this.w();
        const r = this.rows.get(id)!;
        r.episode = { ...r.episode!, offEmailedAt: when };
      },
      deleteAfterDays: async () => DEFAULT_GRACE.deleteAfterDays,
    };
  }

  deleteDeps(): DeleteDeps {
    return {
      load: async (id) => this.lite(id),
      inventory: async () => ({ files: ['https://x/logo.png', 'https://x/me.jpg'], screenshots: ['o/1.png'], versions: 3, requests: 1, hasDraft: true }),
      deleteFile: async () => {
        this.storageDeletes++;
      },
      deleteScreenshots: async (paths) => {
        this.storageDeletes += paths.length;
      },
      deleteRows: async () => {
        this.w();
      },
      emptySite: async () => {
        this.w();
      },
      stampDeleted: async (id, when) => {
        this.w();
        const r = this.rows.get(id)!;
        r.episode = { ...r.episode!, deletedAt: when };
        this.deletedSites.push(id);
        return true;
      },
    };
  }

  deps(): GraceRunDeps {
    return {
      ...this.capDeps(),
      settings: async () => DEFAULT_GRACE,
      sites: async () =>
        [...this.rows.values()].map(
          (r): GraceSite => ({ websiteId: r.websiteId, ownerId: r.ownerId, status: r.status, email: r.email, facts: { ...r.facts }, episode: r.episode ? { ...r.episode } : null, notices: r.notices.map((n) => ({ ...n })) }),
        ),
      slotsUsedToday: async () => new Set(this.usedSlots),
      startEpisode: async (id, reason, startedAt, switchOffOn) => {
        this.w();
        const r = this.rows.get(id)!;
        r.episode = { reason, startedAt, cancelledAt: null, switchedOffAt: null, deletedAt: null, switchOffOn, switchOffBy: null, offEmailedAt: null, deleteOn: null };
        r.notices = [];
      },
      cancelEpisode: async (id, when) => {
        this.w();
        this.cancels.push(id);
        const r = this.rows.get(id)!;
        r.episode = { ...r.episode!, cancelledAt: when };
      },
      sendWarning: async (_to, data, key) => {
        const id = key.split(':')[1];
        this.sends.push({ websiteId: id, kind: 'warn', stage: Number(key.split(':').at(-1)), key, claimed: this.usedSlots.has(this.rows.get(id)!.ownerId) });
        void data;
        return this.sendFails ? { sent: false, reason: 'send_failed' } : { sent: true };
      },
      recordNotice: async (id, episodeStartedAt, stage, status, when) => {
        this.w();
        const r = this.rows.get(id)!;
        if (!r.notices.some((n) => n.stage === stage)) r.notices.push({ stage, status, sentAt: when });
        void episodeStartedAt;
      },
      switchOff: async (id) => {
        const res = await switchOffWith(this.switchOffDeps(), id, { by: 'cron', now: this.now });
        return res.ok ? { ok: true } : { ok: false, reason: res.reason };
      },
      finishSwitchOff: (id, now) => finishSwitchOffWith(this.finishDeps(), id, now),
      deleteData: async (id) => {
        const res = await deleteWith(this.deleteDeps(), id, { now: this.now });
        return res.ok ? { ok: true } : { ok: false, reason: res.reason };
      },
      log: (line) => this.logs.push(line),
      clock: () => this.clockMs,
    };
  }

  /** One cron run. A new day frees the day's slots. */
  async run(day: string, opts: { dry?: boolean; keepSlots?: boolean } = {}) {
    if (!opts.keepSlots && ukDayOf(this.now) !== day) this.usedSlots.clear();
    this.now = at(day, '06:45:00');
    return runWebsiteGrace(this.deps(), { dry: opts.dry ?? false, now: this.now });
  }
}

const warnsOf = (w: World, id: string) => w.sends.filter((s) => s.websiteId === id && s.kind === 'warn').map((s) => s.stage);

// ── Dry run ──

test('the dry run lists what each site would get and writes, claims, sends and deletes nothing', async () => {
  const w = new World();
  w.add('start-1', { lastSeen: at('2026-01-01') }); // 60 days quiet: would start and warn
  const cancel = w.add('cancel-1', { lastSeen: at('2026-03-01', '10:00:00') });
  cancel.episode = { reason: 'abandoned', startedAt: at('2026-02-01'), cancelledAt: null, switchedOffAt: null, deletedAt: null, switchOffOn: null, switchOffBy: null, offEmailedAt: null, deleteOn: null };
  const off = w.add('off-1', { lastSeen: at('2025-12-01') });
  off.episode = { reason: 'abandoned', startedAt: at('2026-01-30'), cancelledAt: null, switchedOffAt: null, deletedAt: null, switchOffOn: null, switchOffBy: null, offEmailedAt: null, deleteOn: null };
  off.notices = [{ stage: 30, status: 'sent', sentAt: at('2026-01-30') }];
  const gone = w.add('gone-1', { siteLive: false }, { status: 'paused' });
  gone.episode = { reason: 'abandoned', startedAt: at('2025-10-01'), cancelledAt: null, switchedOffAt: at('2025-11-01'), deletedAt: null, switchOffOn: null, switchOffBy: 'cron', offEmailedAt: at('2025-11-01'), deleteOn: null };
  const owed = w.add('owed-1', { siteLive: false }, { status: 'paused' });
  owed.episode = { reason: 'abandoned', startedAt: at('2026-02-20'), cancelledAt: null, switchedOffAt: at('2026-02-28'), deletedAt: null, switchOffOn: null, switchOffBy: 'cron', offEmailedAt: null, deleteOn: null };

  const res = await w.run('2026-03-02', { dry: true });
  assert.equal(res.status, 200);
  const b = res.body as Record<string, { websiteId: string }[] | unknown>;
  assert.equal(b.dry, true);
  assert.deepEqual((b.wouldCancel as { websiteId: string }[]).map((e) => e.websiteId), ['cancel-1']);
  assert.deepEqual((b.wouldStart as { websiteId: string }[]).map((e) => e.websiteId), ['start-1']);
  assert.deepEqual((b.wouldWarn as { websiteId: string; stage: number }[]).map((e) => `${e.websiteId}:${e.stage}`), ['start-1:30']);
  assert.deepEqual((b.wouldSwitchOff as { websiteId: string }[]).map((e) => e.websiteId), ['off-1']);
  assert.deepEqual((b.wouldDelete as { websiteId: string }[]).map((e) => e.websiteId), ['gone-1']);
  assert.deepEqual((b.wouldFinishOffEmail as { websiteId: string }[]).map((e) => e.websiteId), ['owed-1']);
  // Nothing happened.
  assert.deepEqual({ writes: w.writes, claims: w.claims, sends: w.sends.length, storage: w.storageDeletes, activity: w.activity, renewals: w.blockRenewals.length, logs: w.logs.length }, { writes: 0, claims: 0, sends: 0, storage: 0, activity: 0, renewals: 0, logs: 0 });
  assert.equal(w.rows.get('start-1')!.episode, null, 'the episode was only held in memory');
  assert.equal(w.rows.get('off-1')!.status, 'live');
});

test('a dry run shows a used slot as waiting (except the day before switch-off) and still claims nothing', async () => {
  const w = new World();
  w.add('a', { lastSeen: at('2026-01-01') });
  w.usedSlots.add('owner-a');
  const res = await w.run('2026-03-02', { dry: true, keepSlots: true });
  assert.equal((res.body.waiting as unknown[]).length, 1);
  assert.equal((res.body.wouldWarn as unknown[]).length, 0);
  assert.equal(w.claims, 0);
  assert.equal(w.writes, 0);
});

// ── Warnings ──

test('warnings go once each at 30, 14 and 3 days, a second run sends nothing, and the switch-off follows', async () => {
  const w = new World();
  w.add('a', { lastSeen: at('2026-01-01') });
  for (let d = '2026-03-02'; d <= '2026-04-02'; d = addDays(d, 1)) await w.run(d);
  assert.deepEqual(warnsOf(w, 'a'), [30, 14, 3]);
  assert.equal(w.rows.get('a')!.status, 'paused', 'switched off on 1 April');
  assert.equal(w.rows.get('a')!.episode!.switchedOffAt!.toISOString().slice(0, 10), '2026-04-01');
  assert.equal(w.sends.filter((s) => s.kind === 'off').length, 1, 'one switched-off email');
  // Re-running the last day again: nothing more is sent.
  const before = w.sends.length;
  await w.run('2026-04-02', { keepSlots: true });
  await w.run('2026-04-02', { keepSlots: true });
  assert.equal(w.sends.length, before);
});

test('the resend key is website-grace:<website>:<episode ISO>:<stage>', async () => {
  const w = new World();
  w.add('abc-site', { lastSeen: at('2026-01-01') });
  await w.run('2026-03-02');
  const ep = w.rows.get('abc-site')!.episode!;
  assert.equal(w.sends[0].key, `website-grace:abc-site:${ep.startedAt.toISOString()}:30`);
  assert.equal(warningKey('s', new Date('2026-03-02T06:45:00Z'), 14), 'website-grace:s:2026-03-02T06:45:00.000Z:14');
  assert.equal(offKey('s', new Date('2026-03-02T06:45:00Z')), 'website-grace:s:2026-03-02T06:45:00.000Z:off');
});

test('a login cancels the switch-off: the site stays live and the cron records the cancellation', async () => {
  const w = new World();
  const row = w.add('a', { lastSeen: at('2026-01-01') });
  for (let d = '2026-03-02'; d <= '2026-03-30'; d = addDays(d, 1)) await w.run(d);
  assert.deepEqual(warnsOf(w, 'a'), [30, 14, 3]);
  // The owner logs in on 31 March, the day before the switch-off.
  row.facts = { ...row.facts, lastSeen: at('2026-03-31', '05:00:00') };
  const view = siteGraceView({ ...row, notices: row.notices }, DEFAULT_GRACE, '2026-03-31');
  assert.equal(view.pendingSwitchOff, null, 'the screens show nothing pending at once');
  await w.run('2026-03-31');
  await w.run('2026-04-01');
  await w.run('2026-04-02');
  assert.equal(row.status, 'live');
  assert.equal(row.episode!.switchedOffAt, null);
  assert.ok(row.episode!.cancelledAt);
  assert.deepEqual(w.cancels, ['a']);
  assert.equal(w.blockRenewals.length, 0);
});

test('a used slot waits and writes nothing, except from the day before switch-off, when it is sent anyway', async () => {
  const w = new World();
  w.add('a', { lastSeen: at('2026-01-01') });
  await w.run('2026-03-02'); // 30 sent, switch-off 1 April
  w.usedSlots.add('owner-a');
  const writes = w.writes;
  const claims = w.claims;
  await w.run('2026-03-18', { keepSlots: true }); // stage 14 due but the slot is used
  assert.deepEqual(warnsOf(w, 'a'), [30], 'nothing sent');
  assert.equal(w.writes, writes, 'nothing written');
  assert.equal(w.claims, claims + 1, 'one claim attempt');
  assert.equal(w.rows.get('a')!.notices.length, 1, 'no notice row for the waiting stage');
  // Tomorrow with a free slot it goes.
  await w.run('2026-03-19');
  assert.deepEqual(warnsOf(w, 'a'), [30, 14]);
  // 3 is due from 29 March; the slot is used on 29 and 30: it waits...
  for (const d of ['2026-03-29', '2026-03-30']) {
    w.usedSlots.add('owner-a');
    await w.run(d, { keepSlots: true });
  }
  assert.deepEqual(warnsOf(w, 'a'), [30, 14]);
  // ...and on 31 March, the day before, it goes even though the slot is used.
  w.usedSlots.add('owner-a');
  await w.run('2026-03-31', { keepSlots: true });
  assert.deepEqual(warnsOf(w, 'a'), [30, 14, 3]);
  assert.equal(w.sends.at(-1)!.claimed, true, 'sent while the slot was in use (no claim of its own)');
});

test('a failed send records no notice, so the site is warned again and never switched off unwarned', async () => {
  const w = new World();
  w.add('a', { lastSeen: at('2026-01-01') });
  w.sendFails = true;
  for (let d = '2026-03-02'; d <= '2026-04-10'; d = addDays(d, 1)) await w.run(d);
  assert.equal(w.rows.get('a')!.status, 'live');
  assert.equal(w.rows.get('a')!.notices.length, 0);
  assert.equal(w.blockRenewals.length, 0);
  assert.ok((await w.run('2026-04-11')).body.errors);
  assert.equal(w.rows.get('a')!.status, 'live');
});

test('a missed stage is recorded as skipped and the most imminent due one is sent', async () => {
  const w = new World();
  w.add('a', { lastSeen: at('2026-01-01') });
  await w.run('2026-03-02');
  await w.run('2026-03-30'); // 14 and 3 both due; the cron was away
  assert.deepEqual(warnsOf(w, 'a'), [30, 3]);
  const stages = Object.fromEntries(w.rows.get('a')!.notices.map((n) => [n.stage, n.status]));
  assert.deepEqual(stages, { 30: 'sent', 14: 'skipped', 3: 'sent' });
});

test('a site that is not live (admin-paused) is never processed', async () => {
  const w = new World();
  w.add('paused-1', { siteLive: false, lastSeen: at('2020-01-01') }, { status: 'paused' });
  w.add('preview-1', { siteLive: false, lastSeen: at('2020-01-01') }, { status: 'preview' });
  const res = await w.run('2026-03-02');
  assert.equal(res.body.sites, 2);
  assert.deepEqual({ writes: w.writes, claims: w.claims, sends: w.sends.length }, { writes: 0, claims: 0, sends: 0 });
});

// ── Switch-off ──

test('switch-off flips the status, stamps the dates, blocks the domain renewal and sends the email through the cap', async () => {
  const w = new World();
  const row = w.add('a', { lastSeen: at('2025-12-01') });
  row.episode = { reason: 'abandoned', startedAt: at('2026-01-30'), cancelledAt: null, switchedOffAt: null, deletedAt: null, switchOffOn: null, switchOffBy: null, offEmailedAt: null, deleteOn: null };
  row.notices = [{ stage: 30, status: 'sent', sentAt: at('2026-01-30') }];
  const res = await w.run('2026-03-01');
  assert.equal((res.body.switchedOff as unknown[]).length, 1);
  assert.equal(row.status, 'paused');
  assert.deepEqual(w.blockRenewals, ['a']);
  assert.equal(row.episode!.switchOffBy, 'cron');
  assert.equal(row.episode!.deleteOn, '2026-05-30', 'today + 90 days');
  assert.ok(row.episode!.offEmailedAt);
  assert.equal(w.sends.filter((s) => s.kind === 'off').length, 1);
  assert.equal(w.claims, 1, 'through the cap');
});

test('the switched-off email waits at most a day for the slot', async () => {
  const w = new World();
  const row = w.add('a', { lastSeen: at('2025-12-01') });
  row.episode = { reason: 'abandoned', startedAt: at('2026-01-30'), cancelledAt: null, switchedOffAt: null, deletedAt: null, switchOffOn: null, switchOffBy: null, offEmailedAt: null, deleteOn: null };
  row.notices = [{ stage: 30, status: 'sent', sentAt: at('2026-01-30') }];
  w.usedSlots.add('owner-a');
  await w.run('2026-03-01', { keepSlots: true });
  assert.equal(row.status, 'paused');
  assert.deepEqual(w.blockRenewals, ['a'], 'the domain is stopped whether or not the email could go');
  assert.equal(row.episode!.offEmailedAt, null, 'the slot was used: the email waits');
  assert.equal(w.sends.filter((s) => s.kind === 'off').length, 0);
  // The next day the slot is used again, but it has already waited a day: it goes anyway.
  w.usedSlots.add('owner-a');
  const res = await w.run('2026-03-02', { keepSlots: true });
  assert.equal(w.sends.filter((s) => s.kind === 'off').length, 1);
  assert.ok(row.episode!.offEmailedAt);
  assert.equal((res.body.offEmails as unknown[]).length, 1);
  // And never again.
  await w.run('2026-03-03');
  assert.equal(w.sends.filter((s) => s.kind === 'off').length, 1);
});

test('switchOffWith: a cron switch-off refuses a site that is not live; an admin may switch off any; the dry run touches nothing', async () => {
  const w = new World();
  w.add('p', { siteLive: false }, { status: 'preview' });
  assert.deepEqual(await switchOffWith(w.switchOffDeps(), 'p', { by: 'cron' }), { ok: false, reason: 'not_live' });
  const dry = await switchOffWith(w.switchOffDeps(), 'p', { by: 'admin', dryRun: true, now: at('2026-03-01') });
  assert.deepEqual(dry, { ok: true, changed: true, dryRun: true, plan: { pause: true, blockRenewal: true, email: true, deleteOn: '2026-05-30' } });
  assert.equal(w.writes, 0);
  assert.equal(w.rows.get('p')!.status, 'preview');
  const real = await switchOffWith(w.switchOffDeps(), 'p', { by: 'admin', now: at('2026-03-01') });
  assert.deepEqual(real, { ok: true, changed: true, dryRun: false });
  assert.equal(w.rows.get('p')!.status, 'paused');
  assert.equal(w.rows.get('p')!.episode!.switchOffBy, 'admin');
  assert.deepEqual(w.blockRenewals, ['p']);
  // Already switched off: nothing changes.
  assert.deepEqual(await switchOffWith(w.switchOffDeps(), 'p', { by: 'admin' }), { ok: true, changed: false, dryRun: false });
  assert.deepEqual(await switchOffWith(w.switchOffDeps(), 'nope', { by: 'admin' }), { ok: false, reason: 'not_found' });
});

test('switch-off only flips the status: it names no lead, report, charge or domain table', () => {
  const run = readFileSync(new URL('./grace-run.ts', import.meta.url), 'utf8');
  const start = run.indexOf('// ── Switch off ──');
  const end = run.indexOf('// ── Switch back on ──');
  assert.doesNotMatch(run.slice(start, end), /\b(leads|lead_sources|website_reports|website_report_\w+|funnels|crm|leaddb)\b/);
});

// ── Deletion ──

test('deletion only after 90 days switched off, and only after a switch-off', async () => {
  const w = new World();
  const row = w.add('a', { siteLive: false }, { status: 'paused' });
  row.episode = { reason: 'abandoned', startedAt: at('2026-01-30'), cancelledAt: null, switchedOffAt: at('2026-03-01'), deletedAt: null, switchOffOn: null, switchOffBy: 'cron', offEmailedAt: at('2026-03-01'), deleteOn: '2026-05-30' };
  await w.run('2026-05-29'); // 89 days
  assert.equal(w.deletedSites.length, 0);
  await w.run('2026-05-30'); // 90 days
  assert.deepEqual(w.deletedSites, ['a']);
  assert.equal(w.storageDeletes, 3, 'two files and one screenshot');
  assert.ok(row.episode!.deletedAt);
  // Never twice.
  await w.run('2026-06-30');
  assert.equal(w.deletedSites.length, 1);

  // A site that was never switched off is never deleted, however old.
  const w2 = new World();
  w2.add('live-old', { lastSeen: at('2020-01-01') });
  const live = w2.rows.get('live-old')!;
  live.episode = { reason: 'abandoned', startedAt: at('2020-06-01'), cancelledAt: null, switchedOffAt: null, deletedAt: null, switchOffOn: null, switchOffBy: null, offEmailedAt: null, deleteOn: null };
  await w2.run('2026-08-01');
  assert.equal(w2.deletedSites.length, 0);
  assert.equal(w2.storageDeletes, 0);
});

test('deleteWith refuses a live, unswitched, deleted or missing site; a switched-off site is deleted last-step-last', async () => {
  const w = new World();
  w.add('live', {}, { status: 'live' });
  assert.deepEqual(await deleteWith(w.deleteDeps(), 'live'), { ok: false, reason: 'not_switched_off' });
  const sw = w.add('sw', { siteLive: false }, { status: 'paused' });
  sw.episode = { reason: 'abandoned', startedAt: at('2026-01-30'), cancelledAt: null, switchedOffAt: at('2026-03-01'), deletedAt: null, switchOffOn: null, switchOffBy: 'admin', offEmailedAt: null, deleteOn: null };
  sw.status = 'live'; // somehow live again while the stamps remain: refused
  assert.deepEqual(await deleteWith(w.deleteDeps(), 'sw'), { ok: false, reason: 'live' });
  sw.status = 'paused';
  const dry = await deleteWith(w.deleteDeps(), 'sw', { dryRun: true });
  assert.ok(dry.ok && dry.dryRun);
  assert.deepEqual(dry.ok && dry.plan, { files: 2, screenshots: 1, versions: 3, requests: 1, hasDraft: true });
  assert.ok(dry.ok && dry.keeps.some((k) => /leads/.test(k)), 'the dry run says leads are kept');
  assert.deepEqual({ writes: w.writes, storage: w.storageDeletes }, { writes: 0, storage: 0 });
  const real = await deleteWith(w.deleteDeps(), 'sw', { now: at('2026-06-01') });
  assert.ok(real.ok && !real.dryRun);
  assert.deepEqual(await deleteWith(w.deleteDeps(), 'sw'), { ok: false, reason: 'already_deleted' });
  assert.deepEqual(await deleteWith(w.deleteDeps(), 'missing'), { ok: false, reason: 'not_found' });
});

test('deletion leaves enquiries, lead sources, report records, charges, domain records and funnels alone (pin)', () => {
  const run = readFileSync(new URL('./grace-run.ts', import.meta.url), 'utf8');
  const server = readFileSync(new URL('./grace-server.ts', import.meta.url), 'utf8');
  const forbidden = /\b(leads|lead_sources|website_reports|website_report_\w+|website_domains|website_domain_\w+|funnels|credit_\w+|notification_sends)\b/;
  const runSection = run.slice(run.indexOf('// ── Delete the site\'s data ──'), run.indexOf('// ── Export ──'));
  assert.ok(runSection.length > 200);
  // The comment block above deleteWith names what is kept, in words; the code itself names no such table.
  assert.doesNotMatch(runSection.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'[^']*'/g, ''), forbidden);
  const serverSection = server.slice(server.indexOf('// ── Deletion ──'), server.indexOf('// ── Export ──'));
  assert.ok(serverSection.length > 500, 'the deletion section was found');
  const tables = [...serverSection.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(), ['website_change_requests', 'website_drafts', 'website_grace', 'website_versions', 'websites']);
  assert.doesNotMatch(serverSection.replace(/\/\/.*$/gm, ''), forbidden);
  assert.deepEqual([...serverSection.matchAll(/for \(const table of \[([^\]]*)\]/g)].map((m) => m[1].replace(/\s/g, '')), ["'website_drafts','website_versions','website_change_requests'"]);
});

// ── Export ──

test('the export holds settings, pages, versions, change request texts and file URLs', async () => {
  const deps: ExportDeps = {
    site: async () => ({ slug: 'northern', status: 'paused', settings: { ...SAMPLE_SETTINGS, logoUrl: 'https://x/live.png' }, pages: SAMPLE_COPY }),
    draft: async () => ({ settings: { logoUrl: 'https://x/draft.png', photoUrl: 'https://x/me.jpg' }, pages: {}, baseVersion: 2 }),
    versions: async () => [
      { versionNo: 2, kind: 'publish', restoredFrom: null, publishedAt: '2026-02-02T00:00:00Z', settings: { logoUrl: 'https://x/live.png' }, pages: SAMPLE_COPY },
      { versionNo: 1, kind: 'approved', restoredFrom: null, publishedAt: '2026-01-01T00:00:00Z', settings: { logoUrl: 'https://x/old.png' }, pages: SAMPLE_COPY },
    ],
    requests: async () => [{ id: 'r1', status: 'done', body: BODY_TEXT, adminNotes: 'Done', createdAt: '2026-02-03T00:00:00Z', hasScreenshot: true }],
    now: () => at('2026-03-01'),
  };
  const out = await exportWith(deps, 'w1');
  assert.ok(out);
  assert.equal(out.site.slug, 'northern');
  assert.equal((out.site.settings as { companyName: string }).companyName, 'Northern Lets');
  assert.deepEqual(out.site.pages, SAMPLE_COPY);
  assert.deepEqual(out.versions.map((v) => v.versionNo), [1, 2], 'in version order');
  assert.equal(out.changeRequests[0].body, BODY_TEXT);
  assert.deepEqual(out.files.sort(), ['https://x/draft.png', 'https://x/live.png', 'https://x/me.jpg', 'https://x/old.png']);
  assert.equal(out.exportedAt, '2026-03-01T12:00:00.000Z');
  assert.equal(await exportWith({ ...deps, site: async () => null }, 'w1'), null);
});

// ── Switch back on ──

function switchOnWorld(over: { planOk?: boolean; unpaid?: boolean; fetchOk?: boolean; clearFails?: boolean; deleted?: boolean; off?: boolean } = {}) {
  const calls = { markLive: 0, rollback: 0, clear: 0, reopen: 0, allow: 0, record: [] as string[], fetched: 0 };
  const FORM = '<form><input name="email" type="email"/><input type="checkbox"/></form>';
  const episode: GraceEpisodeRow | null =
    over.off === false
      ? null
      : { reason: 'abandoned', startedAt: at('2026-01-30'), cancelledAt: null, switchedOffAt: at('2026-03-01'), deletedAt: over.deleted ? at('2026-06-01') : null, switchOffOn: null, switchOffBy: 'cron', offEmailedAt: at('2026-03-01'), deleteOn: null };
  const site: SwitchOnSite = { id: 'w1', ownerId: 'o1', slug: SAMPLE_SITE.slug, status: 'paused', settings: SAMPLE_SETTINGS, pages: SAMPLE_COPY, pausedAt: '2026-03-01T00:00:00Z', episode };
  const deps: SwitchOnDeps = {
    load: async () => site,
    planOk: async () => over.planOk ?? true,
    unpaidDomain: async () => over.unpaid ?? false,
    buildPages: (s) => buildSitePages({ site: { slug: s.slug }, settings: s.settings, copy: s.pages! }),
    fetchPage: async () => {
      calls.fetched++;
      return { status: over.fetchOk === false ? 500 : 200, text: async () => `<html><body><main><p>Welcome</p>${FORM}</main></body></html>` };
    },
    baseUrl: 'https://app.example.test',
    markLive: async () => {
      calls.markLive++;
      return true;
    },
    rollbackToPaused: async () => {
      calls.rollback++;
      return true;
    },
    clearEpisode: async () => {
      calls.clear++;
      if (over.clearFails) throw new Error('write failed');
    },
    reopenEpisode: async () => {
      calls.reopen++;
    },
    allowRenewal: async () => {
      calls.allow++;
      return true;
    },
    record: async (_u, kind, o) => {
      calls.record.push(`${kind}:${o.dedupeKey}`);
    },
    now: () => at('2026-04-01'),
  };
  return { deps, calls };
}

test('switching back on: goLive runs, the episode ends, renewal is allowed again, website_switched_on is recorded', async () => {
  const { deps, calls } = switchOnWorld();
  const r = await switchOnWith(deps, 'o1');
  assert.deepEqual(r, { ok: true, renewalRestored: true });
  assert.equal(calls.markLive, 1);
  assert.ok(calls.fetched >= 5, 'every public page was fetched');
  assert.equal(calls.clear, 1);
  assert.equal(calls.allow, 1);
  assert.deepEqual(calls.record, ['website_switched_on:website_switched_on:w1:2026-03-01T12:00:00.000Z'], 'kind, then the dedupe key');
  assert.equal(calls.rollback, 0);
});

test('switching back on needs a switched-off, not-deleted site, a live plan (gate on) and no unpaid domain charge', async () => {
  for (const [over, reason] of [
    [{ off: false }, 'not_switched_off'],
    [{ deleted: true }, 'deleted'],
    [{ planOk: false }, 'plan_required'],
    [{ unpaid: true }, 'unpaid_domain'],
  ] as const) {
    const { deps, calls } = switchOnWorld(over);
    const r = await switchOnWith(deps, 'o1');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, reason);
    assert.ok(!r.ok && r.messages.length > 0 && r.messages.every((m) => !/[<{]/.test(m)));
    assert.equal(calls.markLive, 0, `${reason}: the status never moved`);
  }
});

test('a failed page fetch puts the site back to paused and reopens the episode', async () => {
  const { deps, calls } = switchOnWorld({ fetchOk: false });
  const r = await switchOnWith(deps, 'o1');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'pages');
  assert.equal(calls.rollback, 1);
  assert.equal(calls.reopen, 1);
  assert.equal(calls.allow, 0);
  assert.deepEqual(calls.record, []);
});

test('if the episode cannot be ended the site is put back: a live site never keeps a deletion scheduled', async () => {
  const { deps, calls } = switchOnWorld({ clearFails: true });
  const r = await switchOnWith(deps, 'o1');
  assert.equal(r.ok, false);
  assert.equal(calls.rollback, 1);
  assert.equal(calls.allow, 0);
});

// ── Facts ──

test('graceFactsOf: lapsed plan, a cancellation booked ahead, and an unpaid domain charge', () => {
  const base = { status: 'live', liveAt: at('2025-06-01'), lastSeen: at('2026-02-01'), lastLead: null, unpaidSince: null, gateOn: true, chargeOn: true, now: at('2026-03-01') };
  const lapsed = graceFactsOf({ ...base, profile: { stripe_subscription_status: 'canceled', stripe_subscription_id: 'sub_1' } });
  assert.equal(lapsed.planLapsed, true);
  assert.equal(lapsed.planEndsAt, null);
  const ending = graceFactsOf({ ...base, profile: { stripe_subscription_status: 'active', stripe_subscription_id: 'sub_1', subscription_cancel_at: '2026-04-15T00:00:00Z' } });
  assert.equal(ending.planLapsed, false);
  assert.equal(ending.planEndsAt?.toISOString(), '2026-04-15T00:00:00.000Z');
  const unpaid = graceFactsOf({ ...base, unpaidSince: at('2026-02-20'), profile: { stripe_subscription_status: 'active' } });
  assert.equal(unpaid.unpaidDomain, true);
  assert.equal(graceFactsOf({ ...base, chargeOn: false, unpaidSince: at('2026-02-20'), profile: {} }).unpaidDomain, false, 'charging off: never unpaid');
  assert.equal(graceFactsOf({ ...base, status: 'paused', profile: {} }).siteLive, false);
});

// ── Logs, budget ──

test('no log line and no run result carries an address or a request text', async () => {
  const w = new World();
  w.add('a', { lastSeen: at('2026-01-01') });
  w.add('b', { lastSeen: at('2025-12-01') });
  w.rows.get('b')!.episode = { reason: 'abandoned', startedAt: at('2026-01-30'), cancelledAt: null, switchedOffAt: null, deletedAt: null, switchOffOn: null, switchOffBy: null, offEmailedAt: null, deleteOn: null };
  w.rows.get('b')!.notices = [{ stage: 30, status: 'sent', sentAt: at('2026-01-30') }];
  w.sendFails = false;
  const results = [await w.run('2026-03-01'), await w.run('2026-03-02')];
  w.sendFails = true;
  results.push(await w.run('2026-03-18'));
  assert.ok(w.logs.length > 0);
  for (const line of w.logs) assert.doesNotMatch(line, /@|example\.test|private/i, line);
  for (const r of results) assert.doesNotMatch(JSON.stringify(r.body), /@|example\.test|private/i);
  for (const line of w.logs) assert.match(line, /^\[website-grace\] /);
});

test('no new work starts after the time budget, and the run says so', async () => {
  const w = new World();
  for (let i = 0; i < 5; i++) w.add(`s${i}`, { lastSeen: at('2026-01-01') });
  const deps = w.deps();
  let calls = 0;
  deps.clock = () => (calls++ === 0 ? 0 : TIME_BUDGET_MS + 1);
  const res = await runWebsiteGrace(deps, { dry: false, now: at('2026-03-02', '06:45:00') });
  assert.equal(res.body.ranOutOfTime, true);
  assert.equal(w.sends.length, 0);
});

test('an unreadable schema or settings is a 503, not a crash', async () => {
  const w = new World();
  const deps = w.deps();
  deps.sites = async () => {
    throw new Error('relation "website_grace" does not exist');
  };
  assert.equal((await runWebsiteGrace(deps, { dry: false })).status, 503);
  deps.settings = async () => {
    throw new Error('boom');
  };
  assert.equal((await runWebsiteGrace(deps, { dry: true })).status, 503);
});

test('one site failing does not stop the others', async () => {
  const w = new World();
  w.add('bad', { lastSeen: at('2026-01-01') });
  w.add('good', { lastSeen: at('2026-01-01') });
  const deps = w.deps();
  const real = deps.startEpisode;
  deps.startEpisode = async (id, ...rest) => {
    if (id === 'bad') throw new Error('write failed');
    return real(id, ...rest);
  };
  const res = await runWebsiteGrace(deps, { dry: false, now: at('2026-03-02', '06:45:00') });
  assert.equal((res.body.errors as string[]).length, 1);
  assert.deepEqual(warnsOf(w, 'good'), [30]);
  assert.deepEqual(warnsOf(w, 'bad'), []);
});

// ── Batch 37: a transferred site is the operator's, not ours to warn, switch off or delete ──

test('a site that was handed over to its operator gets no warning, switch-off or deletion', async () => {
  const w = new World();
  w.add('moved', { lastSeen: at('2026-01-01') });
  w.add('kept', { lastSeen: at('2026-01-01') });
  // The loader (pinned below) leaves a site with an open transfer out of the candidates.
  const transferred = new Set(['moved']);
  const deps = w.deps();
  const all = deps.sites;
  deps.sites = async (now) => (await all(now)).filter((s) => !transferred.has(s.websiteId));
  await runWebsiteGrace(deps, { dry: false, now: at('2026-03-02', '06:45:00') });
  assert.deepEqual(warnsOf(w, 'moved'), []);
  assert.deepEqual(warnsOf(w, 'kept'), [30]);
  assert.equal(w.rows.get('moved')?.episode, null);
  assert.equal(w.deletedSites.length, 0);
});

test('the cron loader skips every website with a transfer row that is not cancelled, and fails closed', () => {
  const server = readFileSync(new URL('./grace-server.ts', import.meta.url), 'utf8');
  const start = server.indexOf('async function loadSites(');
  const loader = server.slice(start, server.indexOf('\n}\n', start));
  assert.match(loader, /from\('website_transfers'\)\.select\('website_id'\)\.is\('cancelled_at', null\)/);
  assert.match(loader, /if \(moved\.error\) throw new Error/);
  assert.match(loader, /\.filter\(\(id\) => !transferred\.has\(id\)\)/);
  // Only the cron's own candidate list is filtered: a screen asking for one site by id is unchanged.
  assert.ok(loader.indexOf('if (websiteIds)') < loader.indexOf("from('website_transfers')"));
});
