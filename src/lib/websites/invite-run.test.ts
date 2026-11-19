import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SETTING_LIMITS,
  countBy,
  describeSettingsChanges,
  dryRunInvite,
  inviteChecklist,
  inviteDenialText,
  planSiteStatus,
  runInvite,
  validateWebsiteSettings,
  weekStart,
  type InviteFacts,
} from './invite-run.ts';
import { DEFAULT_WEBSITE, parseWebsite, WEBSITE_KEYS } from './settings.ts';

/** Batch 31 phase 11: the admin panel's give-a-website checklist, pause plan and settings validation. */

const good: InviteFacts = {
  email: 'owner@example.com',
  slug: 'acme-lettings',
  member: { id: '11111111-1111-1111-1111-111111111111', isManagement: true, paid: false },
  isOwner: true,
  hasSite: false,
  slugTaken: false,
  planGateOn: false,
};
const state = (f: InviteFacts, key: string) => inviteChecklist(f).items.find((i) => i.key === key)?.state;

// ── The checklist: each refusal ──

test('a clean member and a free valid slug pass every line', () => {
  const c = inviteChecklist(good);
  assert.equal(c.canRun, true);
  assert.deepEqual(c.items.map((i) => i.key), ['member', 'management', 'owner', 'no_site', 'slug_valid', 'slug_free', 'plan_gate']);
  assert.ok(c.items.every((i) => i.state === 'pass'));
});

test('no account with that email: refused, the member lines are skipped', () => {
  const c = inviteChecklist({ ...good, member: null });
  assert.equal(c.canRun, false);
  assert.equal(state({ ...good, member: null }, 'member'), 'fail');
  for (const k of ['management', 'owner', 'no_site', 'plan_gate']) assert.equal(state({ ...good, member: null }, k), 'skip', k);
  // The address lines stand on their own.
  assert.equal(state({ ...good, member: null }, 'slug_valid'), 'pass');
});

test('something that is not an email is refused before any member is looked at', () => {
  assert.equal(state({ ...good, email: 'not-an-email' }, 'member'), 'fail');
  assert.equal(inviteChecklist({ ...good, email: '  ' }).canRun, false);
});

test('not a management account: refused', () => {
  const f = { ...good, member: { ...good.member!, isManagement: false } };
  assert.equal(state(f, 'management'), 'fail');
  assert.equal(inviteChecklist(f).canRun, false);
});

test('a team member (not the account owner): refused', () => {
  const f = { ...good, isOwner: false };
  assert.equal(state(f, 'owner'), 'fail');
  assert.equal(inviteChecklist(f).canRun, false);
});

test('a member who already has a website: refused (one per member)', () => {
  const f = { ...good, hasSite: true };
  assert.equal(state(f, 'no_site'), 'fail');
  assert.equal(inviteChecklist(f).canRun, false);
});

test('an invalid slug is refused for each reason, and the free check is skipped', () => {
  for (const slug of ['', 'ab', 'x'.repeat(41), 'Has Space', '-edge', 'edge-', 'admin', 'api']) {
    const f = { ...good, slug };
    assert.equal(state(f, 'slug_valid'), 'fail', JSON.stringify(slug));
    assert.equal(state(f, 'slug_free'), 'skip', JSON.stringify(slug));
    assert.equal(inviteChecklist(f).canRun, false, JSON.stringify(slug));
  }
});

test('the slug is read as the run will read it: trimmed and lowercase', () => {
  const c = inviteChecklist({ ...good, slug: '  Acme-Lettings ', email: '  Owner@Example.com ' });
  assert.equal(c.slug, 'acme-lettings');
  assert.equal(c.email, 'owner@example.com');
  assert.equal(c.canRun, true);
});

test('a taken slug is refused', () => {
  const f = { ...good, slugTaken: true };
  assert.equal(state(f, 'slug_free'), 'fail');
  assert.equal(inviteChecklist(f).canRun, false);
});

test('plan gate off: passes without a plan; on: refuses an unpaid member and passes a paid one', () => {
  assert.equal(state({ ...good, planGateOn: false }, 'plan_gate'), 'pass');
  assert.match(inviteChecklist({ ...good, planGateOn: false }).items.at(-1)!.detail, /off/);
  const on = { ...good, planGateOn: true };
  assert.equal(state(on, 'plan_gate'), 'fail');
  assert.equal(inviteChecklist(on).canRun, false);
  const paid = { ...on, member: { ...good.member!, paid: true } };
  assert.equal(state(paid, 'plan_gate'), 'pass');
  assert.equal(inviteChecklist(paid).canRun, true);
});

test('the checklist shows the gate state even when no member was found', () => {
  assert.match(inviteChecklist({ ...good, member: null, planGateOn: true }).items.at(-1)!.detail, /on/);
});

// ── The dry run writes nothing ──

test('the dry run returns the checklist and never calls the write', async () => {
  let wrote = 0;
  const invite = async () => {
    wrote += 1;
    return 'created';
  };
  // dryRunInvite takes facts only: it has nothing to write with. The run, given the same facts, does write.
  const dry = dryRunInvite(good);
  assert.equal(dry.canRun, true);
  assert.equal(wrote, 0);
  const run = await runInvite(good, invite);
  assert.deepEqual([run.ran, wrote], [true, 1]);
});

test('the run calls the write only when every line passes', async () => {
  let wrote = 0;
  const invite = async () => {
    wrote += 1;
    return 'created';
  };
  const refusals: InviteFacts[] = [
    { ...good, member: null },
    { ...good, member: { ...good.member!, isManagement: false } },
    { ...good, isOwner: false },
    { ...good, hasSite: true },
    { ...good, slug: 'ab' },
    { ...good, slugTaken: true },
    { ...good, planGateOn: true },
  ];
  for (const f of refusals) {
    const r = await runInvite(f, invite);
    assert.equal(r.ran, false);
    assert.equal(r.checklist.canRun, false);
  }
  assert.equal(wrote, 0);
});

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const WRITES = /\.(insert|update|upsert|delete)\(|\.rpc\(|inviteWebsite\(|setStatus\(|updateBillingSetting\(|saveSettings\(|invalidateCreditCaches\(/;

function fnBody(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  assert.ok(from >= 0, `${start} not found`);
  const to = src.indexOf(end, from + start.length);
  assert.ok(to > from, `${end} not found after ${start}`);
  return stripComments(src.slice(from, to));
}

const actions = readFileSync(new URL('../../app/admin/management/website-actions.ts', import.meta.url), 'utf8');
const run = readFileSync(new URL('./invite-run.ts', import.meta.url), 'utf8');

test('source pin: the dry-run actions and the fact gathering contain no write', () => {
  const dryGive = fnBody(actions, 'export async function dryRunGiveWebsiteAction(', '\nexport async function giveWebsiteAction(');
  const gather = fnBody(actions, 'async function gatherInviteFacts(', '\nexport async function dryRunGiveWebsiteAction(');
  const dryStatus = fnBody(actions, 'export async function dryRunSiteStatusAction(', '\nexport async function setSiteStatusAction(');
  for (const [name, body] of [['dryRunGiveWebsiteAction', dryGive], ['gatherInviteFacts', gather], ['dryRunSiteStatusAction', dryStatus]] as const) {
    assert.doesNotMatch(body, WRITES, name);
  }
  assert.match(dryGive, /dryRunInvite\(/);
  assert.doesNotMatch(dryGive, /runInvite\(/);
});

test('source pin: invite-run.ts dry-run function and checklist contain no write', () => {
  const body = fnBody(run, 'export function inviteChecklist(', 'export type RunInviteResult');
  assert.doesNotMatch(body, WRITES);
  assert.doesNotMatch(stripComments(run), /from '\.\.?\/supabase|createAdminClient|server-only|from '\.\/store-server/);
});

test('source pin: the run calls inviteWebsite once, through runInvite, after the admin check', () => {
  const give = fnBody(actions, 'export async function giveWebsiteAction(', '\n// ── Pause / unpause');
  assert.equal((give.match(/inviteWebsite\(/g) ?? []).length, 1);
  assert.match(give, /runInvite\(facts,/);
  assert.ok(give.indexOf('requireAdmin()') < give.indexOf('inviteWebsite('));
});

test('source pin: every exported action checks the admin first, and no lead data or protected module is touched', () => {
  const code = stripComments(actions);
  const exported = [...code.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(exported, ['dryRunGiveWebsiteAction', 'giveWebsiteAction', 'dryRunSiteStatusAction', 'setSiteStatusAction', 'saveWebsiteSettingsAction']);
  for (const name of exported) {
    const body = fnBody(actions, `export async function ${name}(`, '\n}\n');
    const at = body.indexOf('await requireAdmin()');
    assert.ok(at > 0, `${name} must call requireAdmin`);
    // Nothing before the admin check but the try.
    assert.match(body.slice(0, at), /try\s*\{\s*(const admin = )?$/, name);
  }
  assert.doesNotMatch(code, /from\('leads'\)|lead_sources|\baddress\b|\bphone\b/);
  assert.doesNotMatch(code, /charge-server|tiers|ACCESS_COLUMNS|analysis/i);
  assert.doesNotMatch(code, /active:\s*true|from\('funnels'\)/);
});

test('source pin: the settings action writes only the five website keys, via updateBillingSetting', () => {
  const save = fnBody(actions, 'export async function saveWebsiteSettingsAction(', '\n}\n');
  assert.match(save, /updateBillingSetting\(WEBSITE_KEYS\[field\]/);
  assert.equal((save.match(/updateBillingSetting\(/g) ?? []).length, 1);
  assert.match(save, /invalidateCreditCaches\(\)/);
  assert.ok(save.indexOf('validateWebsiteSettings(') < save.indexOf('updateBillingSetting('), 'validated before any write');
  assert.doesNotMatch(save, /unit_costs|analysis|si_|deal_|starter/i);
});

// ── Pause / unpause ──

test('pause: only a live site, and the plan says what changes and that nothing is deleted', () => {
  const p = planSiteStatus({ slug: 'acme', status: 'live' }, 'pause');
  assert.equal(p.ok, true);
  assert.equal(p.to, 'paused');
  const text = p.lines.join(' ');
  assert.match(text, /paused_at/);
  assert.match(text, /404/);
  assert.match(text, /Nothing is deleted/);
  assert.match(text, /\/s\/acme/);
  for (const status of ['invited', 'setup', 'preview', 'paused']) {
    const r = planSiteStatus({ slug: 'acme', status }, 'pause');
    assert.equal(r.ok, false, status);
    assert.equal(r.to, null);
  }
});

test('unpause: only a paused site goes live again', () => {
  const p = planSiteStatus({ slug: 'acme', status: 'paused' }, 'unpause');
  assert.equal(p.ok, true);
  assert.equal(p.to, 'live');
  assert.match(p.lines.join(' '), /paused_at is cleared/);
  for (const status of ['invited', 'setup', 'preview', 'live']) assert.equal(planSiteStatus({ slug: 'acme', status }, 'unpause').ok, false, status);
});

// ── The five settings ──

const valid = { reportChargeOn: 'false', reportPence: '300', planGateOn: 'false', freeReportsPerDay: '20', freeReportsPerSitePerDay: '5' };

test('the defaults validate and match the parser defaults', () => {
  const r = validateWebsiteSettings(valid);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.values, DEFAULT_WEBSITE);
});

test('switches are strict: only true / false', () => {
  for (const bad of ['yes', '1', 'on', 'TRUE', '', undefined, null, 1, 0]) {
    for (const key of ['reportChargeOn', 'planGateOn'] as const) {
      const r = validateWebsiteSettings({ ...valid, [key]: bad });
      assert.equal(r.ok, false, `${key}=${String(bad)}`);
      if (!r.ok) assert.ok(r.errors[key]);
    }
  }
  const on = validateWebsiteSettings({ ...valid, reportChargeOn: true, planGateOn: 'true' });
  assert.equal(on.ok && on.values.reportChargeOn && on.values.planGateOn, true);
});

test('integers are whole and at least 0; pence is sane; a site never exceeds the daily total', () => {
  for (const bad of ['-1', '1.5', 'abc', '', '1e3', ' ', '3 0', undefined, 2.5]) {
    for (const key of ['reportPence', 'freeReportsPerDay', 'freeReportsPerSitePerDay'] as const) {
      assert.equal(validateWebsiteSettings({ ...valid, [key]: bad }).ok, false, `${key}=${String(bad)}`);
    }
  }
  assert.equal(validateWebsiteSettings({ ...valid, reportPence: '0' }).ok, false);
  assert.equal(validateWebsiteSettings({ ...valid, reportPence: String(SETTING_LIMITS.pence.max + 1) }).ok, false);
  assert.equal(validateWebsiteSettings({ ...valid, freeReportsPerDay: String(SETTING_LIMITS.perDay.max + 1), freeReportsPerSitePerDay: '5' }).ok, false);
  // 0 is allowed: it stops free reports.
  assert.equal(validateWebsiteSettings({ ...valid, freeReportsPerDay: '0', freeReportsPerSitePerDay: '0' }).ok, true);
  // Per-site above the daily total.
  const over = validateWebsiteSettings({ ...valid, freeReportsPerDay: '3', freeReportsPerSitePerDay: '4' });
  assert.equal(over.ok, false);
  if (!over.ok) assert.ok(over.errors.freeReportsPerSitePerDay);
  assert.equal(validateWebsiteSettings({ ...valid, freeReportsPerDay: '4', freeReportsPerSitePerDay: '4' }).ok, true);
});

test('every problem is reported together', () => {
  const r = validateWebsiteSettings({ reportChargeOn: 'x', reportPence: '-3', planGateOn: 'y', freeReportsPerDay: 'z', freeReportsPerSitePerDay: '1.5' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(Object.keys(r.errors).length, 5);
});

test('every value the validator accepts is read back unchanged by the app parser (no silent fallback)', () => {
  const edges = [
    { reportPence: SETTING_LIMITS.pence.min, freeReportsPerDay: 0, freeReportsPerSitePerDay: 0 },
    { reportPence: SETTING_LIMITS.pence.max, freeReportsPerDay: SETTING_LIMITS.perDay.max, freeReportsPerSitePerDay: SETTING_LIMITS.perDay.max },
  ];
  for (const e of edges) {
    const r = validateWebsiteSettings({ reportChargeOn: 'true', planGateOn: 'true', ...e });
    assert.equal(r.ok, true);
    if (!r.ok) continue;
    const stored = new Map<string, unknown>(Object.entries(WEBSITE_KEYS).map(([field, key]) => [key, r.values[field as keyof typeof r.values]]));
    assert.deepEqual(parseWebsite((k) => stored.get(k)), r.values);
  }
});

test('changes are described per setting, and an unchanged save describes nothing', () => {
  const after = { ...DEFAULT_WEBSITE, planGateOn: true, reportPence: 500 };
  assert.deepEqual(describeSettingsChanges(DEFAULT_WEBSITE, after), ['Report price (pence): 300 → 500', 'Plan gate: off → on']);
  assert.deepEqual(describeSettingsChanges(DEFAULT_WEBSITE, DEFAULT_WEBSITE), []);
});

// ── Small helpers ──

test('countBy tallies string ids and ignores anything else', () => {
  assert.deepEqual([...countBy(['a', 'b', 'a', null, 3, undefined])], [['a', 2], ['b', 1]]);
});

test('weekStart is seven days before now', () => {
  assert.equal(weekStart(new Date('2026-11-19T12:00:00Z')), '2026-11-12T12:00:00.000Z');
});

test('a denial reason reads as words, and an unknown one says nothing was changed', () => {
  assert.match(inviteDenialText('already_has_site'), /already/);
  assert.match(inviteDenialText('whatever'), /Nothing was changed/);
});
