import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quietCopy, runQuietCheck } from './quiet.ts';
import type { QuietLink, QuietStore } from './quiet.ts';

const DAY = 86_400_000;
const T0 = new Date('2026-11-01T10:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);

function link(over: Partial<QuietLink> = {}): QuietLink {
  return { id: 'l1', ownerId: 'o1', state: 'active', lastRowAt: T0.toISOString(), activatedAt: T0.toISOString(), quietEmailSentAt: null, ...over };
}

/** A store over a map of links; `taken` holds the days (UTC) whose slot another email already used. */
function fake(links: QuietLink[], opts: { days?: number; taken?: Set<string>; sendOk?: boolean } = {}) {
  const state = {
    links: new Map(links.map((l) => [l.id, { ...l }])),
    sends: [] as { to: string; subject: string; key: string }[],
    claims: 0,
    stamps: 0,
    logs: [] as string[],
    usedDays: new Set<string>(opts.taken ?? []),
  };
  const store: QuietStore = {
    quietDays: async () => opts.days ?? 7,
    activeLinks: async () => [...state.links.values()].filter((l) => l.state === 'active' && l.quietEmailSentAt === null),
    ownerEmail: async () => 'op@example.test',
    claimSlot: async (_u, _k, now) => {
      state.claims += 1;
      const day = now.toISOString().slice(0, 10);
      if (state.usedDays.has(day)) return { ok: false, reason: 'slot_used' };
      state.usedDays.add(day);
      return { ok: true, id: `c${state.claims}` };
    },
    releaseClaim: async () => {},
    markSending: async () => true,
    abandonSend: async (id) => {
      // The failed send gives the slot back.
      void id;
      state.usedDays.clear();
    },
    finishSend: async () => {},
    stamp: async (id, iso) => {
      state.stamps += 1;
      const l = state.links.get(id)!;
      if (l.quietEmailSentAt === null) l.quietEmailSentAt = iso;
    },
    send: async (to, copy, key) => {
      if (opts.sendOk === false) return { sent: false, reason: 'boom' };
      state.sends.push({ to, subject: copy.subject, key });
      return { sent: true };
    },
    log: (l) => state.logs.push(l),
  };
  return { state, store };
}

test('nothing is sent before the quiet days have passed', async () => {
  const { state, store } = fake([link()]);
  const r = await runQuietCheck(store, { now: at(6) });
  assert.equal(r.due, 0);
  assert.equal(state.sends.length, 0);
});

test('the email is sent once across many runs', async () => {
  const { state, store } = fake([link()]);
  for (let d = 7; d < 20; d++) await runQuietCheck(store, { now: at(d) });
  assert.equal(state.sends.length, 1);
  assert.equal(state.stamps, 1);
  assert.equal(state.links.get('l1')!.quietEmailSentAt, at(7).toISOString());
});

test('not re-sent until a new row arrives, then another quiet period', async () => {
  const { state, store } = fake([link()]);
  await runQuietCheck(store, { now: at(7) });
  assert.equal(state.sends.length, 1);
  // A new row on day 10: the import saves last_row_at and clears the stamp.
  const l = state.links.get('l1')!;
  l.lastRowAt = at(10).toISOString();
  l.quietEmailSentAt = null;
  await runQuietCheck(store, { now: at(16) }); // 6 quiet days: not yet
  assert.equal(state.sends.length, 1);
  await runQuietCheck(store, { now: at(17) }); // 7 quiet days
  assert.equal(state.sends.length, 2);
  assert.notEqual(state.sends[0].key, state.sends[1].key);
});

test('a link with no row yet counts from the day it went active', async () => {
  const { state, store } = fake([link({ lastRowAt: null, activatedAt: at(2).toISOString() })]);
  await runQuietCheck(store, { now: at(8) });
  assert.equal(state.sends.length, 0);
  await runQuietCheck(store, { now: at(9) });
  assert.equal(state.sends.length, 1);
});

test('a taken slot gives no stamp, and the retry the next day sends', async () => {
  const { state, store } = fake([link()], { taken: new Set([at(7).toISOString().slice(0, 10)]) });
  const r1 = await runQuietCheck(store, { now: at(7) });
  assert.equal(r1.waiting, 1);
  assert.equal(r1.entries[0].code, 'waiting');
  assert.equal(state.sends.length, 0);
  assert.equal(state.stamps, 0);
  assert.equal(state.links.get('l1')!.quietEmailSentAt, null);
  const r2 = await runQuietCheck(store, { now: at(8) });
  assert.equal(r2.sent, 1);
  assert.equal(state.sends.length, 1);
  assert.equal(state.stamps, 1);
});

test('a send that fails is not stamped and is tried again', async () => {
  const { state, store } = fake([link()], { sendOk: false });
  const r = await runQuietCheck(store, { now: at(7) });
  assert.equal(r.failed, 1);
  assert.equal(state.stamps, 0);
  assert.equal(state.links.get('l1')!.quietEmailSentAt, null);
});

test('a dry run sends, claims and stamps nothing', async () => {
  const { state, store } = fake([link()]);
  const r = await runQuietCheck(store, { dry: true, now: at(7) });
  assert.equal(r.due, 1);
  assert.equal(r.sent, 0);
  assert.deepEqual(r.entries, [{ linkId: 'l1', code: 'due' }]);
  assert.equal(state.sends.length, 0);
  assert.equal(state.claims, 0);
  assert.equal(state.stamps, 0);
});

test('links that are not active never get the email', async () => {
  const states = ['waiting_test_row', 'error', 'disconnected'];
  const { state, store } = fake(states.map((s, i) => link({ id: `l${i}`, ownerId: `o${i}`, state: s })));
  // The store's own filter keeps them out, and the rules would refuse them anyway.
  for (const s of states) state.links.get(`l${states.indexOf(s)}`)!.state = s;
  const loose: QuietStore = { ...store, activeLinks: async () => [...state.links.values()] };
  const r = await runQuietCheck(loose, { now: at(30) });
  assert.equal(r.due, 0);
  assert.equal(state.sends.length, 0);
  assert.equal(state.claims, 0);
});

test('the copy uses the days from settings, tells the operator what to check, and types no figure of money', () => {
  const c = quietCopy(5);
  assert.match(c.subject, /5 days/);
  const text = c.lines.join(' ');
  assert.match(text, /ads are running/);
  assert.match(text, /linked to your Google Sheet/);
  assert.match(text, /shared/);
  assert.doesNotMatch(text, /£|\$/);
  assert.match(quietCopy(1).subject, /1 day\b/);
});

test('log lines carry the link id and a code, never an address', async () => {
  const { state, store } = fake([link()]);
  store.activeLinks = async () => {
    throw new Error('ad_sheet_links read failed: 42P01');
  };
  const r = await runQuietCheck(store, { now: at(7) });
  assert.equal(r.ok, false);
  for (const line of state.logs) assert.doesNotMatch(line, /@/);
});

// ── Source pins (the route needs a database and Next) ──
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the cron route: 404 with no secret, 401 when wrong, 503 without service role, off switch, dry flag, import then quiet check', () => {
  const src = code(read('../../app/api/internal/ad-sheets/route.ts'));
  assert.ok(src.indexOf('internalSecretsConfigured()') < src.indexOf('authoriseInternal(request)'));
  assert.match(src, /internalSecretsConfigured\(\)\) return new Response\('Not found', \{ status: 404 \}\)/);
  assert.match(src, /authoriseInternal\(request\)\) return new Response\('Unauthorised', \{ status: 401 \}\)/);
  assert.match(src, /hasServiceRole\(\)\) return Response\.json\(\{ error: 'service role not configured' \}, \{ status: 503 \}\)/);
  assert.match(src, /searchParams\.get\('dry'\) === '1'/);
  assert.ok(src.indexOf('adSheetsEnabled()') < src.indexOf('runAdSheetImport('));
  assert.match(src, /code: 'disabled'/);
  assert.match(src, /imported\.code === 'not_configured'/);
  assert.ok(src.indexOf('runAdSheetImport(') < src.indexOf('runQuietCheckLive('));
  assert.ok(src.indexOf("'not_configured'") < src.indexOf('runQuietCheckLive('));
  assert.match(src, /runAdSheetImport\(\{ dry \}\)/);
  assert.match(src, /runQuietCheckLive\(\{ dry \}\)/);
});

test('the switch is read as strictly true, so the feature stays off when unset', () => {
  const src = code(read('./quiet-server.ts'));
  assert.match(src, /key', 'ad_sheets_enabled'/);
  assert.match(src, /\.value === true/);
});

test('vercel.json schedules the cron at 21 * * * *', () => {
  const cfg = JSON.parse(read('../../../vercel.json')) as { crons: { path: string; schedule: string }[] };
  assert.deepEqual(cfg.crons.filter((x) => x.path === '/api/internal/ad-sheets'), [{ path: '/api/internal/ad-sheets', schedule: '21 * * * *' }]);
});

test('a saved new row clears the quiet stamp in the import store', () => {
  const src = code(read('./import-server.ts'));
  assert.match(src, /patch\.lastRowAt !== undefined\) row\.quiet_email_sent_at = null/);
});
