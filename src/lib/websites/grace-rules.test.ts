import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  capDecision,
  daysBetween,
  deleteOnFor,
  episodeDue,
  firstWarningDay,
  graceState,
  lastActivity,
  pendingSwitchOff,
  ukDayOf,
  type GraceEpisode,
  type GraceFacts,
  type GraceNotice,
  type GraceState,
} from './grace-rules.ts';
import { DEFAULT_GRACE, type GraceSettings } from './grace-settings.ts';

const at = (day: string, time = '12:00:00') => new Date(`${day}T${time}Z`);

const LIVE: GraceFacts = {
  siteLive: true,
  liveAt: at('2025-06-01'),
  lastSeen: null,
  lastLead: null,
  planLapsed: false,
  planEndsAt: null,
  unpaidDomain: false,
  unpaidSince: null,
  gateOn: false,
  chargeOn: false,
};

/** A site and its episode, stepped one UK day at a time exactly as the cron applies each answer. */
class Site {
  facts: GraceFacts;
  episode: GraceEpisode | null = null;
  notices: GraceNotice[] = [];
  sends: { day: string; stage: number }[] = [];
  skippedStages: number[] = [];
  switchedOffOn: string | null = null;
  settings: GraceSettings;
  constructor(facts: Partial<GraceFacts>, settings: GraceSettings = DEFAULT_GRACE) {
    this.facts = { ...LIVE, ...facts };
    this.settings = settings;
  }
  state(today: string): GraceState {
    return graceState(this.facts, this.episode, this.notices, this.settings, today);
  }
  /** One cron run on `today` (slot free). Returns the state it acted on. */
  step(today: string): GraceState {
    let s = this.state(today);
    if (s.kind === 'cancel' && this.episode) {
      this.episode = { ...this.episode, cancelledAt: at(today) };
      return s;
    }
    if (s.kind === 'start') {
      this.episode = { reason: s.reason, startedAt: at(today, '06:45:00'), cancelledAt: null, switchedOffAt: null, deletedAt: null };
      this.notices = [];
      s = this.state(today);
    }
    if (s.kind === 'warn') {
      for (const d of s.skipped) {
        this.notices.push({ stage: d, status: 'skipped', sentAt: at(today) });
        this.skippedStages.push(d);
      }
      this.notices.push({ stage: s.stage, status: 'sent', sentAt: at(today, '06:46:00') });
      this.sends.push({ day: today, stage: s.stage });
    } else if (s.kind === 'switch_off' && this.episode) {
      this.episode = { ...this.episode, switchedOffAt: at(today, '06:47:00') };
      this.facts = { ...this.facts, siteLive: false };
      this.switchedOffOn = today;
    }
    return s;
  }
  runDays(from: string, to: string): void {
    for (let d = from; d <= to; d = addDays(d, 1)) this.step(d);
  }
}

test('date helpers: UK day, adding and counting days', () => {
  assert.equal(ukDayOf(new Date('2026-06-30T23:30:00Z')), '2026-07-01', 'BST: 23:30 UTC is already tomorrow in London');
  assert.equal(ukDayOf(new Date('2026-11-20T23:30:00Z')), '2026-11-20');
  assert.equal(addDays('2026-02-27', 3), '2026-03-02');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-01-01', '2026-03-01'), 59);
  assert.equal(daysBetween('2026-03-01', '2026-01-01'), -59);
});

test('abandoned: warnings go at 30, 14 and 3 days before switch-off, each once, then the switch-off', () => {
  const site = new Site({ lastSeen: at('2026-01-01') });
  site.runDays('2026-01-02', '2026-04-30');
  // Last activity 1 Jan + 90 days = 1 Apr: warnings on 2 Mar, 18 Mar and 29 Mar.
  assert.deepEqual(site.sends, [
    { day: '2026-03-02', stage: 30 },
    { day: '2026-03-18', stage: 14 },
    { day: '2026-03-29', stage: 3 },
  ]);
  assert.equal(site.switchedOffOn, '2026-04-01');
  assert.deepEqual(site.skippedStages, []);
  // A second run on the same day sends nothing more.
  const again = site.state('2026-03-29');
  assert.notEqual(again.kind, 'warn');
});

test('running the same day twice sends the warning once', () => {
  const site = new Site({ lastSeen: at('2026-01-01') });
  site.runDays('2026-03-01', '2026-03-02');
  const before = site.sends.length;
  site.step('2026-03-02');
  site.step('2026-03-02');
  assert.equal(site.sends.length, before);
  assert.equal(before, 1);
});

test('a login after the episode started cancels an abandoned episode, and so does a lead', () => {
  for (const key of ['lastSeen', 'lastLead'] as const) {
    const site = new Site({ lastSeen: at('2026-01-01') });
    site.runDays('2026-03-01', '2026-03-05');
    assert.equal(site.sends.length, 1);
    site.facts = { ...site.facts, [key]: at('2026-03-06', '09:00:00') };
    const s = site.state('2026-03-06');
    assert.deepEqual(s, { kind: 'cancel', reason: 'abandoned' }, key);
    site.step('2026-03-06');
    assert.ok(site.episode?.cancelledAt, 'the cron records it');
    assert.equal(pendingSwitchOff(site.state('2026-03-06')), null, 'nothing pending now');
    // Quiet again for 60 days from the new activity: a fresh episode, not the old one.
    assert.equal(site.state('2026-03-07').kind, 'none');
  }
});

test('a login that happened BEFORE the episode started does not cancel it', () => {
  const site = new Site({ lastSeen: at('2026-01-01') });
  site.runDays('2026-03-02', '2026-03-03');
  assert.equal(site.state('2026-03-04').kind, 'wait');
});

test('a login does not cancel a cancelled-plan episode; a live plan does', () => {
  const site = new Site({ gateOn: true, planLapsed: true, lastSeen: at('2026-01-01') });
  site.step('2026-03-01');
  assert.equal(site.episode?.reason, 'cancelled');
  site.facts = { ...site.facts, lastSeen: at('2026-03-02', '10:00:00') };
  assert.notEqual(site.state('2026-03-02').kind, 'cancel', 'a login is not a paid plan');
  site.facts = { ...site.facts, planLapsed: false };
  assert.deepEqual(site.state('2026-03-02'), { kind: 'cancel', reason: 'cancelled' });
});

test('cancelled episodes only exist while the plan gate is on', () => {
  const lapsed = { planLapsed: true, lastSeen: at('2026-02-25') };
  assert.equal(new Site({ ...lapsed, gateOn: false }).state('2026-03-01').kind, 'none');
  assert.equal(new Site({ ...lapsed, gateOn: true }).state('2026-03-01').kind, 'start');
  // Turning the gate off mid-episode cancels it.
  const site = new Site({ ...lapsed, gateOn: true });
  site.step('2026-03-01');
  site.facts = { ...site.facts, gateOn: false };
  assert.deepEqual(site.state('2026-03-02'), { kind: 'cancel', reason: 'cancelled' });
});

test('cancelled: switched off on the plan end date when it is known 30+ days ahead', () => {
  const site = new Site({ gateOn: true, planEndsAt: at('2026-04-15'), lastSeen: at('2026-03-01') });
  site.runDays('2026-03-01', '2026-04-20');
  // Warnings begin 30 days before the end: 16 March, then 14 and 3 days out.
  assert.deepEqual(site.sends, [
    { day: '2026-03-16', stage: 30 },
    { day: '2026-04-01', stage: 14 },
    { day: '2026-04-12', stage: 3 },
  ]);
  assert.equal(site.switchedOffOn, '2026-04-15');
});

test('cancelled: a plan that has already ended is switched off 30 days after the first warning', () => {
  const site = new Site({ gateOn: true, planLapsed: true, planEndsAt: at('2026-02-01'), lastSeen: at('2026-02-20') });
  site.runDays('2026-03-01', '2026-04-10');
  assert.deepEqual(site.sends[0], { day: '2026-03-01', stage: 30 });
  assert.equal(site.switchedOffOn, '2026-03-31');
  // The end date was 28 days before the first warning; a plan that ends in 10 days gets 30 days' notice too.
  const soon = new Site({ gateOn: true, planEndsAt: at('2026-03-11'), lastSeen: at('2026-02-20') });
  soon.runDays('2026-03-01', '2026-04-20');
  assert.equal(soon.switchedOffOn, '2026-03-31', 'never earlier than the first warning + 30 days');
});

test('unpaid: only paying cancels it, and charging must be on', () => {
  const base = { chargeOn: true, unpaidDomain: true, unpaidSince: at('2026-02-01'), lastSeen: at('2026-02-25') };
  const site = new Site(base);
  site.step('2026-03-01');
  assert.equal(site.episode?.reason, 'unpaid');
  site.facts = { ...site.facts, lastSeen: at('2026-03-02', '10:00:00') };
  assert.notEqual(site.state('2026-03-02').kind, 'cancel', 'a login does not pay');
  site.facts = { ...site.facts, unpaidDomain: false };
  assert.deepEqual(site.state('2026-03-02'), { kind: 'cancel', reason: 'unpaid' });
  assert.equal(new Site({ ...base, chargeOn: false }).state('2026-03-01').kind, 'none');
});

test('a site already at day 100 still gets its full 30-day notice', () => {
  const site = new Site({ lastSeen: at('2025-11-21') });
  const today = '2026-03-01'; // 100 days after 21 November
  assert.equal(daysBetween('2025-11-21', today), 100);
  site.runDays(today, '2026-04-30');
  assert.deepEqual(site.sends[0], { day: today, stage: 30 });
  assert.equal(site.switchedOffOn, '2026-03-31', 'first warning + 30 days, not day 90');
  assert.deepEqual(site.sends.map((s) => s.stage), [30, 14, 3]);
});

test('nothing is switched off without a warning that was actually sent', () => {
  const site = new Site({ lastSeen: at('2025-01-01') });
  site.episode = { reason: 'abandoned', startedAt: at('2026-03-01'), cancelledAt: null, switchedOffAt: null, deletedAt: null };
  // Long past the base date, no notice at all: a warning, never a switch-off.
  const s = site.state('2026-03-05');
  assert.equal(s.kind, 'warn');
  // Skipped notices are not warnings either.
  site.notices = [{ stage: 30, status: 'skipped', sentAt: at('2026-03-05') }];
  assert.notEqual(site.state('2026-03-06').kind, 'switch_off');
  assert.notEqual(site.state('2027-03-06').kind, 'switch_off');
});

test('a missed stage is recorded as skipped and the most imminent due stage is the one sent', () => {
  const site = new Site({ lastSeen: at('2026-01-01') });
  site.runDays('2026-03-02', '2026-03-03'); // 30 sent on 2 March, switch-off 1 April
  // The cron is down until 30 March: 14 and 3 are both due; 3 is sent, 14 skipped.
  site.step('2026-03-30');
  assert.deepEqual(site.sends.map((s) => s.stage), [30, 3]);
  assert.deepEqual(site.skippedStages, [14]);
  assert.equal(site.state('2026-03-31').kind, 'wait');
  assert.equal(site.state('2026-04-01').kind, 'switch_off');
});

test('a plan about to end still gets the full notice: the first warning is the 30-day one and the switch-off moves out', () => {
  const site = new Site({ gateOn: true, planEndsAt: at('2026-04-01'), lastSeen: at('2026-03-01') });
  // The plan ends 1 April but the cron first runs on 20 March, 12 days out. Switch-off is first warning + 30 days.
  site.step('2026-03-20');
  assert.deepEqual(site.sends, [{ day: '2026-03-20', stage: 30 }]);
  assert.deepEqual(site.skippedStages, []);
  const s = site.state('2026-03-21');
  assert.equal(s.kind, 'wait');
  assert.equal(s.kind === 'wait' && s.switchOffOn, '2026-04-19');
});

test('switch-off date is never earlier than the first warning + the largest warning day', () => {
  const settings: GraceSettings = { ...DEFAULT_GRACE, warningDays: [10, 2] };
  const site = new Site({ lastSeen: at('2025-12-01') }, settings);
  site.runDays('2026-02-01', '2026-03-20');
  assert.equal(site.sends[0].day, '2026-02-19', '1 Dec + 90 = 1 Mar, minus 10 days');
  assert.equal(site.switchedOffOn, '2026-03-01');
});

test('a used slot waits, except from the day before switch-off', () => {
  assert.equal(capDecision(false, '2026-03-02', '2026-04-01'), 'send');
  assert.equal(capDecision(true, '2026-03-02', '2026-04-01'), 'wait');
  assert.equal(capDecision(true, '2026-03-30', '2026-04-01'), 'wait', 'two days out still waits');
  assert.equal(capDecision(true, '2026-03-31', '2026-04-01'), 'send', 'the day before');
  assert.equal(capDecision(true, '2026-04-01', '2026-04-01'), 'send');
  assert.equal(capDecision(true, '2026-04-05', '2026-04-01'), 'send');
});

test('a wait moves the first warning to a later day and the switch-off moves with it', () => {
  const site = new Site({ gateOn: true, planLapsed: true, lastSeen: at('2026-02-25') });
  site.state('2026-03-01'); // would start; the slot was used so nothing was written
  const s1 = site.state('2026-03-01');
  assert.equal(s1.kind === 'start' && s1.switchOffOn, '2026-03-31');
  site.step('2026-03-03');
  const s = site.state('2026-03-04');
  assert.equal(s.kind === 'wait' && s.switchOffOn, '2026-04-02');
});

test('a site that is not live is never processed (admin-paused, preview, setup)', () => {
  assert.equal(new Site({ siteLive: false, lastSeen: at('2020-01-01') }).state('2026-03-01').kind, 'none');
  // Admin pauses mid-episode: the episode waits, untouched.
  const site = new Site({ lastSeen: at('2026-01-01') });
  site.runDays('2026-03-02', '2026-03-03');
  site.facts = { ...site.facts, siteLive: false };
  assert.equal(site.state('2026-04-10').kind, 'none');
  assert.equal(episodeDue({ ...LIVE, siteLive: false, lastSeen: at('2020-01-01') }, '2026-03-01', DEFAULT_GRACE), null);
});

test('a site nobody has logged in to since it went live counts from the day it went live', () => {
  assert.deepEqual(lastActivity({ lastSeen: null, lastLead: null, liveAt: at('2026-01-05') }), at('2026-01-05'));
  assert.equal(lastActivity({ lastSeen: null, lastLead: null, liveAt: null }), null);
  assert.deepEqual(lastActivity({ lastSeen: at('2026-02-01'), lastLead: at('2026-03-01'), liveAt: at('2026-01-05') }), at('2026-03-01'));
  assert.equal(new Site({ liveAt: null, lastSeen: null }).state('2026-03-01').kind, 'none', 'no date at all: not abandoned');
  assert.equal(new Site({ liveAt: at('2026-01-05'), lastSeen: null }).state('2026-03-07').kind, 'start');
});

test('deletion only after 90 days switched off, never for a switched-back-on or already deleted site', () => {
  const site = new Site({ lastSeen: at('2025-12-01') });
  site.runDays('2026-01-15', '2026-03-05');
  assert.equal(site.switchedOffOn, '2026-03-01');
  assert.equal(site.state('2026-03-02').kind, 'none');
  const off = '2026-03-01';
  assert.equal(deleteOnFor(site.episode!.switchedOffAt!, DEFAULT_GRACE), addDays(off, 90));
  assert.equal(site.state(addDays(off, 89)).kind, 'none');
  assert.deepEqual(site.state(addDays(off, 90)), { kind: 'delete_due', deleteOn: '2026-05-30' });
  assert.equal(site.state(addDays(off, 400)).kind, 'delete_due');
  // The setting is read now: 3650 pauses every deletion.
  assert.equal(graceState(site.facts, site.episode, site.notices, { ...DEFAULT_GRACE, deleteAfterDays: 3650 }, addDays(off, 400)).kind, 'none');
  // Switched back on: the episode is cancelled, nothing is due.
  const back = { ...site.episode!, cancelledAt: at('2026-04-01') };
  assert.equal(graceState({ ...site.facts, siteLive: true, lastSeen: at('2026-04-01') }, back, site.notices, DEFAULT_GRACE, '2026-04-02').kind, 'none');
  // Deleted: never again.
  const gone = { ...site.episode!, deletedAt: at('2026-06-01') };
  assert.equal(graceState(site.facts, gone, site.notices, DEFAULT_GRACE, addDays(off, 500)).kind, 'none');
});

test('a switched-off site is not "live", yet is still checked for deletion', () => {
  const site = new Site({ lastSeen: at('2025-12-01') });
  site.runDays('2026-01-15', '2026-03-02');
  assert.equal(site.facts.siteLive, false);
  assert.equal(site.state('2026-05-30').kind, 'delete_due');
});

test('the operator sees a switch-off date only once a warning has gone out, and not after it is cancelled', () => {
  const site = new Site({ lastSeen: at('2026-01-01') });
  assert.equal(pendingSwitchOff(site.state('2026-03-02')), null, 'a start is not a warning');
  site.step('2026-03-02');
  assert.equal(pendingSwitchOff(site.state('2026-03-03')), '2026-04-01');
  site.facts = { ...site.facts, lastSeen: at('2026-03-04', '10:00:00') };
  assert.equal(pendingSwitchOff(site.state('2026-03-04')), null, 'a login cancels it on screen at once, before the cron records it');
});

test('firstWarningDay ignores skipped stages and takes the earliest sent', () => {
  assert.equal(firstWarningDay([]), null);
  assert.equal(firstWarningDay([{ stage: 30, status: 'skipped', sentAt: at('2026-03-01') }]), null);
  assert.equal(
    firstWarningDay([
      { stage: 3, status: 'sent', sentAt: at('2026-03-29') },
      { stage: 30, status: 'sent', sentAt: at('2026-03-02') },
    ]),
    '2026-03-02',
  );
});

test('a new episode after a cancelled one starts clean', () => {
  const site = new Site({ lastSeen: at('2026-01-01') });
  site.runDays('2026-03-02', '2026-03-05');
  site.facts = { ...site.facts, lastSeen: at('2026-03-06', '10:00:00') };
  site.step('2026-03-06');
  assert.ok(site.episode?.cancelledAt);
  // Quiet for 60 days after the login: due again, a fresh warning.
  site.facts = { ...site.facts };
  site.runDays('2026-03-07', '2026-05-10');
  assert.equal(site.episode?.cancelledAt, null);
  assert.equal(site.sends.at(-1)?.stage, 30);
  assert.equal(site.sends.at(-1)?.day, '2026-05-05', '6 March + 60 days');
});
