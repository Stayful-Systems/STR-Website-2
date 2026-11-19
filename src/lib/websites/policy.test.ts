import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import {
  MAX_REPORT_ATTEMPTS, canTransition, chargeDecision, claimOutcome, decideStep2, freezeMode, isExpirable, isSelfSubmit, isTerminalState,
  landlordOutcome, nextDay, nextState, qualityOk, selfSubmitReasons, staleLeaseAction, websiteAccess,
  type AccessFacts, type ReportEvent,
} from './policy.ts';
import { DEFAULT_WEBSITE, parseWebsite } from './settings.ts';
import { REPORT_STATES, type FrozenBilling, type ReportState } from './types.ts';

const ON = { reportChargeOn: true, reportPence: 300 };
const OFF = { reportChargeOn: false, reportPence: 300 };

// ── access ──

const full: AccessFacts = { isManagement: true, isOwner: true, invited: true, paid: false };

test('access: management + owner + invited, no plan needed while the gate is off', () => {
  assert.deepEqual(websiteAccess(full, false), { allowed: true });
  assert.deepEqual(websiteAccess({ ...full, isManagement: false }, false), { allowed: false, reason: 'not_management' });
  assert.deepEqual(websiteAccess({ ...full, isOwner: false }, false), { allowed: false, reason: 'not_owner' });
  assert.deepEqual(websiteAccess({ ...full, invited: false }, false), { allowed: false, reason: 'not_invited' });
});

test('access: invite-only; the invite itself is for someone not yet invited', () => {
  assert.deepEqual(websiteAccess({ ...full, invited: false }, false, 'invite'), { allowed: true });
  assert.deepEqual(websiteAccess({ ...full, invited: false, isManagement: false }, false, 'invite'), { allowed: false, reason: 'not_management' });
  assert.deepEqual(websiteAccess({ ...full, invited: false, isOwner: false }, false, 'invite'), { allowed: false, reason: 'not_owner' });
});

test('access: a paid plan is required only while the plan gate is on', () => {
  assert.deepEqual(websiteAccess({ ...full, paid: false }, true), { allowed: false, reason: 'plan_required' });
  assert.deepEqual(websiteAccess({ ...full, paid: false }, true, 'invite'), { allowed: false, reason: 'plan_required' });
  assert.deepEqual(websiteAccess({ ...full, paid: true }, true), { allowed: true });
  assert.deepEqual(websiteAccess({ ...full, paid: false }, false), { allowed: true });
});

test('access: the gate blocks invite and going live, not a site that is already live', () => {
  assert.deepEqual(websiteAccess({ ...full, paid: false }, true, 'keep_live'), { allowed: true });
  assert.deepEqual(websiteAccess({ ...full, paid: false, invited: false }, true, 'keep_live'), { allowed: false, reason: 'not_invited' });
});

// ── mode freeze ──

test('freezeMode reads the settings once, then keeps what the report holds', () => {
  assert.deepEqual(freezeMode(OFF), { billingMode: 'free', pricePence: 0 });
  assert.deepEqual(freezeMode(ON), { billingMode: 'charged', pricePence: 300 });
  const frozenFree = freezeMode(OFF);
  assert.deepEqual(freezeMode(ON, frozenFree), { billingMode: 'free', pricePence: 0 }, 'switched ON after step 2: still free');
  const frozenCharged = freezeMode({ reportChargeOn: true, reportPence: 300 });
  assert.deepEqual(freezeMode({ reportChargeOn: false, reportPence: 500 }, frozenCharged), { billingMode: 'charged', pricePence: 300 }, 'switched OFF, price changed: still charged at 300');
});

test('the mode and price are frozen across a settings flip, through the whole decision chain', () => {
  const before = decideStep2({ frozen: null, settings: ON, selfSubmit: false, balancePence: 1000 });
  assert.equal(before.kind, 'run');
  // The cron retries the same report after the admin switched charging OFF and changed the price.
  const retry = decideStep2({ frozen: before.frozen, settings: { reportChargeOn: false, reportPence: 999 }, selfSubmit: false, balancePence: 1000 });
  assert.deepEqual(retry.frozen, before.frozen);
  assert.equal(retry.kind, 'run');
  assert.deepEqual(chargeDecision({ ...retry.frozen, quality: true, hasFigures: true }), { charge: true, pence: 300 });
  // And the other way: frozen free, charging switched ON.
  const free = decideStep2({ frozen: null, settings: OFF, selfSubmit: false, balancePence: null });
  const later = decideStep2({ frozen: free.frozen, settings: ON, selfSubmit: false, balancePence: 0 });
  assert.equal(later.kind, 'claim');
  assert.deepEqual(chargeDecision({ ...later.frozen, quality: true, hasFigures: true }), { charge: false, reason: 'free_mode' });
});

// ── self-submit ──

test('isSelfSubmit: owner profile email or phone, site contact email or phone, signed-in owner or team', () => {
  const base = { ownerEmail: 'Owner@Acme.co.uk', ownerPhone: '07700 900123', siteEmail: 'hello@acme.co.uk', sitePhone: '+44 7700 900456', ownerUserId: 'u1', teamUserIds: ['t1', 't2'] };
  assert.deepEqual(selfSubmitReasons({ ...base, leadEmail: ' owner@acme.co.uk ' }), ['owner_email']);
  assert.deepEqual(selfSubmitReasons({ ...base, leadPhone: '+447700900123' }), ['owner_phone']);
  assert.deepEqual(selfSubmitReasons({ ...base, leadEmail: 'HELLO@acme.co.uk' }), ['site_email']);
  assert.deepEqual(selfSubmitReasons({ ...base, leadPhone: '07700900456' }), ['site_phone']);
  assert.deepEqual(selfSubmitReasons({ ...base, sessionUserId: 'u1' }), ['session']);
  assert.deepEqual(selfSubmitReasons({ ...base, sessionUserId: 't2' }), ['session']);
  assert.equal(isSelfSubmit({ ...base, leadEmail: 'landlord@example.com', leadPhone: '07700900999', sessionUserId: 'stranger' }), false);
  assert.equal(isSelfSubmit({ ...base, leadEmail: 'landlord@example.com' }), false);
});

test('isSelfSubmit: missing values never match each other', () => {
  assert.equal(isSelfSubmit({ leadEmail: '', ownerEmail: '', siteEmail: null }), false);
  assert.equal(isSelfSubmit({ leadPhone: null, ownerPhone: null, sitePhone: undefined }), false);
  assert.equal(isSelfSubmit({ sessionUserId: null, ownerUserId: null }), false);
  assert.equal(isSelfSubmit({ sessionUserId: 'x', teamUserIds: [] }), false);
});

// ── step 2 ──

test('step 2, free mode: a normal lead claims a slot', () => {
  const d = decideStep2({ frozen: null, settings: OFF, selfSubmit: false, balancePence: null });
  assert.deepEqual(d, { kind: 'claim', frozen: { billingMode: 'free', pricePence: 0 } });
});

test('step 2, free mode: a self-submit is held_self and NO run, whatever the balance', () => {
  const d = decideStep2({ frozen: null, settings: OFF, selfSubmit: true, balancePence: 100000 });
  assert.equal(d.kind, 'hold');
  assert.equal(d.kind === 'hold' && d.state, 'held_self');
});

test('step 2, charge on: a self-submit runs and is charged', () => {
  const d = decideStep2({ frozen: null, settings: ON, selfSubmit: true, balancePence: 300 });
  assert.equal(d.kind, 'run');
  assert.equal(d.kind === 'run' && d.charge, true);
  assert.equal(chargeDecision({ ...d.frozen, quality: true, hasFigures: true }).charge, true);
});

test('step 2, charged mode: the balance is checked against the frozen price', () => {
  assert.equal(decideStep2({ frozen: null, settings: ON, selfSubmit: false, balancePence: 300 }).kind, 'run');
  assert.equal(decideStep2({ frozen: null, settings: ON, selfSubmit: false, balancePence: 299 }).kind, 'hold');
  const short = decideStep2({ frozen: null, settings: ON, selfSubmit: false, balancePence: 299 });
  assert.equal(short.kind === 'hold' && short.state, 'held_credit');
  const unknown = decideStep2({ frozen: null, settings: ON, selfSubmit: false, balancePence: null });
  assert.equal(unknown.kind === 'hold' && unknown.state, 'held_credit', 'an unknown balance is short');
});

test('claimOutcome: claimed and already run; either full answer holds for the next UK day', () => {
  assert.deepEqual(claimOutcome('claimed'), { kind: 'run' });
  assert.deepEqual(claimOutcome('already'), { kind: 'run' });
  assert.deepEqual(claimOutcome('site_full'), { kind: 'hold', state: 'held_cap' });
  assert.deepEqual(claimOutcome('day_full'), { kind: 'hold', state: 'held_cap' });
});

test('nextDay rolls over months and years', () => {
  assert.equal(nextDay('2026-11-19'), '2026-11-20');
  assert.equal(nextDay('2026-11-30'), '2026-12-01');
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
  assert.equal(nextDay('2028-02-28'), '2028-02-29');
  assert.throws(() => nextDay('19/11/2026'));
});

// ── quality and charging ──

test('qualityOk needs a complete AND trustworthy report', () => {
  assert.equal(qualityOk({ complete: true, trustworthy: true }), true);
  assert.equal(qualityOk({ complete: true, trustworthy: false }), false);
  assert.equal(qualityOk({ complete: false, trustworthy: true }), false);
});

test('charge OFF (free mode): no charge decision, whatever the quality', () => {
  for (const quality of [true, false, null]) {
    assert.deepEqual(chargeDecision({ billingMode: 'free', pricePence: 0, quality, hasFigures: true }), { charge: false, reason: 'free_mode' });
  }
});

test('charge ON + quality false: no charge; failed report: no charge', () => {
  assert.deepEqual(chargeDecision({ billingMode: 'charged', pricePence: 300, quality: false, hasFigures: true }), { charge: false, reason: 'low_quality' });
  assert.deepEqual(chargeDecision({ billingMode: 'charged', pricePence: 300, quality: null, hasFigures: true }), { charge: false, reason: 'low_quality' });
  assert.deepEqual(chargeDecision({ billingMode: 'charged', pricePence: 300, quality: true, hasFigures: false }), { charge: false, reason: 'no_figures' });
  assert.deepEqual(chargeDecision({ billingMode: 'charged', pricePence: 300, quality: true, hasFigures: true }), { charge: true, pence: 300 });
  assert.equal(chargeDecision({ billingMode: 'charged', pricePence: 0, quality: true, hasFigures: true }).charge, false, 'never a zero or negative charge');
});

test('the settings default is free, so nothing is charged out of the box', () => {
  const s = parseWebsite(() => undefined);
  assert.deepEqual(s, DEFAULT_WEBSITE);
  assert.equal(decideStep2({ frozen: null, settings: s, selfSubmit: false, balancePence: 0 }).kind, 'claim');
});

// ── landlord outcome ──

test('landlordOutcome: summary, summary_caveat, held, will_contact', () => {
  assert.equal(landlordOutcome({ state: 'done', quality: true, hasFigures: true }), 'summary');
  assert.equal(landlordOutcome({ state: 'done', quality: false, hasFigures: true }), 'summary_caveat');
  assert.equal(landlordOutcome({ state: 'done', quality: null, hasFigures: true }), 'summary_caveat');
  assert.equal(landlordOutcome({ state: 'held_cap', quality: null, hasFigures: false }), 'held');
  assert.equal(landlordOutcome({ state: 'held_self', quality: null, hasFigures: false }), 'will_contact');
  assert.equal(landlordOutcome({ state: 'failed', quality: null, hasFigures: false }), 'will_contact');
  assert.equal(landlordOutcome({ state: 'done', quality: true, hasFigures: false }), 'will_contact', 'no figures is never a summary');
  for (const state of ['awaiting_address', 'held_credit', 'running', 'expired'] as const) {
    assert.equal(landlordOutcome({ state, quality: true, hasFigures: true }), 'will_contact', state);
  }
});

// ── state machine ──

test('the happy paths', () => {
  assert.equal(nextState('awaiting_address', 'run_started'), 'running');
  assert.equal(nextState('running', 'completed'), 'done');
  assert.equal(nextState('running', 'failed'), 'failed');
  assert.equal(nextState('awaiting_address', 'hold_cap'), 'held_cap');
  assert.equal(nextState('awaiting_address', 'hold_credit'), 'held_credit');
  assert.equal(nextState('awaiting_address', 'hold_self'), 'held_self');
  assert.equal(nextState('held_cap', 'run_started'), 'running');
  assert.equal(nextState('held_credit', 'run_started'), 'running');
  assert.equal(nextState('running', 'lease_retaken'), 'running');
});

test('a held_self report never runs', () => {
  assert.equal(nextState('held_self', 'run_started'), null);
  assert.equal(canTransition('held_self', 'running'), false);
  assert.equal(nextState('held_self', 'expired'), 'expired');
});

test('done, failed and expired are final', () => {
  for (const s of ['done', 'failed', 'expired'] as const) {
    assert.equal(isTerminalState(s), true, s);
    for (const to of REPORT_STATES) assert.equal(canTransition(s, to), false, `${s} -> ${to}`);
  }
});

test('a report cannot jump: no run without an address, no done without running', () => {
  assert.equal(canTransition('awaiting_address', 'done'), false);
  assert.equal(canTransition('awaiting_address', 'failed'), false);
  assert.equal(canTransition('held_cap', 'done'), false);
  assert.equal(canTransition('running', 'held_cap'), false);
  assert.equal(canTransition('running', 'expired'), false);
  assert.equal(nextState('done', 'run_started'), null);
});

test('every transition lands on a state the database allows', () => {
  const events: ReportEvent[] = ['run_started', 'lease_retaken', 'hold_cap', 'hold_credit', 'hold_self', 'completed', 'failed', 'expired'];
  for (const from of REPORT_STATES) for (const e of events) {
    const to = nextState(from, e);
    if (to !== null) assert.ok((REPORT_STATES as readonly string[]).includes(to), `${from} --${e}--> ${to}`);
  }
});

test('only states the expiry index covers can expire', () => {
  const expirable = REPORT_STATES.filter((s: ReportState) => isExpirable(s));
  assert.deepEqual([...expirable].sort(), ['awaiting_address', 'held_cap', 'held_credit', 'held_self']);
});

test('a stale lease is retried until the third attempt, then fails', () => {
  assert.equal(MAX_REPORT_ATTEMPTS, 3);
  assert.equal(staleLeaseAction(1), 'retry');
  assert.equal(staleLeaseAction(2), 'retry');
  assert.equal(staleLeaseAction(3), 'fail');
  assert.equal(staleLeaseAction(4), 'fail');
});

test('FrozenBilling stays plain data', () => {
  const f: FrozenBilling = freezeMode(ON);
  assert.deepEqual(JSON.parse(JSON.stringify(f)), f);
});

// ── pins ──

/** Source files (not tests) under a directory; [] when it does not exist yet. */
function sources(dir: URL): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const child = new URL(name, dir);
    if (statSync(child).isDirectory()) out.push(...sources(new URL(`${name}/`, dir)));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(child.pathname);
  }
  return out;
}

test('pin: website code never imports funnels/charge-server or funnels/tiers', () => {
  const dirs = [new URL('./', import.meta.url), new URL('../../app/api/s/', import.meta.url), new URL('../../app/s/', import.meta.url)];
  const bad = /(?:from|import|require)\s*\(?\s*['"][^'"]*funnels\/(?:charge-server|tiers)[^'"]*['"]/;
  const files = dirs.flatMap(sources);
  assert.ok(files.some((f) => f.endsWith('/websites/policy.ts')), 'the scan found this folder');
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), bad, `${f} imports the funnel billing code`);
});

test('pin: policy.ts and the other pure files import nothing server-side', () => {
  for (const name of ['types', 'slug', 'urls', 'sources', 'policy']) {
    const src = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)) assert.match(m[1], /^\.\.?\//, `${name} imports ${m[1]}`);
    for (const m of src.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)) assert.doesNotMatch(m[1], /server|supabase/, `${name} imports ${m[1]}`);
  }
});
