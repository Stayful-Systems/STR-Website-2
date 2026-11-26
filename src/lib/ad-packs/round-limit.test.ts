import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanGrantReason, countsAsRound, decideLeadDbRound, GRANT_REASON_MAX, overBackstop, roundWindowStart, sumRunSpend, type RoundGrant, type RoundRun } from './round-limit.ts';
import { GENERATE_MESSAGES, type GenerateInput, type GenerateOk, type GenerateResult } from './generate-core.ts';
import { DEFAULT_AD_PACK_SETTINGS } from './settings.ts';
import { harness } from './test-store.ts';

/**
 * Batch 55 (Part A), phase A8: the lead database route's creative cap (one round per rolling window, an admin grant allows
 * one more) and its monthly backstop, and the proof that the Academy numbers did not move.
 */

const OWNER_A = '3f9a2c11-1111-4111-8111-111111111111';
const OWNER_B = '7b1d4e22-2222-4222-8222-222222222222';
const APP_HOST = 'stay' + 'ful.co.uk';
const DAY = 86_400_000;

function academy(over: Partial<GenerateInput> = {}): GenerateInput {
  return {
    areaKey: 'NG7',
    photos: ['https://cdn.example.test/photo-1.jpg'],
    brand: { company: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/logo.png', brandColour: '#1F6F5C', feePct: 12, areas: ['Nottingham'], photoUrl: null },
    domain: 'brightstone.co.uk',
    websiteId: '00000000-0000-4000-8000-0000000000aa',
    ...over,
  };
}
const leadDb = (over: Partial<GenerateInput> = {}) => academy({ domain: APP_HOST, route: 'leaddb', sitePath: 'brightstone-calc', ...over });

function ok(r: GenerateResult): GenerateOk {
  assert.ok(r.ok && !r.dry, `expected a made pack, got ${JSON.stringify(r.ok ? { dry: true } : { code: r.code })}`);
  return r as GenerateOk;
}
const code = (r: GenerateResult): string => {
  assert.equal(r.ok, false, 'expected a refusal');
  return (r as { code: string }).code;
};
const operator = (h: ReturnType<typeof harness>, input: GenerateInput, ownerId = OWNER_A) => h.engine.generatePack({ ownerId, by: 'operator', input });

// ── The pure rule ──

const NOW = new Date('2026-12-10T12:00:00Z');
const run = (daysAgo: number, over: Partial<RoundRun> = {}): RoundRun => ({ by: 'operator', createdAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(), result: { outcome: 'preview' }, ...over });
const grant = (id: string, createdAt = '2026-12-01T00:00:00Z', usedAt: string | null = null): RoundGrant => ({ id, createdAt, usedAt });

test('the pure rule: nothing made yet is allowed and uses no grant', () => {
  assert.deepEqual(decideLeadDbRound({ runs: [], grants: [grant('g1')], roundDays: 30, now: NOW }), { allowed: true, grantId: null });
});

test('the pure rule: a preview inside the window refuses the next round, with the day the window clears', () => {
  const d = decideLeadDbRound({ runs: [run(5)], grants: [], roundDays: 30, now: NOW });
  assert.equal(d.allowed, false);
  assert.equal(d.allowed === false && d.code, 'round_limit');
  assert.equal(d.allowed === false && d.nextRoundAt, new Date(NOW.getTime() + 25 * DAY).toISOString());
});

test('the pure rule: the window is rolling and exact: a run exactly ldRoundDays old is outside, one a second younger is inside', () => {
  assert.equal(decideLeadDbRound({ runs: [run(30)], grants: [], roundDays: 30, now: NOW }).allowed, true);
  const young = { ...run(30), createdAt: new Date(NOW.getTime() - 30 * DAY + 1000).toISOString() };
  assert.equal(decideLeadDbRound({ runs: [young], grants: [], roundDays: 30, now: NOW }).allowed, false);
  assert.equal(roundWindowStart(NOW, 30).toISOString(), new Date(NOW.getTime() - 30 * DAY).toISOString());
  // The setting moves the window.
  assert.equal(decideLeadDbRound({ runs: [run(10)], grants: [], roundDays: 7, now: NOW }).allowed, true);
  assert.equal(decideLeadDbRound({ runs: [run(10)], grants: [], roundDays: 14, now: NOW }).allowed, false);
});

test('the pure rule: only an operator preview counts (failed, checks_failed, admin, dry and render runs do not)', () => {
  const others: RoundRun[] = [
    run(1, { result: { outcome: 'failed' } }),
    run(1, { result: { outcome: 'checks_failed' } }),
    run(1, { by: 'admin' }),
    run(1, { dry: true }),
    run(1, { result: null }),
    run(1, { result: { kind: 'render' } as never }),
  ];
  for (const r of others) assert.equal(countsAsRound(r), false);
  assert.equal(decideLeadDbRound({ runs: others, grants: [], roundDays: 30, now: NOW }).allowed, true);
  assert.equal(countsAsRound(run(1)), true);
});

test('the pure rule: an unused grant allows exactly one more (the oldest first); used grants are ignored; a run of unreadable time counts', () => {
  const d = decideLeadDbRound({ runs: [run(2)], grants: [grant('late', '2026-12-05T00:00:00Z'), grant('early', '2026-12-01T00:00:00Z'), grant('spent', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')], roundDays: 30, now: NOW });
  assert.deepEqual(d, { allowed: true, grantId: 'early' });
  assert.equal(decideLeadDbRound({ runs: [run(2)], grants: [grant('spent', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')], roundDays: 30, now: NOW }).allowed, false);
  assert.equal(decideLeadDbRound({ runs: [{ ...run(1), createdAt: 'not a date' }], grants: [], roundDays: 30, now: NOW }).allowed, false);
});

test('the backstop: a run that would take the month over the cap is over it; at the cap exactly it fits; a cap of 0 stops everything', () => {
  assert.equal(overBackstop(24_000, 1_000, 25_000), false);
  assert.equal(overBackstop(24_000, 1_001, 25_000), true);
  assert.equal(overBackstop(0, 1, 0), true);
});

test('sumRunSpend counts non-dry runs since the instant, for one route or for all', () => {
  const rows = [
    { route: 'academy' as const, dry: false, costPence: 40, createdAt: '2026-12-02T00:00:00.000Z' },
    { route: 'leaddb' as const, dry: false, costPence: 100, createdAt: '2026-12-03T00:00:00.000Z' },
    { route: 'leaddb' as const, dry: true, costPence: 900, createdAt: '2026-12-03T00:00:00.000Z' },
    { route: 'leaddb' as const, dry: false, costPence: 70, createdAt: '2026-11-30T00:00:00.000Z' },
  ];
  assert.equal(sumRunSpend(rows, 'academy', '2026-12-01T00:00:00.000Z'), 40);
  assert.equal(sumRunSpend(rows, 'leaddb', '2026-12-01T00:00:00.000Z'), 100);
  assert.equal(sumRunSpend(rows, undefined, '2026-12-01T00:00:00.000Z'), 140);
});

test('the grant reason is required: blank, whitespace, not text and over-long are all refused; a good one is trimmed', () => {
  for (const bad of [undefined, null, '', '   ', '\n\t', 5, {}, 'x'.repeat(GRANT_REASON_MAX + 1)]) assert.equal(cleanGrantReason(bad), null);
  assert.equal(cleanGrantReason('  Their first set had the wrong logo  '), 'Their first set had the wrong logo');
  assert.equal(cleanGrantReason('x'.repeat(GRANT_REASON_MAX))?.length, GRANT_REASON_MAX);
});

// ── Through the engine: the creative cap ──

test('lead database route: the first round is made; a second operator round inside the window is refused with round_limit and nothing is written, rendered or paid', async () => {
  const h = harness();
  ok(await operator(h, leadDb()));
  const writes = h.store.writes.length;
  const renders = h.renderer.calls.length;
  h.now = new Date(h.now.getTime() + 2 * DAY);
  const r = await operator(h, leadDb({ brand: { ...leadDb().brand, brandColour: '#C2410C' } }));
  assert.equal(code(r), 'round_limit');
  assert.equal((r as { message: string }).message, GENERATE_MESSAGES.round_limit);
  assert.equal(h.store.writes.length, writes, 'nothing written');
  assert.equal(h.renderer.calls.length, renders, 'nothing rendered');
  assert.equal((await h.store.getPack(OWNER_A))?.version, 1);
  assert.equal(h.store.runs.length, 1);
});

test('lead database route: a brand change does not matter and the Academy free regenerate is not what is used; the next round opens when the window has passed', async () => {
  const h = harness();
  ok(await operator(h, leadDb()));
  h.now = new Date(h.now.getTime() + 29 * DAY);
  assert.equal(code(await operator(h, leadDb())), 'round_limit');
  h.now = new Date(h.now.getTime() + 2 * DAY); // 31 days after the first
  const again = ok(await operator(h, leadDb()));
  assert.equal(again.version, 2);
  // The window is rolling from the newest round: another one straight away is refused.
  assert.equal(code(await operator(h, leadDb())), 'round_limit');
});

test('lead database route: the setting is the window (ad_pack_ld_round_days)', async () => {
  const h = harness();
  h.store.settings.ldRoundDays = 7;
  ok(await operator(h, leadDb()));
  h.now = new Date(h.now.getTime() + 6 * DAY);
  assert.equal(code(await operator(h, leadDb())), 'round_limit');
  h.now = new Date(h.now.getTime() + 2 * DAY);
  assert.equal(ok(await operator(h, leadDb())).version, 2);
});

test('lead database route: a run that failed does not count toward the window', async () => {
  const h = harness();
  h.renderer.fail = true;
  assert.equal(code(await operator(h, leadDb())), 'render_failed');
  assert.equal(h.store.runs[0].result?.outcome, 'failed');
  h.renderer.fail = false;
  h.now = new Date(h.now.getTime() + 60_000);
  const made = ok(await operator(h, leadDb()));
  assert.equal(made.status, 'preview');
  // Now the round is used.
  assert.equal(code(await operator(h, leadDb())), 'round_limit');
});

test('lead database route: a run that ended checks_failed does not count toward the window either', async () => {
  const h = harness();
  h.renderer.tweak = (images) => images.map((i, n) => (n === 0 ? { ...i, width: 1000, height: 1000 } : i));
  const bad = ok(await operator(h, leadDb()));
  assert.equal(bad.status, 'checks_failed');
  assert.equal(h.store.runs[0].result?.outcome, 'checks_failed');
  h.renderer.tweak = null;
  h.now = new Date(h.now.getTime() + 60_000);
  assert.equal(ok(await operator(h, leadDb())).status, 'preview');
  assert.equal(code(await operator(h, leadDb())), 'round_limit');
});

test('lead database route: an unused grant allows exactly one more round, is marked used only when that round succeeds, and is then used up', async () => {
  const h = harness();
  ok(await operator(h, leadDb()));
  assert.equal(code(await operator(h, leadDb())), 'round_limit');
  const g = h.store.addGrant(OWNER_A);
  // A round that fails does not use the grant.
  h.renderer.fail = true;
  h.now = new Date(h.now.getTime() + 60_000);
  assert.equal(code(await operator(h, leadDb())), 'render_failed');
  assert.equal(h.store.grants[0].usedAt, null, 'a failed run leaves the grant unused');
  // A round that fails its checks does not use it either.
  h.renderer.fail = false;
  h.renderer.tweak = (images) => images.map((i, n) => (n === 0 ? { ...i, width: 1000, height: 1000 } : i));
  h.now = new Date(h.now.getTime() + 60_000);
  assert.equal(ok(await operator(h, leadDb())).status, 'checks_failed');
  assert.equal(h.store.grants[0].usedAt, null);
  // The one that succeeds uses it.
  h.renderer.tweak = null;
  h.now = new Date(h.now.getTime() + 60_000);
  const extra = ok(await operator(h, leadDb()));
  assert.equal(extra.status, 'preview');
  assert.equal(extra.version, 2);
  assert.equal(h.store.grants.find((x) => x.id === g.id)?.usedAt, h.now.toISOString());
  // Exactly one: the next is refused.
  h.now = new Date(h.now.getTime() + 60_000);
  assert.equal(code(await operator(h, leadDb())), 'round_limit');
  assert.equal(h.store.grants.filter((x) => x.usedAt === null).length, 0);
});

test('lead database route: two grants give two extra rounds, oldest first; a grant is the owner’s own and never another owner’s', async () => {
  const h = harness();
  ok(await operator(h, leadDb()));
  h.store.addGrant(OWNER_B); // someone else's
  assert.equal(code(await operator(h, leadDb())), 'round_limit');
  const first = h.store.addGrant(OWNER_A, '2026-11-20T01:00:00.000Z');
  const second = h.store.addGrant(OWNER_A, '2026-11-20T02:00:00.000Z');
  h.now = new Date(h.now.getTime() + 60_000);
  ok(await operator(h, leadDb()));
  assert.ok(h.store.grants.find((x) => x.id === first.id)?.usedAt);
  assert.equal(h.store.grants.find((x) => x.id === second.id)?.usedAt, null);
  h.now = new Date(h.now.getTime() + 60_000);
  ok(await operator(h, leadDb()));
  assert.ok(h.store.grants.find((x) => x.id === second.id)?.usedAt);
  assert.equal(h.store.grants.find((x) => x.ownerId === OWNER_B)?.usedAt, null);
  h.now = new Date(h.now.getTime() + 60_000);
  assert.equal(code(await operator(h, leadDb())), 'round_limit');
});

test('lead database route: a grant held before any round was made is kept for later, not used by the first round', async () => {
  const h = harness();
  h.store.addGrant(OWNER_A);
  ok(await operator(h, leadDb()));
  assert.equal(h.store.grants[0].usedAt, null);
  h.now = new Date(h.now.getTime() + 60_000);
  ok(await operator(h, leadDb()));
  assert.ok(h.store.grants[0].usedAt);
});

test('lead database route: an unreadable grants read refuses safely (store_failed) and makes nothing', async () => {
  const h = harness();
  ok(await operator(h, leadDb()));
  h.store.addGrant(OWNER_A);
  h.store.failNext.grants = true;
  h.now = new Date(h.now.getTime() + 60_000);
  const writes = h.store.writes.length;
  assert.equal(code(await operator(h, leadDb())), 'store_failed');
  assert.equal(h.store.writes.length, writes);
});

test('lead database route: an admin regenerate never counts and is never refused by the round cap, and it does not use a grant', async () => {
  const h = harness();
  ok(await operator(h, leadDb()));
  const g = h.store.addGrant(OWNER_A);
  ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: leadDb() }));
  ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: leadDb() }));
  assert.equal(h.store.grants.find((x) => x.id === g.id)?.usedAt, null);
  // And the owner's own window is still the one round they made.
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: leadDb() })), 'round_limit' === 'round_limit' ? 'round_limit' : '');
});

test('lead database route: hand edits are free: a voice change and a video retry make no run, and are not refused by the round cap', async () => {
  const h = harness();
  const made = ok(await operator(h, leadDb()));
  const before = h.store.runs.length;
  await h.finishVideo(OWNER_A);
  const changed = await h.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia', expectedVersion: made.version });
  assert.ok(changed.ok, JSON.stringify(changed));
  assert.equal(h.store.runs.length, before, 'a voice change writes no run');
  await h.setRender(OWNER_A, { state: 'failed', errorCode: 'sandbox_failed' });
  const retried = await h.engine.retryVideo({ ownerId: OWNER_A, expectedVersion: made.version });
  assert.ok(retried.ok, JSON.stringify(retried));
  assert.equal(h.store.runs.length, before, 'a retry writes no run');
  // The window still holds just the one round.
  assert.equal(code(await operator(h, leadDb())), 'round_limit');
});

test('the Academy route is untouched by the round cap: the free regenerate rules are exactly as before', async () => {
  const h = harness();
  ok(await operator(h, academy()));
  // Same brand: no_brand_change, never round_limit.
  assert.equal(code(await operator(h, academy())), 'no_brand_change');
  const again = ok(await operator(h, academy({ brand: { ...academy().brand, brandColour: '#C2410C' } })));
  assert.equal(again.version, 2);
  assert.equal(code(await operator(h, academy({ brand: { ...academy().brand, brandColour: '#0F766E' } }))), 'regen_used');
});

// ── Through the engine: the backstop, and each route's own month ──

test('lead database route: the backstop refuses a run that would take this month’s lead database spend over ad_pack_ld_monthly_cap_pence', async () => {
  const h = harness({ pricing: { estimate: () => 40, actual: () => 40 } });
  h.store.settings.ldMonthlyCapPence = 100;
  ok(await operator(h, leadDb())); // 40
  ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: leadDb() })); // 80
  const writes = h.store.writes.length;
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: leadDb() }); // 80 + 40 > 100
  assert.equal(code(r), 'backstop');
  assert.equal((r as { message: string }).message, GENERATE_MESSAGES.backstop);
  assert.equal(h.store.writes.length, writes);
  // A dry run says the same.
  const d = await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: leadDb() });
  assert.ok(d.ok && d.dry && d.wouldBlock?.code === 'backstop');
  // The next UK month starts at zero.
  h.now = new Date('2026-12-02T09:00:00Z');
  assert.equal(ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: leadDb() })).version, 3);
});

test('lead database route: a backstop of 0 stops everything and an unreadable month is spend_unknown; nothing is made', async () => {
  const h = harness();
  h.store.settings.ldMonthlyCapPence = 0;
  assert.equal(code(await operator(h, leadDb())), 'backstop');
  h.store.settings.ldMonthlyCapPence = 25000;
  h.store.spendUnreadable = true;
  assert.equal(code(await operator(h, leadDb())), 'spend_unknown');
  assert.equal(h.store.packs.size, 0);
});

test('lead database route: the Academy monthly cap does not apply to it (a tiny Academy cap does not stop a lead database round)', async () => {
  const h = harness({ pricing: { estimate: () => 40, actual: () => 40 } });
  h.store.settings.monthlyCapPence = 10;
  assert.equal(ok(await operator(h, leadDb())).status, 'preview');
});

test('the Academy monthly cap sums ONLY academy runs: lead database spend never uses it up, and with no lead database run the numbers are what they were', async () => {
  // With no lead database run: the existing monthly_cap behaviour, number for number.
  const a = harness({ pricing: { estimate: () => 40, actual: () => 40 } });
  a.store.settings.monthlyCapPence = 100;
  ok(await a.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: academy() })); // 40
  ok(await a.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: academy() })); // 80
  assert.equal(await a.store.monthSpendPence('2026-11-01T00:00:00Z'), 80);
  assert.equal(await a.store.monthSpendPence('2026-11-01T00:00:00Z', 'academy'), 80, 'the same number, with the route filter');
  assert.equal(code(await a.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: academy() })), 'monthly_cap'); // 80 + 40 > 100

  // With lead database runs beside them: the Academy sum does not move, so its cap answers as before.
  const b = harness({ pricing: { estimate: () => 40, actual: () => 40 } });
  b.store.settings.monthlyCapPence = 100;
  ok(await b.engine.generatePack({ ownerId: OWNER_B, by: 'admin', input: leadDb() }));
  ok(await b.engine.generatePack({ ownerId: OWNER_B, by: 'admin', input: leadDb() }));
  ok(await b.engine.generatePack({ ownerId: OWNER_B, by: 'admin', input: leadDb() })); // 120 of lead database spend
  assert.equal(await b.store.monthSpendPence('2026-11-01T00:00:00Z', 'leaddb'), 120);
  assert.equal(await b.store.monthSpendPence('2026-11-01T00:00:00Z', 'academy'), 0);
  ok(await b.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: academy() })); // 40
  ok(await b.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: academy() })); // 80
  assert.equal(code(await b.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: academy() })), 'monthly_cap'); // 80 + 40 > 100, exactly as in the first harness
  assert.equal(await b.store.monthSpendPence('2026-11-01T00:00:00Z', 'academy'), 80);
});

test('a voice change and a retry answer to the pack’s own route cap: lead database to the backstop, Academy to its monthly cap', async () => {
  const l = harness({ pricing: { estimate: () => 1, actual: () => 1 } });
  const made = ok(await operator(l, leadDb()));
  await l.finishVideo(OWNER_A);
  l.store.settings.ldMonthlyCapPence = 0;
  const v = await l.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia', expectedVersion: made.version });
  assert.ok(!v.ok && v.code === 'backstop', JSON.stringify(v));

  const a = harness({ pricing: { estimate: () => 1, actual: () => 1 } });
  const m = ok(await operator(a, academy()));
  await a.finishVideo(OWNER_A);
  a.store.settings.monthlyCapPence = 0;
  const w = await a.engine.changeVoice({ ownerId: OWNER_A, voiceKey: 'olivia', expectedVersion: m.version });
  assert.ok(!w.ok && w.code === 'monthly_cap', JSON.stringify(w));
});

test('settings and the default values the cap relies on', () => {
  assert.equal(DEFAULT_AD_PACK_SETTINGS.ldRoundDays, 30);
  assert.equal(DEFAULT_AD_PACK_SETTINGS.ldMonthlyCapPence, 25000);
});

// ── Source pins ──

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the live store filters the month by route through the pack, and uses a grant only while it is unused', () => {
  const server = strip(read('./store-server.ts'));
  assert.match(server, /select\('cost_pence, ad_packs!inner\(route\)'\)\.eq\('ad_packs\.route', route\)/);
  assert.match(server, /update\(\{ used_at: atIso \}\)\.eq\('id', grantId\)\.eq\('owner_id', ownerId\)\.is\('used_at', null\)/);
  assert.match(server, /listUnusedRoundGrants/);
  assert.match(server, /\.eq\('by', 'operator'\)/);
});

test('the generator reads each route’s own month and the render worker does the same', () => {
  const core = strip(read('./generate-core.ts'));
  assert.equal((core.match(/monthSpendPence\(monthStartIso\([^)]*\), route\)/g) ?? []).length, 2, 'generatePack and capRefusal both pass the route');
  assert.match(core, /useRoundGrant\(ownerId, grantId, nowIso\)/);
  assert.ok(core.indexOf('status === \'preview\'') < core.indexOf('useRoundGrant('), 'the grant is used only after the round has succeeded');
  const render = strip(read('./render-core.ts'));
  assert.match(render, /monthSpendPence\(monthStartIso\(deps\.now\(\)\), pack\.route\)/);
});
