import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequestsEngine, type EmailOutcome, type RequestRow, type RequestStore, type RequestsDeps, type UploadOutcome } from './edit-requests-server.ts';
import type { RequestStatus } from './edit-requests.ts';

const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const SITE_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SECRET_TEXT = 'Please move my phone number to the footer and mention 12 Acacia Avenue';

function setup(over: { upload?: UploadOutcome; sendClosed?: EmailOutcome | (() => EmailOutcome); admins?: string[]; ownerEmails?: Record<string, string | null> } = {}) {
  const rows = new Map<string, RequestRow>();
  const calls = { admin: [] as { to: string; id: string; hasScreenshot: boolean }[], closed: [] as { to: string | null; id: string; status: string; note: string | null }[], logs: [] as string[], activity: [] as string[], uploads: [] as string[], writes: 0 };
  let n = 0;
  const store: RequestStore = {
    async insert(r) {
      calls.writes++;
      const row: RequestRow = { id: r.id, websiteId: r.websiteId, ownerId: r.ownerId, body: r.body, screenshotPath: null, status: 'new', adminNotes: null, createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:00:00Z', closedAt: null, closedEmailedAt: null };
      rows.set(r.id, row);
      return { ...row };
    },
    async setScreenshot(id, path) {
      const row = rows.get(id);
      if (!row) return false;
      row.screenshotPath = path;
      return true;
    },
    async listForOwner(ownerId) {
      return [...rows.values()].filter((r) => r.ownerId === ownerId).map((r) => ({ ...r }));
    },
    async list({ openOnly }) {
      return [...rows.values()].filter((r) => !openOnly || r.status === 'new' || r.status === 'in_progress').map((r) => ({ ...r }));
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async move(id, from, patch) {
      const row = rows.get(id);
      if (!row || row.status !== from) return null;
      row.status = patch.status;
      row.closedAt = patch.closedAt;
      if (patch.adminNotes !== undefined) row.adminNotes = patch.adminNotes;
      return { ...row };
    },
    async setNotes(id, notes) {
      const row = rows.get(id);
      if (!row) return null;
      row.adminNotes = notes;
      return { ...row };
    },
    async claimClosedEmail(id) {
      const row = rows.get(id);
      if (!row || row.closedEmailedAt !== null || (row.status !== 'done' && row.status !== 'declined')) return false;
      row.closedEmailedAt = '2026-11-20T11:00:00Z';
      return true;
    },
    async releaseClosedEmail(id) {
      const row = rows.get(id);
      if (row) row.closedEmailedAt = null;
    },
    async openRows() {
      return [...rows.values()].filter((r) => r.status === 'new' || r.status === 'in_progress').map((r) => ({ websiteId: r.websiteId, status: r.status as RequestStatus }));
    },
  };
  const deps: RequestsDeps = {
    store,
    async uploadScreenshot(path) {
      calls.uploads.push(path);
      return over.upload ?? 'ok';
    },
    async signScreenshot(path, seconds) {
      return `https://signed.example/${path}?ttl=${seconds}`;
    },
    async companyName() {
      return 'Harbour Lets';
    },
    async ownerEmail(ownerId) {
      return over.ownerEmails ? (over.ownerEmails[ownerId] ?? null) : 'owner@example.test';
    },
    adminAddresses: () => over.admins ?? ['one@example.test', 'two@example.test'],
    async sendAdmin(to, id, data) {
      calls.admin.push({ to, id, hasScreenshot: data.hasScreenshot });
      return { sent: true };
    },
    async sendClosed(to, id, data) {
      calls.closed.push({ to, id, status: data.status, note: data.adminNote });
      const r = typeof over.sendClosed === 'function' ? over.sendClosed() : over.sendClosed;
      return r ?? { sent: true };
    },
    recordRequested(ownerId, id) {
      calls.activity.push(`${ownerId}:website_change_requested:${id}`);
    },
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => new Date('2026-11-20T12:00:00Z'),
    log: (line) => calls.logs.push(line),
  };
  return { engine: createRequestsEngine(deps), deps, calls, rows };
}

test('an empty or over-long request is refused and nothing is written, sent or recorded', async () => {
  const { engine, calls } = setup();
  for (const body of ['', '   ', null, 'x'.repeat(2001)]) {
    const r = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body });
    assert.equal(r.ok, false);
  }
  assert.equal(calls.writes, 0);
  assert.deepEqual(calls.admin, []);
  assert.deepEqual(calls.activity, []);
});

test('a request is stored, recorded (record-only kind) and emailed to every admin address once each', async () => {
  const { engine, calls, rows } = setup();
  const r = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: SECRET_TEXT });
  assert.ok(r.ok);
  assert.equal(r.ok && r.screenshot, 'none');
  assert.equal(rows.size, 1);
  assert.deepEqual(calls.activity, [`${OWNER_A}:website_change_requested:${r.ok ? r.id : ''}`]);
  assert.deepEqual(calls.admin.map((a) => a.to), ['one@example.test', 'two@example.test']);
  assert.ok(calls.admin.every((a) => a.id === (r.ok ? r.id : '') && a.hasScreenshot === false));
});

test('a screenshot is stored at <owner>/<id>.png and the path is saved on the request', async () => {
  const { engine, calls, rows } = setup();
  const r = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: 'Look at this', screenshot: PNG });
  assert.ok(r.ok && r.screenshot === 'saved');
  const id = r.ok ? r.id : '';
  assert.deepEqual(calls.uploads, [`${OWNER_A}/${id}.png`]);
  assert.equal(rows.get(id)?.screenshotPath, `${OWNER_A}/${id}.png`);
  assert.equal(calls.admin[0].hasScreenshot, true);
});

test('a missing bucket: the text still sends and the screenshot is refused with a plain message', async () => {
  const { engine, calls, rows } = setup({ upload: 'bucket_missing' });
  const r = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: 'Look at this', screenshot: PNG });
  assert.ok(r.ok);
  assert.equal(r.ok && r.screenshot, 'refused');
  assert.match(r.ok ? (r.screenshotMessage ?? '') : '', /not set up/);
  assert.equal(rows.size, 1, 'the request is kept');
  assert.equal([...rows.values()][0].screenshotPath, null);
  assert.equal(calls.admin.length, 2, 'the admins are still told');
  assert.equal(calls.admin[0].hasScreenshot, false);
});

test('a bad screenshot (not an image, or too big) never stops the text', async () => {
  const { engine, calls } = setup();
  const svg = new TextEncoder().encode('<svg></svg>');
  const a = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: 'Hello', screenshot: svg });
  assert.ok(a.ok && a.screenshot === 'refused');
  const big = new Uint8Array(1024 * 1024);
  big.set(PNG);
  const b = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: 'Hello again', screenshot: big });
  assert.ok(b.ok && b.screenshot === 'refused');
  assert.deepEqual(calls.uploads, [], 'nothing was uploaded');
  assert.equal(calls.admin.length, 4);
});

test("an operator can't read or change another's request: every operator path is scoped by owner", async () => {
  const { engine, rows } = setup();
  const a = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: 'A wants a change' });
  const b = await engine.createRequest({ ownerId: OWNER_B, websiteId: SITE_B, body: 'B wants a change' });
  assert.ok(a.ok && b.ok);
  const idA = a.ok ? a.id : '';
  const idB = b.ok ? b.id : '';
  assert.deepEqual((await engine.listOwn(OWNER_A)).map((r) => r.id), [idA]);
  assert.deepEqual((await engine.listOwn(OWNER_B)).map((r) => r.id), [idB]);
  assert.equal((await engine.getOwn(OWNER_A, idB)), null, "A cannot read B's request by id");
  assert.equal((await engine.getOwn(OWNER_B, idB))?.body, 'B wants a change');
  assert.equal((await engine.listOwn('cccccccc-cccc-4ccc-8ccc-cccccccccccc')).length, 0);
  // There is no operator-side way to change a request: the engine's only operator methods are these three.
  const operatorMethods = Object.keys(engine).filter((k) => !k.startsWith('admin') && k !== 'openCounts');
  assert.deepEqual(operatorMethods.sort(), ['createRequest', 'getOwn', 'listOwn']);
  assert.equal(rows.get(idA)?.status, 'new');
});

test('admin moves a request forward; a backward or final move is refused; the same status only saves the note', async () => {
  const { engine } = setup();
  const r = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: 'Please change X' });
  const id = r.ok ? r.id : '';
  const p = await engine.adminSetStatus({ id, status: 'in_progress', notes: 'Looking now' });
  assert.ok(p.ok && p.request.status === 'in_progress' && p.request.adminNotes === 'Looking now' && p.email === 'none');
  const back = await engine.adminSetStatus({ id, status: 'new' });
  assert.ok(!back.ok && back.reason === 'bad_transition');
  const same = await engine.adminSetStatus({ id, status: 'in_progress', notes: 'Still looking' });
  assert.ok(same.ok && same.request.adminNotes === 'Still looking' && same.email === 'none');
  const bad = await engine.adminSetStatus({ id, status: 'in_progress', notes: 'x'.repeat(2001) });
  assert.ok(!bad.ok && bad.reason === 'bad_notes');
  const done = await engine.adminSetStatus({ id, status: 'done' });
  assert.ok(done.ok && done.request.status === 'done' && done.request.closedAt === '2026-11-20T12:00:00.000Z');
  assert.equal(done.ok && done.request.adminNotes, 'Still looking', 'notes are kept when none are given');
  const final = await engine.adminSetStatus({ id, status: 'declined' });
  assert.ok(!final.ok && final.reason === 'bad_transition');
  const none = await engine.adminSetStatus({ id: 'nope', status: 'done' });
  assert.ok(!none.ok && none.reason === 'not_found');
});

test('the closed email is sent once, with the admin note, even if Done is pressed again or saved again', async () => {
  const { engine, calls } = setup();
  const r = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: SECRET_TEXT });
  const id = r.ok ? r.id : '';
  const done = await engine.adminSetStatus({ id, status: 'done', notes: 'Moved it to the footer.' });
  assert.ok(done.ok && done.email === 'sent');
  assert.deepEqual(calls.closed, [{ to: 'owner@example.test', id, status: 'done', note: 'Moved it to the footer.' }]);
  // Done again, a note edit, and a second admin racing: nothing more is sent.
  const again = await engine.adminSetStatus({ id, status: 'done' });
  assert.ok(again.ok && again.email === 'already');
  const edit = await engine.adminSetStatus({ id, status: 'done', notes: 'Edited note' });
  assert.ok(edit.ok && edit.email === 'already');
  await Promise.all([engine.adminSetStatus({ id, status: 'done' }), engine.adminSetStatus({ id, status: 'done' })]);
  assert.equal(calls.closed.length, 1);
});

test('declined sends the declined email; a failed send gives the claim back so saving again retries it, once', async () => {
  let ok = false;
  const { engine, calls } = setup({ sendClosed: () => (ok ? { sent: true } : { sent: false, reason: 'not_configured' }) });
  const r = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: 'Add a blog' });
  const id = r.ok ? r.id : '';
  const first = await engine.adminSetStatus({ id, status: 'declined', notes: 'Not something we offer.' });
  assert.ok(first.ok && first.email === 'failed');
  assert.equal(calls.closed[0].status, 'declined');
  ok = true;
  const retry = await engine.adminSetStatus({ id, status: 'declined' });
  assert.ok(retry.ok && retry.email === 'sent');
  const after = await engine.adminSetStatus({ id, status: 'declined' });
  assert.ok(after.ok && after.email === 'already');
  assert.equal(calls.closed.filter((c) => c.status === 'declined').length, 2, 'one failed attempt and one that went');
});

test('an owner with no email address: the claim is given back and nothing is lost', async () => {
  const { engine, calls } = setup({ ownerEmails: { [OWNER_A]: null }, sendClosed: { sent: false, reason: 'no_recipient' } });
  const r = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: 'Change' });
  const done = await engine.adminSetStatus({ id: r.ok ? r.id : '', status: 'done' });
  assert.ok(done.ok && done.email === 'failed');
  assert.equal(calls.closed[0].to, null);
});

test('an admin sees a screenshot through a 10-minute signed link, and only one of ours', async () => {
  const { engine, rows } = setup();
  const r = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: 'See', screenshot: PNG });
  const id = r.ok ? r.id : '';
  assert.equal(await engine.adminScreenshotUrl(id), `https://signed.example/${OWNER_A}/${id}.png?ttl=600`);
  const plain = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: 'No picture' });
  assert.equal(await engine.adminScreenshotUrl(plain.ok ? plain.id : ''), null);
  rows.get(id)!.screenshotPath = '../../etc/passwd';
  assert.equal(await engine.adminScreenshotUrl(id), null, 'a path of any other shape is never signed');
  assert.equal(await engine.adminScreenshotUrl('missing'), null);
});

test('open counts per website: new, and open (new + in progress)', async () => {
  const { engine } = setup();
  const a = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: 'one' });
  await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: 'two' });
  const b = await engine.createRequest({ ownerId: OWNER_B, websiteId: SITE_B, body: 'three' });
  await engine.adminSetStatus({ id: a.ok ? a.id : '', status: 'in_progress' });
  await engine.adminSetStatus({ id: b.ok ? b.id : '', status: 'done' });
  const counts = await engine.openCounts();
  assert.deepEqual(counts.get(SITE_A), { new: 1, open: 2 });
  assert.equal(counts.get(SITE_B), undefined);
  assert.equal((await engine.adminList({ openOnly: true })).length, 2);
  assert.equal((await engine.adminList()).length, 3);
});

test('log lines carry ids and codes only: never the request text, an address or a note', async () => {
  const { engine, calls } = setup({ upload: 'bucket_missing', sendClosed: { sent: false, reason: 'not_configured' } });
  const r = await engine.createRequest({ ownerId: OWNER_A, websiteId: SITE_A, body: SECRET_TEXT, screenshot: PNG });
  await engine.adminSetStatus({ id: r.ok ? r.id : '', status: 'done', notes: 'SECRET NOTE for the owner' });
  assert.ok(calls.logs.length >= 2, 'the degraded paths are logged');
  const joined = calls.logs.join('\n');
  assert.doesNotMatch(joined, /Acacia|phone number|SECRET NOTE|@example\.test/);
  for (const line of calls.logs) assert.match(line, /^website_request_[a-z_]+ /);
});

test('the live wiring: owner reads are filtered by owner_id, the closed email is claimed conditionally, and nothing logs a body', () => {
  const src = readFileSync(new URL('./edit-requests-store.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /import 'server-only'/);
  assert.match(code, /\.select\(COLUMNS\)\.eq\('owner_id', ownerId\)/);
  assert.match(code, /\.is\('closed_emailed_at', null\)\s*\.in\('status', \['done', 'declined'\]\)/);
  assert.match(code, /\.eq\('id', id\)\.eq\('status', from\)/);
  assert.match(code, /REQUEST_BUCKET/);
  // Logs: the table and an error code, never row data.
  for (const m of code.matchAll(/console\.(error|warn|log|info)\(([^)]*)\)/g)) assert.doesNotMatch(m[2], /body|notes|email|data\b/i, m[0]);
  assert.match(code, /website_change_requested/);
});
