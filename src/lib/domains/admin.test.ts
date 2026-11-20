import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness, type Harness } from './test-store.ts';
import { adminRunner, isAdminKind } from './admin-run.ts';
import { actionsFor, buildRow, capLine, domainWhy, money, renewalLine } from './admin-view.ts';
import { DEFAULT_DOMAINS, DOMAIN_KEYS, type DomainSettings } from './settings.ts';

const DAY = 86_400_000;

function runner(h: Harness) {
  const written: Array<[string, boolean | number]> = [];
  const r = adminRunner({
    engine: h.engine,
    readSettings: async () => h.store.settingsNow as DomainSettings,
    writeSetting: async (k, v) => { written.push([k, v]); return true; },
    adminId: 'admin-1',
  });
  return { r, written };
}

async function liveDomain(h: Harness, company = 'Harbour Management Ltd') {
  const d = await h.chosen({ auto: true, company });
  h.vercel.config = { ...h.vercel.config, misconfigured: false };
  await h.engine.advance(d.domainId);
  return d;
}

// ── Dry runs write nothing ──

test('the dry run of every admin action writes nothing and calls no registrar, no Vercel, no email, no setting write', async () => {
  const h = harness();
  const awaiting = await h.chosen({ company: 'Alder Homes Ltd' });
  const live = await liveDomain(h, 'Birch Homes Ltd');
  const failedBought = await liveDomain(h, 'Cedar Homes Ltd');
  await h.store.updateDomain(failedBought.domainId, { status: 'failed' });
  const failedNotBought = await h.chosen({ company: 'Dale Homes Ltd' });
  await h.store.updateDomain(failedNotBought.domainId, { status: 'failed' });
  h.store.settingsNow.autoBuy = true; // so turning it off is a change
  const { r, written } = runner(h);

  const snap = () => JSON.stringify({ d: [...h.store.domains.entries()], s: [...h.store.spend.entries()], o: [...h.store.offers.entries()], si: [...h.store.sites.entries()], c: h.store.charges, set: h.store.settingsNow });
  const before = snap();
  const writes = h.store.writes.length;
  const reg = { ...h.registrar.calls };
  const vlog = h.vercel.log.length;
  const sent = h.sent.length;

  const results = [
    await r.dryRun('buy', awaiting.domainId),
    await r.dryRun('retry', failedBought.domainId),
    await r.dryRun('retry', failedNotBought.domainId),
    await r.dryRun('release', live.domainId),
    await r.dryRun('renew', live.domainId),
    await r.dryRun('dont_renew', live.domainId),
    await r.dryRunSetting(DOMAIN_KEYS.autoBuy, 'false'),
    await r.dryRunSetting(DOMAIN_KEYS.dailySpendCapPence, '0'),
    await r.dryRunSetting(DOMAIN_KEYS.chargeOn, 'true'),
  ];

  assert.equal(snap(), before, 'nothing in the store changed');
  assert.equal(h.store.writes.length, writes);
  assert.deepEqual(h.registrar.calls, reg);
  assert.equal(h.vercel.log.length, vlog);
  assert.equal(h.sent.length, sent);
  assert.deepEqual(written, [], 'no setting was written');
  for (const res of results) {
    assert.equal(res.ok, true);
    assert.equal(res.canRun, true, 'a passing dry run offers Run');
    assert.match(res.message, /Dry run passed: nothing was changed/);
  }
  assert.match(results[0].message, /It would spend £6/, 'the cost is shown');
  assert.ok(results[3].lines.some((l) => /Vercel/.test(l)) && results[3].lines.some((l) => /refunded/.test(l)));
  assert.ok(results[8].lines.some((l) => /SECOND year/.test(l)), 'turning the charge on says what it does');
});

test('a dry run that cannot pass does not offer Run', async () => {
  const h = harness();
  const live = await liveDomain(h);
  const { r } = runner(h);
  const buy = await r.dryRun('buy', live.domainId);
  assert.equal(buy.ok, false);
  assert.equal(buy.canRun, false);
  assert.equal((await r.dryRun('buy', 'nope')).canRun, false);
  assert.equal((await r.dryRunSetting(DOMAIN_KEYS.dailySpendCapPence, '-5')).canRun, false);
  assert.equal((await r.dryRunSetting('website_report_pence', '5')).canRun, false);
  const same = await r.dryRunSetting(DOMAIN_KEYS.autoBuy, String(DEFAULT_DOMAINS.autoBuy));
  assert.equal(same.canRun, false, 'no change, nothing to run');
});

// ── Runs ──

test('Buy buys a domain awaiting the admin', async () => {
  const h = harness();
  const a = await h.chosen();
  const { r } = runner(h);
  const res = await r.run('buy', a.domainId);
  assert.equal(res.ok, true);
  assert.match(res.message, /Bought/);
  assert.equal((await h.store.domain(a.domainId))?.status, 'connecting');
});

test('Retry on a failed domain: bought ones go back to connecting and on; others buy again', async () => {
  const h = harness();
  const bought = await liveDomain(h, 'Cedar Homes Ltd');
  await h.store.updateDomain(bought.domainId, { status: 'failed', lastError: 'vercel:unclear:504' });
  const { r } = runner(h);
  // The retry of a bought-but-failed domain advances it (here it is already fully connected, so it goes live again).
  const res = await r.run('retry', bought.domainId);
  assert.equal(res.ok, true);
  assert.equal((await h.store.domain(bought.domainId))?.status, 'live');
  assert.equal(h.registrar.calls.register, 1, 'never bought twice');

  const notBought = await h.chosen({ company: 'Dale Homes Ltd' });
  await h.store.updateDomain(notBought.domainId, { status: 'failed', attempts: 3, lastError: 'registrar:unclear:504' });
  const res2 = await r.run('retry', notBought.domainId);
  assert.match(res2.message, /Bought/);
  assert.equal(h.registrar.calls.register, 2);
  assert.equal((await r.run('retry', notBought.domainId)).ok, false, 'only a failed domain can be retried');
});

test('Release runs the engine\'s release; Renew records the decision and renews; Don\'t renew only records', async () => {
  const h = harness();
  const a = await liveDomain(h, 'Alder Homes Ltd');
  const b = await liveDomain(h, 'Birch Homes Ltd');
  const c = await liveDomain(h, 'Cedar Homes Ltd');
  const { r } = runner(h);
  assert.match((await r.run('release', a.domainId)).message, /Released/);
  assert.equal((await h.store.domain(a.domainId))?.status, 'released');
  const renewed = await r.run('renew', b.domainId);
  assert.match(renewed.message, /Renewed for a year/);
  assert.equal(h.registrar.calls.renew, 1);
  const nope = await r.run('dont_renew', c.domainId);
  assert.match(nope.message, /will not be renewed/);
  const row = (await h.store.domain(c.domainId))!;
  assert.equal(row.renewDecision, 'dont_renew');
  assert.equal(row.renewDecidedBy, 'admin-1');
  assert.equal(h.registrar.calls.renew, 1);
});

test('settings: only the three keys, value-checked, written through the one writer', async () => {
  const h = harness();
  const { r, written } = runner(h);
  assert.equal((await r.saveSetting(DOMAIN_KEYS.dailySpendCapPence, '2500')).ok, true);
  assert.equal((await r.saveSetting(DOMAIN_KEYS.autoBuy, 'false')).ok, true);
  assert.equal((await r.saveSetting(DOMAIN_KEYS.chargeOn, 'true')).ok, true);
  assert.deepEqual(written, [[DOMAIN_KEYS.dailySpendCapPence, 2500], [DOMAIN_KEYS.autoBuy, false], [DOMAIN_KEYS.chargeOn, true]]);
  for (const [k, v] of [['website_report_charge_on', 'true'], ['domain_charge_on', 'yes'], ['domain_daily_spend_cap_pence', '100001'], ['__proto__', '1'], ['', '1']]) {
    assert.equal((await r.saveSetting(k, v)).ok, false, `${k}=${v}`);
  }
  assert.equal(written.length, 3, 'nothing else was written');
  assert.equal(isAdminKind('release'), true);
  assert.equal(isAdminKind('delete'), false);
});

// ── The list's words ──

test('why a domain is where it is: the cap reads "Daily spend cap reached: £0 of £0 left"', () => {
  assert.equal(capLine(0, 0), 'Daily spend cap reached: £0 of £0 left');
  assert.equal(capLine(5000, 4800), 'Daily spend cap reached: £2 of £50 left');
  assert.equal(capLine(5000, 9999), 'Daily spend cap reached: £0 of £50 left');
  const base = { lastError: null, attempts: 0, costPence: 600, autoBuy: true, capPence: 0, usedTodayPence: 0, renewAllowed: true };
  assert.match(domainWhy({ ...base, status: 'held_cap' }), /^Daily spend cap reached: £0 of £0 left\. It is tried again automatically the next UK day\.$/);
  assert.match(domainWhy({ ...base, status: 'awaiting_admin', autoBuy: false }), /press Buy/);
  assert.match(domainWhy({ ...base, status: 'failed', attempts: 3, lastError: 'registrar:unclear:504' }), /Failed after 3 tries \(registrar:unclear:504\)\. Press Retry\./);
  assert.match(domainWhy({ ...base, status: 'connecting', lastError: 'waiting: DNS is not pointing here yet' }), /DNS is not pointing here yet/);
  assert.match(domainWhy({ ...base, status: 'needs_choice' }), /nothing was spent/);
  assert.match(domainWhy({ ...base, status: 'released' }), /Stayful keeps the name until it expires/);
  assert.match(domainWhy({ ...base, status: 'live', renewAllowed: false }), /Renewing is switched off/);
  assert.equal(money(600), '£6');
  assert.equal(money(650), '£6.50');
  assert.equal(money(null), '—');
});

test('each row carries the name, site, member, bought, cost, renews, status, last error and why; buttons fit the status', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const row = buildRow(
    { id: 'd1', name: 'harbourmanagement.co.uk', status: 'live', boughtAt: '2026-11-20T10:00:00Z', costPence: 600, expiresAt: new Date(now.getTime() + 20 * DAY).toISOString(), lastError: null, attempts: 0, renewAllowed: true, renewDecision: null },
    { slug: 'harbour', company: 'Harbour Management Ltd' },
    'zac@example.test',
    { autoBuy: true, capPence: 5000, usedTodayPence: 600 },
    now,
  );
  assert.deepEqual([row.name, row.siteSlug, row.company, row.memberEmail, row.boughtAt, row.costPence, row.status, row.lastError], ['harbourmanagement.co.uk', 'harbour', 'Harbour Management Ltd', 'zac@example.test', '2026-11-20T10:00:00Z', 600, 'live', null]);
  assert.equal(row.renewalDue, true);
  assert.equal(row.daysLeft, 20);
  assert.match(renewalLine(row), /expires in 20 days\. No decision yet; the 7-day rule applies\./);
  assert.deepEqual(row.actions, ['release']);
  assert.deepEqual(actionsFor('awaiting_admin'), ['buy', 'release']);
  assert.deepEqual(actionsFor('failed'), ['retry', 'release']);
  assert.deepEqual(actionsFor('released'), []);
});

// ── Source pins ──

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('every exported admin action checks the admin first, before it reads its arguments, and the dry runs never reach a writer', () => {
  const src = read('../../app/admin/management/domain-actions.ts');
  const exported = [...src.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(exported, ['dryRunDomainAction', 'runDomainAction', 'dryRunDomainSettingAction', 'saveDomainSettingAction']);
  for (const name of exported) {
    const body = src.slice(src.indexOf(`export async function ${name}(`));
    const first = body.slice(0, body.indexOf('\n}\n'));
    const at = (needle: string) => first.indexOf(needle);
    assert.ok(at('await requireAdmin()') > 0, `${name} checks the admin`);
    const argUse = Math.min(...['isAdminKind(', 'String(domainId', 'String(key', 'runner('].map((n) => (at(n) === -1 ? Infinity : at(n))));
    assert.ok(at('await requireAdmin()') < argUse, `${name} checks the admin before it reads anything`);
  }
  // A dry run goes through dryRun / dryRunSetting only: no run, no save, no audit, no revalidate.
  for (const name of ['dryRunDomainAction', 'dryRunDomainSettingAction']) {
    const body = src.slice(src.indexOf(`export async function ${name}(`));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    assert.doesNotMatch(fn, /\.run\(|\.saveSetting\(|audit\(|refresh\(\)|writeDomainSetting/, name);
  }
  // The run and the save leave a console audit line (as Batch 31's do).
  assert.match(src, /console\.info\(`\[admin\] domains: \$\{admin\.email\} \$\{what\}`\)/);
  assert.equal([...src.matchAll(/audit\(admin,/g)].length, 2);
  assert.match(src, /^'use server';/m);
});

test('the admin runner\'s dry paths use only the engine\'s dryRun flag and the settings read', () => {
  const src = read('./admin-run.ts');
  const dry = src.slice(src.indexOf('async function dryRun('), src.indexOf('async function run('));
  assert.doesNotMatch(dry, /dryRun: true, admin: true\)\);\s*case 'retry'[\s\S]*\{ admin: true \}\)\)/);
  for (const m of dry.matchAll(/engine\.(\w+)\(([^)]*)\)/g)) assert.match(m[2], /dryRun: true/, `${m[1]} is called as a dry run`);
  const dryS = src.slice(src.indexOf('async function dryRunSetting('), src.indexOf('async function saveSetting('));
  assert.doesNotMatch(dryS, /writeSetting/);
});

test('the panel offers Run only after a passing dry run for the same input', () => {
  const panel = read('../../app/admin/management/DomainsPanel.tsx');
  // Domain actions: Run appears only while dryPassed, which only a passing dry run sets, and which Run clears.
  assert.match(panel, /setDryPassed\(r\.canRun\)/);
  assert.match(panel, /\{dryPassed \? \(/);
  assert.match(panel, /setDryPassed\(false\)/);
  // Settings: Save appears only for exactly the value the dry run passed for.
  assert.match(panel, /setDryFor\(r\.canRun \? value : null\)/);
  assert.match(panel, /\{dryFor === value \? \(/);
  // The three settings are the fixed DOMAIN_KEYS map: no free-text key.
  const keys = [...panel.matchAll(/key: DOMAIN_KEYS\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['autoBuy', 'dailySpendCapPence', 'chargeOn']);
  assert.doesNotMatch(panel, /name="key"|setKey|<input[^>]*key/);
});

test('the page adds the panel with a few lines and the admin loader reads no secrets', () => {
  const page = read('../../app/admin/management/page.tsx');
  assert.match(page, /import \{ DomainsPanel \} from "\.\/DomainsPanel";/);
  assert.match(page, /const domains = await loadDomainsAdmin\(\);/);
  assert.match(page, /<DomainsPanel data=\{domains\} \/>/);
  const server = read('./admin-server.ts');
  assert.doesNotMatch(server, /registrar_ref|registrarRef|OPENPROVIDER_PASSWORD|DOMAINS_VERCEL_TOKEN/);
});
