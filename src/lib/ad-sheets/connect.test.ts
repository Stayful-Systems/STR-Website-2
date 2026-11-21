import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleSheetsError } from './google.ts';
import type { SheetTab } from './google.ts';
import { FIXTURE_HEADERS } from './fixtures.ts';
import { adMode, checkSheetOp, connectSheetOp, disconnectSheetOp, readNowOp, statusOfLink, type ConnectDeps, type ConnectStore, type SaveLink, type Session, type SheetLinkRecord } from './connect.ts';
import { NOT_AVAILABLE, SHEET_MESSAGES, headersMissingMessage } from './messages.ts';

const A = '3f9a2c11-1111-4111-8111-111111111111';
const B = '3f9a2c22-2222-4222-8222-222222222222';
const ID_A = 'sheetAAAAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'sheetBBBBBBBBBBBBBBBBBBBBBBBB';
const urlOf = (id: string, gid = 0) => `https://docs.google.com/spreadsheets/d/${id}/edit?gid=${gid}#gid=${gid}`;
const SA = 'intelligence@project.iam.gserviceaccount.com';

type Rec = { ownerId: string; kind: string; extras: Record<string, string | number>; dedupeKey: string };

function setup(opts: { who?: Session; sheets?: Record<string, { tabs: SheetTab[]; header: string[]; fail?: string }>; email?: string | null; switches?: { adPacksEnabled: boolean; sheetsEnabled: boolean }; approved?: boolean } = {}) {
  let who: Session = opts.who ?? { ok: true, ownerId: A, email: 'a@example.test', admin: false };
  let switches = opts.switches ?? { adPacksEnabled: true, sheetsEnabled: true };
  let approved = opts.approved ?? true;
  const sheets = opts.sheets ?? { [ID_A]: { tabs: [{ gid: 0, title: 'Leads' }], header: FIXTURE_HEADERS } };
  const links = new Map<string, SheetLinkRecord>();
  const records: Rec[] = [];
  const calls = { google: 0, imports: [] as string[], saves: [] as { ownerId: string; row: SaveLink }[] };
  let seq = 0;

  const store: ConnectStore = {
    async getByOwner(ownerId) {
      return links.get(ownerId) ?? null;
    },
    async ownerOfSpreadsheet(id) {
      return [...links.values()].find((l) => l.spreadsheetId === id)?.ownerId ?? null;
    },
    async save(ownerId, row) {
      calls.saves.push({ ownerId, row });
      // The unique constraint on the sheet: another owner's row there refuses.
      if ([...links.values()].some((l) => l.spreadsheetId === row.spreadsheetId && l.ownerId !== ownerId)) return { ok: false, code: 'taken' };
      const prev = links.get(ownerId);
      const link: SheetLinkRecord = { id: prev?.id ?? `link-${++seq}`, ownerId, spreadsheetId: row.spreadsheetId, tabGid: row.tabGid, tabTitle: row.tabTitle, state: 'waiting_test_row', activatedAt: null, lastErrorCode: null };
      links.set(ownerId, link);
      return { ok: true, link };
    },
    async disconnect(ownerId) {
      const l = links.get(ownerId);
      if (l) links.set(ownerId, { ...l, state: 'disconnected' });
      return true;
    },
  };

  const deps: ConnectDeps = {
    session: async () => who,
    switches: async () => switches,
    packApproved: async () => approved,
    store,
    google: {
      serviceAccountEmail: () => (opts.email === undefined ? SA : opts.email),
      async sheetMeta(id) {
        calls.google++;
        const s = sheets[id];
        if (!s) throw new GoogleSheetsError('not_found');
        if (s.fail) throw new GoogleSheetsError(s.fail as 'not_shared');
        return s.tabs;
      },
      async readRange(id) {
        calls.google++;
        const s = sheets[id];
        if (!s) throw new GoogleSheetsError('not_found');
        return [s.header];
      },
    },
    importNow: async (linkId) => {
      calls.imports.push(linkId);
    },
    record: async (ownerId, kind, o) => {
      records.push({ ownerId, kind, ...o });
    },
    now: () => new Date('2026-11-21T10:00:00Z'),
  };
  return {
    deps,
    links,
    records,
    calls,
    sheets,
    setWho: (w: Session) => (who = w),
    setSwitches: (s: { adPacksEnabled: boolean; sheetsEnabled: boolean }) => (switches = s),
    setApproved: (v: boolean) => (approved = v),
    /** What the import does when it reads a test row. */
    activate: (ownerId: string) => {
      const l = links.get(ownerId)!;
      links.set(ownerId, { ...l, state: 'active', activatedAt: '2026-11-21T10:05:00.000Z' });
    },
  };
}

test('connect: the owner pastes a shared sheet; the link is saved as waiting for a test row, still in website mode', async () => {
  const w = setup();
  const out = await connectSheetOp(w.deps, { link: urlOf(ID_A) });
  assert.equal(out.ok, true);
  assert.equal(out.status?.state, 'waiting_test_row');
  assert.equal(out.status?.mode, 'website');
  assert.equal(out.status?.shared, true);
  assert.equal(out.status?.headersFound, true);
  assert.equal(out.status?.testRowRead, false);
  const row = w.calls.saves[0].row;
  assert.equal(w.calls.saves[0].ownerId, A);
  assert.equal(row.spreadsheetId, ID_A);
  assert.equal(row.tabGid, '0');
  assert.equal(row.tabTitle, 'Leads');
  assert.match(row.headerHash, /^[0-9a-f]{64}$/);
  assert.equal(row.connectedAt, '2026-11-21T10:00:00.000Z');
  // Nothing about the sheet reaches the screen.
  assert.ok(!JSON.stringify(out).includes(ID_A));
});

test('a team member is refused before anything is read or saved', async () => {
  const w = setup({ who: { ok: false, reason: 'member' } });
  const out = await connectSheetOp(w.deps, { link: urlOf(ID_A) });
  assert.equal(out.ok, undefined);
  assert.equal(out.error, SHEET_MESSAGES.member);
  assert.equal(w.calls.google, 0);
  assert.equal(w.calls.saves.length, 0);
  for (const op of [() => disconnectSheetOp(w.deps), () => readNowOp(w.deps)]) assert.equal((await op()).error, SHEET_MESSAGES.member);
  assert.equal((await checkSheetOp(w.deps)).available, false);
  assert.equal(w.calls.imports.length, 0);
});

test('signed out is refused too', async () => {
  const w = setup({ who: { ok: false, reason: 'signed_out' } });
  assert.equal((await connectSheetOp(w.deps, { link: urlOf(ID_A) })).error, SHEET_MESSAGES.signed_out);
});

test('a sheet already linked to another owner is refused, without saying whose, and Google is not asked', async () => {
  const w = setup({ sheets: { [ID_A]: { tabs: [{ gid: 0, title: 'Leads' }], header: FIXTURE_HEADERS } } });
  w.links.set(B, { id: 'link-b', ownerId: B, spreadsheetId: ID_A, tabGid: '0', tabTitle: 'Leads', state: 'active', activatedAt: 'x', lastErrorCode: null });
  const out = await connectSheetOp(w.deps, { link: urlOf(ID_A) });
  assert.equal(out.error, SHEET_MESSAGES.taken);
  assert.ok(!out.error?.includes(B));
  assert.equal(w.calls.google, 0);
  assert.equal(w.calls.saves.length, 0);
  assert.equal(w.links.get(B)?.state, 'active', 'the other owner is untouched');
});

test('the database constraint on the sheet gives the same message (a race past the first check)', async () => {
  const w = setup();
  // Another owner's link appears between the check and the save.
  const realSave = w.deps.store.save;
  w.deps.store.save = async (o, r) => {
    w.links.set(B, { id: 'link-b', ownerId: B, spreadsheetId: ID_A, tabGid: '0', tabTitle: 'Leads', state: 'waiting_test_row', activatedAt: null, lastErrorCode: null });
    return realSave(o, r);
  };
  const out = await connectSheetOp(w.deps, { link: urlOf(ID_A) });
  assert.equal(out.error, SHEET_MESSAGES.taken);
});

test('not shared, not found, rate limited and other Google trouble each say the right thing', async () => {
  for (const [fail, want] of [['not_shared', SHEET_MESSAGES.not_shared], ['not_found', SHEET_MESSAGES.not_found], ['rate_limited', SHEET_MESSAGES.rate_limited], ['error', SHEET_MESSAGES.error], ['not_configured', NOT_AVAILABLE]] as const) {
    const w = setup({ sheets: { [ID_A]: { tabs: [], header: [], fail } } });
    const out = await connectSheetOp(w.deps, { link: urlOf(ID_A) });
    assert.equal(out.error, want, fail);
    assert.equal(w.calls.saves.length, 0, fail);
  }
  assert.match(SHEET_MESSAGES.not_shared, /Share it with the email address/);
  assert.match(SHEET_MESSAGES.rate_limited, /try again/);
});

test('a sheet we have never heard of (a 404) is "not found", and a bad link is a bad link', async () => {
  const w = setup();
  assert.equal((await connectSheetOp(w.deps, { link: urlOf(ID_B) })).error, SHEET_MESSAGES.not_found);
  for (const bad of ['', 'not a link', 'https://example.com/spreadsheets/d/' + ID_A, 'http://docs.google.com/spreadsheets/d/' + ID_A, 42, undefined]) {
    assert.equal((await connectSheetOp(w.deps, { link: bad })).error, SHEET_MESSAGES.bad_link, String(bad));
  }
  assert.equal(w.calls.saves.length, 0);
});

test('headers: missing columns are listed in plain English; an empty first row has its own message; no save either way', async () => {
  const w = setup({ sheets: { [ID_A]: { tabs: [{ gid: 0, title: 'Leads' }], header: ['id', 'created_time', 'full_name', 'email'] } } });
  const out = await connectSheetOp(w.deps, { link: urlOf(ID_A) });
  assert.equal(out.error, headersMissingMessage(['postcode']));
  assert.match(out.error ?? '', /postcode column/);
  assert.ok(!/postcode_or|phone_or_email/.test(out.error ?? ''), 'never a code');
  const w2 = setup({ sheets: { [ID_A]: { tabs: [{ gid: 0, title: 'Leads' }], header: ['id', 'created_time'] } } });
  assert.match((await connectSheetOp(w2.deps, { link: urlOf(ID_A) })).error ?? '', /a name column, a phone number or email column and a postcode column/);
  const w3 = setup({ sheets: { [ID_A]: { tabs: [{ gid: 0, title: 'Leads' }], header: ['', ''] } } });
  assert.equal((await connectSheetOp(w3.deps, { link: urlOf(ID_A) })).error, SHEET_MESSAGES.no_headers);
  assert.equal(w.calls.saves.length + w2.calls.saves.length + w3.calls.saves.length, 0);
});

test('the tab in the link is the one saved; a tab that is not there is refused', async () => {
  const w = setup({ sheets: { [ID_A]: { tabs: [{ gid: 0, title: 'Notes' }, { gid: 77, title: 'Form 1' }], header: FIXTURE_HEADERS } } });
  assert.equal((await connectSheetOp(w.deps, { link: urlOf(ID_A, 99) })).error, SHEET_MESSAGES.tab_not_found);
  const out = await connectSheetOp(w.deps, { link: urlOf(ID_A, 77) });
  assert.equal(out.ok, true);
  assert.equal(w.calls.saves[0].row.tabGid, '77');
  assert.equal(w.calls.saves[0].row.tabTitle, 'Form 1');
});

test('not configured on our side: the screen says so and nothing is read', async () => {
  const w = setup({ email: null });
  assert.equal((await connectSheetOp(w.deps, { link: urlOf(ID_A) })).error, 'Lead form link not available yet');
  assert.equal(w.calls.google, 0);
  assert.equal((await checkSheetOp(w.deps)).serviceEmail, null);
});

test('only with both switches on (an admin previewing skips them) and an approved pack', async () => {
  const w = setup({ switches: { adPacksEnabled: true, sheetsEnabled: false } });
  assert.equal((await connectSheetOp(w.deps, { link: urlOf(ID_A) })).error, NOT_AVAILABLE);
  assert.equal((await checkSheetOp(w.deps)).available, false);
  w.setSwitches({ adPacksEnabled: false, sheetsEnabled: true });
  assert.equal((await connectSheetOp(w.deps, { link: urlOf(ID_A) })).error, NOT_AVAILABLE);
  w.setWho({ ok: true, ownerId: A, email: null, admin: true });
  assert.equal((await connectSheetOp(w.deps, { link: urlOf(ID_A) })).ok, true);
  w.setApproved(false);
  assert.equal((await connectSheetOp(w.deps, { link: urlOf(ID_A) })).error, SHEET_MESSAGES.no_pack);
  assert.equal((await checkSheetOp(w.deps)).available, false);
});

test('mode stays website until a row is read, and becomes lead-form only when the link is active', async () => {
  const w = setup();
  assert.equal((await checkSheetOp(w.deps)).mode, 'website', 'no link yet');
  await connectSheetOp(w.deps, { link: urlOf(ID_A) });
  let s = await checkSheetOp(w.deps, { watching: true });
  assert.equal(s.state, 'waiting_test_row');
  assert.equal(s.mode, 'website');
  assert.equal(s.testRowRead, false);
  assert.equal(w.records.length, 0, 'nothing logged while waiting');
  // The import reads a test row.
  w.activate(A);
  s = await checkSheetOp(w.deps, { watching: true });
  assert.equal(s.state, 'active');
  assert.equal(s.mode, 'lead_form');
  assert.equal(s.testRowRead, true);
  assert.equal(w.records.length, 1);
  assert.equal(w.records[0].kind, 'ad_sheet_connected');
  assert.deepEqual(w.records[0].extras, { link: 'link-1' });
  assert.ok(!JSON.stringify(w.records).includes(ID_A), 'the sheet id is never logged');
  // A page load that was not watching does not log again; a repeat poll carries the same key.
  await checkSheetOp(w.deps);
  assert.equal(w.records.length, 1);
  await checkSheetOp(w.deps, { watching: true });
  assert.equal(w.records[1].dedupeKey, w.records[0].dedupeKey);
});

test('check is read only: no Google call and no save', async () => {
  const w = setup();
  await connectSheetOp(w.deps, { link: urlOf(ID_A) });
  const before = { g: w.calls.google, s: w.calls.saves.length };
  await checkSheetOp(w.deps);
  assert.deepEqual({ g: w.calls.google, s: w.calls.saves.length }, before);
});

test('check now runs the import for the owner\'s own link only, and ticks only when the link is then active', async () => {
  const w = setup();
  await connectSheetOp(w.deps, { link: urlOf(ID_A) });
  const none = await readNowOp(w.deps);
  assert.deepEqual(w.calls.imports, ['link-1']);
  assert.equal(none.status?.testRowRead, false);
  assert.match(none.notice ?? '', /No test lead yet/);
  w.deps.importNow = async (id) => {
    w.calls.imports.push(id);
    w.activate(A);
  };
  const got = await readNowOp(w.deps);
  assert.equal(got.status?.mode, 'lead_form');
  assert.equal(got.status?.testRowRead, true);
  assert.equal(w.records.length, 1);
  // No link, nothing to read.
  const w2 = setup();
  assert.ok((await readNowOp(w2.deps)).error);
  assert.equal(w2.calls.imports.length, 0);
});

test('disconnect returns to website mode and keeps the row; the owner can then reconnect, which resets to waiting', async () => {
  const w = setup();
  await connectSheetOp(w.deps, { link: urlOf(ID_A) });
  w.activate(A);
  assert.equal((await checkSheetOp(w.deps)).mode, 'lead_form');
  const out = await disconnectSheetOp(w.deps);
  assert.equal(out.ok, true);
  assert.equal(out.status?.state, 'disconnected');
  assert.equal(out.status?.mode, 'website');
  assert.equal(out.status?.shared, false);
  assert.equal(w.links.get(A)?.spreadsheetId, ID_A, 'the link row stays');
  assert.equal((await checkSheetOp(w.deps)).mode, 'website');
  const again = await connectSheetOp(w.deps, { link: urlOf(ID_A) });
  assert.equal(again.status?.state, 'waiting_test_row');
  assert.equal(again.status?.mode, 'website');
  assert.equal(w.links.get(A)?.state, 'waiting_test_row');
});

test('disconnect needs only the owner: switches off or an unapproved pack never trap a link on', async () => {
  const w = setup();
  await connectSheetOp(w.deps, { link: urlOf(ID_A) });
  w.setSwitches({ adPacksEnabled: false, sheetsEnabled: false });
  w.setApproved(false);
  assert.equal((await disconnectSheetOp(w.deps)).ok, true);
});

test('a link whose sheet stopped being shared shows no green tick and says what to do; mode is website', () => {
  const link: SheetLinkRecord = { id: 'l', ownerId: A, spreadsheetId: ID_A, tabGid: '0', tabTitle: 'Leads', state: 'error', activatedAt: null, lastErrorCode: 'not_shared' };
  const s = statusOfLink(link, SA);
  assert.equal(s.shared, false);
  assert.equal(s.mode, 'website');
  assert.equal(s.problem, SHEET_MESSAGES.not_shared);
  assert.equal(adMode('error'), 'website');
  assert.equal(adMode('waiting_test_row'), 'website');
  assert.equal(adMode('disconnected'), 'website');
  assert.equal(adMode('none'), 'website');
  assert.equal(adMode('active'), 'lead_form');
});

test('the status never carries an id, a sheet address or a cell', async () => {
  const w = setup();
  const out = await connectSheetOp(w.deps, { link: urlOf(ID_A) });
  const text = JSON.stringify(out);
  assert.ok(!text.includes(ID_A) && !text.includes('link-1') && !text.includes(A));
});

test('the six steps: one action each, a Stuck line, a screenshot name, UK plain English, no figure and no em dash', async () => {
  const { SHEET_STEPS, sheetShotUrl } = await import('./messages.ts');
  assert.deepEqual(SHEET_STEPS.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
  for (const s of SHEET_STEPS) {
    assert.ok(s.action.length > 10 && s.stuck.length > 20 && s.shotAlt.length > 5, String(s.n));
    assert.ok(!/—/.test(`${s.title}${s.action}${s.detail}${s.stuck}`), `em dash in step ${s.n}`);
    assert.ok(!/£|\d+%/.test(`${s.action}${s.detail}${s.stuck}`), `figure in step ${s.n}`);
  }
  assert.equal(sheetShotUrl(3), '/ad-packs/guide/sheet-3.png');
});
