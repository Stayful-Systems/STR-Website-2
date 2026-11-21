import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adSheetAdminRunner, NOT_ALLOWED, type AdSheetAdminDeps } from './admin-run.ts';
import { buildAdSheetsAdminView, guideStatus, GUIDE_DUE_DAYS, type AdSheetLinkInput } from './admin-view.ts';
import type { ImportResult } from './import.ts';

/**
 * Batch 35 phase 10: the admin's ad sheet table and actions, on spies and fakes
 * (no database, no network, no Google).
 */

const ADMIN = { email: 'zac@stayful.co.uk' };
const LINK_A = '3f9a2c11-1111-4111-8111-111111111111';
const LINK_B = '7b1d4e22-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-21T12:00:00.000Z');

// Recognisable row contents: none of these may appear in anything returned.
const LEAK = ['Priya Natarajan', 'priya.natarajan@leaky.example', '07700900123', 'NG7 2RD', 'two beds near the canal'];

function importResult(dry: boolean): ImportResult {
  // The engine's own result type has counts and a code only; the extra fields (and a hostile code) stand in for a bug that lets row contents through.
  const link = {
    linkId: LINK_A, ok: true, code: 'ok', rowsRead: 12, alreadySaved: 4, saved: 8, imported: 5, merged: 1, incomplete: 1, test: 1, foreign: 0, untagged: 2, activated: false, columnsChanged: false,
    name: LEAK[0], email: LEAK[1], phone: LEAK[2], postcode: LEAK[3], answers: { note: LEAK[4] },
  };
  const bad = { ...link, linkId: LINK_B, code: `${LEAK[1]} ${LEAK[0]}`, ok: false, saved: 0 };
  return { ok: true, code: 'ok', dry, links: [link, bad] as unknown as ImportResult['links'] };
}

interface Spies {
  imports: { dry: boolean; linkId?: string }[];
  disconnects: string[];
  checked: string[];
  reads: string[];
  audits: string[];
}

function harness(opts: { user?: { email?: string | null } | null; state?: string | null } = {}): { runner: ReturnType<typeof adSheetAdminRunner>; spies: Spies } {
  const spies: Spies = { imports: [], disconnects: [], checked: [], reads: [], audits: [] };
  const deps: AdSheetAdminDeps = {
    currentUser: async () => (opts.user === undefined ? ADMIN : opts.user),
    runImport: async (o) => {
      spies.imports.push(o);
      return importResult(o.dry);
    },
    readLink: async (id) => {
      spies.reads.push(id);
      return opts.state === null ? null : { id, state: opts.state ?? 'active' };
    },
    disconnect: async (id) => {
      spies.disconnects.push(id);
      return true;
    },
    markGuideChecked: async (iso) => {
      spies.checked.push(iso);
    },
    now: () => NOW,
    audit: (l) => spies.audits.push(l),
  };
  return { runner: adSheetAdminRunner(deps), spies };
}

function assertNoLeak(value: unknown): void {
  const text = JSON.stringify(value);
  for (const s of LEAK) assert.ok(!text.includes(s), `leaked: ${s}`);
}

// ── Admin only ──

test('a non-admin, a signed-out visitor and an email-less user are refused by every action before anything runs', async () => {
  for (const user of [{ email: 'landlord@example.com' }, null, { email: null }, {}]) {
    const { runner, spies } = harness({ user });
    const results = [
      await runner.importRun({ dry: true }),
      await runner.importRun({ dry: false, linkId: LINK_A }),
      await runner.disconnect({ linkId: LINK_A, dry: true }),
      await runner.disconnect({ linkId: LINK_A, dry: false }),
      await runner.markGuideChecked({ dry: true }),
      await runner.markGuideChecked({ dry: false }),
    ];
    for (const r of results) assert.deepEqual(r, { ok: false, message: NOT_ALLOWED, lines: [] });
    assert.deepEqual(spies, { imports: [], disconnects: [], checked: [], reads: [], audits: [] });
  }
});

test('a bad link id is refused for an admin and nothing runs', async () => {
  const { runner, spies } = harness();
  assert.equal((await runner.importRun({ dry: false, linkId: 'not-a-uuid' })).ok, false);
  assert.equal((await runner.disconnect({ linkId: "x'; drop table", dry: false })).ok, false);
  assert.deepEqual(spies.imports, []);
  assert.deepEqual(spies.disconnects, []);
});

// ── Dry runs write nothing ──

test('import: the dry flag reaches the engine as given, and the link id too', async () => {
  const { runner, spies } = harness();
  await runner.importRun({ dry: true });
  await runner.importRun({ dry: false, linkId: LINK_A });
  assert.deepEqual(spies.imports, [{ dry: true }, { dry: false, linkId: LINK_A }]);
});

test('disconnect dry run says what would change and writes nothing', async () => {
  const { runner, spies } = harness({ state: 'active' });
  const r = await runner.disconnect({ linkId: LINK_A, dry: true });
  assert.equal(r.ok, true);
  assert.match(r.lines.join(' '), /Active → Disconnected/);
  assert.match(r.lines.join(' '), /kept/);
  assert.deepEqual(spies.disconnects, []);
  assert.deepEqual(spies.audits, []);
});

test('disconnect run writes once; an already disconnected or missing link writes nothing', async () => {
  const live = harness({ state: 'waiting_test_row' });
  const r = await live.runner.disconnect({ linkId: LINK_A, dry: false });
  assert.equal(r.ok, true);
  assert.deepEqual(live.spies.disconnects, [LINK_A]);

  const done = harness({ state: 'disconnected' });
  assert.equal((await done.runner.disconnect({ linkId: LINK_A, dry: false })).ok, true);
  assert.deepEqual(done.spies.disconnects, []);

  const missing = harness({ state: null });
  assert.equal((await missing.runner.disconnect({ linkId: LINK_A, dry: false })).ok, false);
  assert.deepEqual(missing.spies.disconnects, []);
});

test('mark checked: dry writes nothing, run writes now', async () => {
  const dry = harness();
  const d = await dry.runner.markGuideChecked({ dry: true });
  assert.equal(d.ok, true);
  assert.deepEqual(dry.spies.checked, []);

  const run = harness();
  await run.runner.markGuideChecked({ dry: false });
  assert.deepEqual(run.spies.checked, [NOW.toISOString()]);
});

test('an engine that is not configured is reported plainly, with no lines', async () => {
  const runner = adSheetAdminRunner({
    currentUser: async () => ADMIN,
    runImport: async (o) => ({ ok: false, code: 'not_configured', dry: o.dry, links: [] }),
    readLink: async () => null,
    disconnect: async () => false,
    markGuideChecked: async () => {},
  });
  const r = await runner.importRun({ dry: true });
  assert.equal(r.ok, false);
  assert.match(r.message, /not available yet/);
});

// ── No row contents anywhere ──

test('import output carries counts and codes only: no name, email, phone, postcode or answer', async () => {
  for (const dry of [true, false]) {
    const { runner, spies } = harness();
    const r = await runner.importRun({ dry });
    assert.equal(r.ok, true);
    assert.equal(r.lines.length, 2);
    assert.match(r.lines[0], /read 12, already saved 4/);
    // A code that is not a short token is shown as 'error'.
    assert.match(r.lines[1], /code error/);
    assertNoLeak(r);
    assertNoLeak(spies.audits);
  }
});

test('the view built from link rows never carries more than state, counts, dates and a safe code', () => {
  const links = [
    { id: LINK_A, ownerId: 'o1', state: 'active', lastRowRead: 31, lastImportAt: '2026-11-21T10:00:00Z', lastErrorCode: 'not_shared', untaggedCount: 3, rowsImported: 27, columnsChangedAt: '2026-11-01T00:00:00Z', answers: { n: LEAK[0] }, name: LEAK[0], email: LEAK[1] },
    { id: LINK_B, ownerId: 'o2', state: 'disconnected', lastRowRead: 4, lastImportAt: null, lastErrorCode: `${LEAK[1]}`, untaggedCount: 0, rowsImported: 4, columnsChangedAt: null },
  ] as unknown as AdSheetLinkInput[];
  const owners = new Map([['o1', { company: 'Brightstone Stays', email: 'ops@brightstone.example' }]]);
  const view = buildAdSheetsAdminView({ links, owners, switchOn: true, guideCheckedAt: null, now: NOW });
  assert.equal(view.rows.length, 2);
  assert.equal(view.rows[0].ownerLabel, 'Brightstone Stays · ops@brightstone.example');
  assert.equal(view.rows[0].errorCode, 'not_shared');
  assert.equal(view.rows[0].canImport, true);
  assert.equal(view.rows[1].errorCode, 'error');
  assert.equal(view.rows[1].canDisconnect, false);
  assert.equal(view.rows[1].ownerLabel, 'Unknown operator');
  assert.equal(view.switchOn, true);
  assertNoLeak(view);
});

// ── Guide checked ──

test('guide screenshots are due when never checked, not at 29 days, due at 31', () => {
  const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
  assert.equal(GUIDE_DUE_DAYS, 30);
  assert.deepEqual(guideStatus(null, NOW), { checkedAt: null, due: true });
  assert.deepEqual(guideStatus('garbage', NOW), { checkedAt: null, due: true });
  assert.equal(guideStatus(ago(29), NOW).due, false);
  assert.equal(guideStatus(ago(30), NOW).due, false);
  assert.equal(guideStatus(ago(31), NOW).due, true);
  assert.equal(guideStatus(ago(0), NOW).due, false);
});

// ── Source pins ──

test('the page and its loader never read the rows table or any answers', () => {
  for (const file of ['src/lib/ad-sheets/admin-server.ts', 'src/app/admin/ad-sheets/page.tsx', 'src/app/admin/ad-sheets/AdSheetsPanel.tsx', 'src/lib/ad-sheets/admin-view.ts']) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/ad_sheet_rows/.test(src), `${file} must not touch ad_sheet_rows`);
    assert.ok(!/answers/.test(src), `${file} must not select answers`);
    assert.ok(!/from\(\s*['"]leads['"]/.test(src), `${file} must not read leads`);
  }
});

test('every action module handler fixes its dry flag on the server', () => {
  const src = readFileSync('src/app/admin/ad-sheets/actions.ts', 'utf8');
  assert.match(src, /importRun\(\{ dry: true, linkId \}\)/);
  assert.match(src, /importRun\(\{ dry: false, linkId \}\)/);
  assert.match(src, /disconnect\(\{ linkId, dry: true \}\)/);
  assert.match(src, /disconnect\(\{ linkId, dry: false \}\)/);
  assert.ok(!/leads\.status|crm_pushed_at/.test(src));
});
