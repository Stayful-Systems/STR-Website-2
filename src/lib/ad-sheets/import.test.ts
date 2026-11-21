import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runImport } from './import.ts';
import type { CapturedLead, ImportLink, ImportStore, LinkPatch, NewRow, PackContext, SheetClient } from './import.ts';
import { GoogleSheetsError } from './google.ts';
import { FIXTURE_HEADERS, FIXTURE_ROW_INCOMPLETE, FIXTURE_ROW_PACK, FIXTURE_ROW_TEST } from './fixtures.ts';
import { pickSameLandlord } from '../leads/dedupe.ts';
import type { LinkRow } from '../ad-packs/attribution.ts';

const A = '3f9a2c11-1111-4111-8111-111111111111';
const B = '3f9a2c22-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-21T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const AD_A = { id: 'ad-a-5b', code: 'SI-3F9A2C-5B-1', ownerId: A, version: 1 };
const AD_B = { id: 'ad-b-5b', code: 'SI-BBBBBB-5B-1', ownerId: B, version: 1 };

/** A complete row from a pack ad, with its own Meta lead id, email, phone and name. */
function row(n: number, over: Record<number, string> = {}): string[] {
  const r = [...FIXTURE_ROW_PACK];
  r[0] = `l:${1000 + n}`;
  r[14] = `Lead Number${n}`;
  r[15] = `lead${n}@example.com`;
  r[16] = `p:+44770090${String(n).padStart(4, '0')}`;
  for (const [i, v] of Object.entries(over)) r[Number(i)] = v;
  return r;
}

interface SavedRow extends NewRow {
  id: string;
  leadId: string | null;
  createdAt: number;
}
interface FakeLead {
  id: string;
  ownerId: string;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  created_at: string;
  status: string;
}

function world(init: { sheets: Record<string, string[][]>; links: ImportLink[]; packs?: Record<string, PackContext>; adOwners?: Record<string, string> }) {
  const links = new Map(init.links.map((l) => [l.id, { ...l, columnsChangedAt: null as string | null, lastErrorCode: null as string | null, lastRowAt: null as string | null, activatedAt: null as string | null }]));
  const rows = new Map<string, SavedRow>();
  const leads: FakeLead[] = [];
  const packLinks = new Map<string, LinkRow>();
  const sends = { push: [] as string[], notify: [] as string[] };
  const counters = { writes: 0, reads: 0 };
  const faults = { captureCall: 0, failCaptureAt: 0, google: null as string | null, skipDelete: false, failActivate: false, captureAdvanceMs: 0 };
  const clock = { t: NOW };
  let seq = 0;

  const store: ImportStore = {
    async links({ linkId }) {
      return [...links.values()].filter((l) => !linkId || l.id === linkId);
    },
    async packContext(ownerId) {
      const p = init.packs?.[ownerId];
      return p ? { operatorCode: p.operatorCode, packAds: [...p.packAds], knownMetaAdIds: new Map(p.knownMetaAdIds) } : { operatorCode: null, packAds: [], knownMetaAdIds: new Map() };
    },
    async ownerOfCode(code) {
      return init.adOwners?.[code] ?? null;
    },
    async dedupeDays() {
      return 30;
    },
    async websiteFunnelId() {
      return null;
    },
    async insertRow(r) {
      counters.writes++;
      const link = links.get(r.linkId);
      // The composite foreign key: a row can only carry its link's owner.
      if (!link || link.ownerId !== r.ownerId) throw new Error('fk');
      const k = `${r.linkId}|${r.rowKey}`;
      if (rows.has(k)) return null;
      const id = `row-${++seq}`;
      rows.set(k, { ...r, id, leadId: null, createdAt: clock.t.getTime() });
      return id;
    },
    async existingRowKeys(linkId, keys) {
      return new Set(keys.filter((k) => rows.has(`${linkId}|${k}`)));
    },
    async claimOrphanRow(linkId, rowKey, olderThanIso) {
      counters.writes++;
      const r = rows.get(`${linkId}|${rowKey}`);
      if (!r || r.state !== 'imported' || r.leadId !== null || r.createdAt >= Date.parse(olderThanIso)) return null;
      r.createdAt = clock.t.getTime(); // the claim stamp
      return r.id;
    },
    async updateRow(id, patch) {
      counters.writes++;
      const r = [...rows.values()].find((x) => x.id === id)!;
      r.state = patch.state;
      r.leadId = patch.leadId;
    },
    async deleteRow(id) {
      if (faults.skipDelete) return; // a process that died cannot clean up
      counters.writes++;
      for (const [k, v] of rows) if (v.id === id) rows.delete(k);
    },
    async findSameLandlord(ownerId, cand, days) {
      const mine = leads.filter((l) => l.ownerId === ownerId);
      return pickSameLandlord(mine, cand, days, NOW);
    },
    async captureLead(input): Promise<CapturedLead | null> {
      counters.writes++;
      faults.captureCall++;
      if (faults.failCaptureAt && faults.captureCall === faults.failCaptureAt) throw new Error('db down');
      clock.t = new Date(clock.t.getTime() + faults.captureAdvanceMs);
      const id = `lead-${leads.length + 1}`;
      leads.push({ id, ownerId: input.ownerId, email: input.email, phone: input.phone, postcode: input.postcode, created_at: NOW.toISOString(), status: 'new' });
      return { id, reused: false };
    },
    async hasPackLink(leadId) {
      return packLinks.has(leadId);
    },
    async upsertPackLink(r) {
      counters.writes++;
      packLinks.set(r.lead_id, r);
    },
    async activateLink(id, at) {
      if (faults.failActivate) throw new Error('db down');
      counters.writes++;
      const l = links.get(id)!;
      if (l.state === 'waiting_test_row') {
        l.state = 'active';
        l.activatedAt = at;
      }
    },
    async saveLink(id, p: LinkPatch) {
      counters.writes++;
      const l = links.get(id)!;
      if (p.state) l.state = p.state as ImportLink['state'];
      if (p.headerHash !== undefined) l.headerHash = p.headerHash;
      if (p.columnsChangedAt) l.columnsChangedAt = p.columnsChangedAt;
      if (p.lastRowRead !== undefined) l.lastRowRead = p.lastRowRead;
      if (p.rowsImported !== undefined) l.rowsImported = p.rowsImported;
      if (p.untaggedCount !== undefined) l.untaggedCount = p.untaggedCount;
      if (p.lastRowAt) l.lastRowAt = p.lastRowAt;
      if (p.lastErrorCode !== undefined) l.lastErrorCode = p.lastErrorCode;
    },
    async pushToLeadDb(id) {
      sends.push.push(id);
    },
    async notifyNewLead(id) {
      sends.notify.push(id);
    },
  };

  const client: SheetClient = {
    async sheetMeta() {
      return [{ gid: 0, title: 'Form' }];
    },
    async readRange(spreadsheetId, _tab, from, to) {
      counters.reads++;
      if (faults.google) throw new GoogleSheetsError(faults.google as 'error');
      const rowsOfSheet = init.sheets[spreadsheetId] ?? [];
      return rowsOfSheet.slice(from - 1, to);
    },
  };

  const run = async (opts: { dry?: boolean; linkId?: string } = {}) => {
    const r = await runImport(opts, { store, client, now: () => clock.t });
    await new Promise((res) => setImmediate(res)); // let the fire-and-forget sends land
    return r;
  };
  return { run, store, client, links, rows, leads, packLinks, sends, counters, faults, init, clock };
}

const link = (id: string, ownerId: string, over: Partial<ImportLink> = {}): ImportLink => ({
  id,
  ownerId,
  spreadsheetId: `sheet-${id}`,
  tabGid: null,
  tabTitle: 'Form',
  state: 'active',
  headerHash: null,
  lastRowRead: 0,
  rowsImported: 0,
  untaggedCount: 0,
  ...over,
});

const packA: PackContext = { operatorCode: '3F9A2C', packAds: [AD_A], knownMetaAdIds: new Map() };
const packB: PackContext = { operatorCode: 'BBBBBB', packAds: [AD_B], knownMetaAdIds: new Map() };

// ── Idempotency ──

test('two runs and a retry after a mid-run failure: each row saved once, one lead per row', async () => {
  const sheet = [FIXTURE_HEADERS, row(1), row(2), row(3), row(4), row(5)];
  const w = world({ sheets: { 'sheet-l1': sheet }, links: [link('l1', A)], packs: { [A]: packA } });
  w.faults.failCaptureAt = 3; // the third lead cannot be made

  const first = await w.run();
  assert.equal(first.ok, false);
  assert.equal(first.links[0].code, 'db_error');
  assert.equal(first.links[0].imported, 2);
  assert.equal(w.leads.length, 2);
  assert.equal(w.rows.size, 2, 'the row whose lead failed was taken back');
  assert.equal(w.links.get('l1')!.lastRowRead, 3, 'progress stops at the last row fully dealt with');
  assert.equal(w.links.get('l1')!.lastErrorCode, 'db_error');

  const second = await w.run();
  assert.equal(second.ok, true);
  assert.equal(second.links[0].alreadySaved, 2);
  assert.equal(second.links[0].imported, 3);
  assert.equal(w.leads.length, 5);
  assert.equal(w.rows.size, 5);
  assert.equal(new Set([...w.rows.values()].map((r) => r.leadId)).size, 5, 'every row has its own lead');
  assert.equal(w.links.get('l1')!.lastRowRead, 6);
  assert.equal(w.links.get('l1')!.rowsImported, 5);
  assert.equal(w.links.get('l1')!.lastErrorCode, null);

  const third = await w.run();
  assert.equal(third.links[0].saved, 0);
  assert.equal(third.links[0].alreadySaved, 5);
  assert.equal(w.leads.length, 5);
  assert.equal(w.links.get('l1')!.rowsImported, 5);

  // Each new lead was pushed and notified exactly once.
  assert.equal(w.sends.push.length, 5);
  assert.equal(new Set(w.sends.push).size, 5);
  assert.deepEqual(w.sends.notify.sort(), w.sends.push.slice().sort());
  assert.ok(w.leads.every((l) => l.status === 'new'));
});

test('every new lead is tied to its ad through the A1 link shape; a plain row is "Ad unknown"', async () => {
  const plain = row(2, { 3: 'Landlord video 2', 2: 'ag:120210000000000009' });
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, row(1), plain] }, links: [link('l1', A)], packs: { [A]: packA } });
  await w.run();
  const [l1, l2] = w.leads;
  assert.deepEqual(w.packLinks.get(l1.id), { lead_id: l1.id, owner_id: A, pack_ad_id: 'ad-a-5b', match: 'code', ad_code_seen: 'SI-3F9A2C-5B-1', meta_ad_id_seen: '120210000000000001' });
  assert.equal(w.packLinks.get(l2.id)!.match, 'none');
  assert.equal(w.packLinks.get(l2.id)!.pack_ad_id, null);
  assert.equal(w.links.get('l1')!.untaggedCount, 1);
});

test('the read starts 50 rows back; a sheet shorter than last_row_read is read again from the top', async () => {
  const sheet = [FIXTURE_HEADERS, row(1), row(2), row(3)];
  const w = world({ sheets: { 'sheet-l1': sheet }, links: [link('l1', A)], packs: { [A]: packA } });
  await w.run();
  assert.equal(w.leads.length, 3);
  w.links.get('l1')!.lastRowRead = 80; // the sheet was cleaned up and is now shorter
  const r = await w.run();
  assert.equal(r.links[0].alreadySaved, 3, 'the whole sheet was read again, and nothing was made twice');
  assert.equal(w.leads.length, 3);
  assert.equal(w.links.get('l1')!.lastRowRead, 4);
});

// ── Kinds of row ──

test('an incomplete row is saved as incomplete, its missing parts and answers kept, and makes no lead', async () => {
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, FIXTURE_ROW_INCOMPLETE] }, links: [link('l1', A)], packs: { [A]: packA } });
  const r = await w.run();
  assert.equal(r.links[0].incomplete, 1);
  assert.equal(w.leads.length, 0);
  const saved = [...w.rows.values()][0];
  assert.equal(saved.state, 'incomplete');
  assert.deepEqual(saved.missing, ['postcode']);
  assert.ok(saved.answers && Object.values(saved.answers).includes('3'), 'the operator’s own question is kept');
  assert.equal(saved.leadId, null);
  assert.equal(w.sends.push.length + w.sends.notify.length, 0);
  assert.equal(w.packLinks.size, 0);
});

test('a test row is saved as test, makes no lead, and activates a waiting link (once)', async () => {
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, FIXTURE_ROW_TEST, row(1)] }, links: [link('l1', A, { state: 'waiting_test_row' })], packs: { [A]: packA } });
  const r = await w.run();
  assert.equal(r.links[0].test, 1);
  assert.equal(r.links[0].activated, true);
  assert.equal(w.links.get('l1')!.state, 'active');
  assert.ok(w.links.get('l1')!.activatedAt);
  assert.equal([...w.rows.values()].find((x) => x.state === 'test')!.leadId, null);
  assert.equal(w.leads.length, 1, 'only the real row made a lead');
  const again = await w.run();
  assert.equal(again.links[0].activated, false);
});

test('a code that belongs to another operator is a foreign row: no lead, no answers, no link', async () => {
  const foreign = row(1, { 3: 'SI-BBBBBB-5B-1 · Tenant notice' });
  // Found through the store's lookup of the code's owner (the owner's own pack lists only its own ads).
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, foreign, row(2)] }, links: [link('l1', A)], packs: { [A]: { ...packA, operatorCode: null } }, adOwners: { 'SI-BBBBBB-5B-1': B } });
  const r = await w.run();
  assert.equal(r.links[0].foreign, 1);
  assert.equal(r.links[0].imported, 1);
  const f = [...w.rows.values()].find((x) => x.state === 'foreign')!;
  assert.equal(f.leadId, null);
  assert.equal(f.answers, null);
  assert.deepEqual(f.missing, []);
  assert.equal(w.leads.length, 1);
  assert.equal(w.leads[0].ownerId, A);

  // And by the operator part of the code alone, with no lookup.
  const w2 = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, foreign] }, links: [link('l1', A)], packs: { [A]: packA } });
  await w2.run();
  assert.equal([...w2.rows.values()][0].state, 'foreign');
  assert.equal(w2.leads.length, 0);
});

// ── Same landlord ──

test('a website lead of the same landlord (same postcode and email) joins: one lead, the row merged', async () => {
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, FIXTURE_ROW_PACK] }, links: [link('l1', A)], packs: { [A]: packA } });
  w.leads.push({ id: 'web-1', ownerId: A, email: 'alex.example@example.com', phone: null, postcode: 'SW1A 1AA', created_at: new Date(NOW.getTime() - 10 * DAY).toISOString(), status: 'new' });
  const r = await w.run();
  assert.equal(r.links[0].merged, 1);
  assert.equal(w.leads.length, 1, 'no second lead');
  const saved = [...w.rows.values()][0];
  assert.equal(saved.state, 'merged');
  assert.equal(saved.leadId, 'web-1');
  assert.equal(w.packLinks.get('web-1')!.match, 'code', 'attribution written because the lead had no ad link yet');
  assert.equal(w.sends.push.length + w.sends.notify.length, 0, 'a merged row is not a new lead to push or email');
  assert.equal(w.links.get('l1')!.rowsImported, 0);
});

test('a merge never overwrites an ad link the lead already has, and never reaches across owners or past the window', async () => {
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, FIXTURE_ROW_PACK] }, links: [link('l1', A)], packs: { [A]: packA } });
  w.leads.push({ id: 'web-1', ownerId: A, email: 'alex.example@example.com', phone: null, postcode: 'SW1A 1AA', created_at: new Date(NOW.getTime() - 3 * DAY).toISOString(), status: 'new' });
  const existing: LinkRow = { lead_id: 'web-1', owner_id: A, pack_ad_id: 'ad-a-3a', match: 'code', ad_code_seen: 'SI-3F9A2C-3A-1', meta_ad_id_seen: null };
  w.packLinks.set('web-1', existing);
  await w.run();
  assert.deepEqual(w.packLinks.get('web-1'), existing);

  const other = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, FIXTURE_ROW_PACK] }, links: [link('l1', A)], packs: { [A]: packA } });
  other.leads.push({ id: 'b-1', ownerId: B, email: 'alex.example@example.com', phone: null, postcode: 'SW1A 1AA', created_at: NOW.toISOString(), status: 'new' });
  other.leads.push({ id: 'old-1', ownerId: A, email: 'alex.example@example.com', phone: null, postcode: 'SW1A 1AA', created_at: new Date(NOW.getTime() - 45 * DAY).toISOString(), status: 'new' });
  const r = await other.run();
  assert.equal(r.links[0].imported, 1, "another owner's lead and a 45-day-old one do not match");
  assert.equal(other.leads.length, 3);
});

test('two rows of one landlord in the same sheet make one lead', async () => {
  const again = row(2, { 14: 'Lead Number1', 15: 'lead1@example.com', 16: 'p:+447700900001' });
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, row(1), again] }, links: [link('l1', A)], packs: { [A]: packA } });
  const r = await w.run();
  assert.deepEqual([r.links[0].imported, r.links[0].merged], [1, 1]);
  assert.equal(w.leads.length, 1);
});

// ── Owners ──

test('two owners: every saved row carries its own link’s owner, and leads never cross', async () => {
  const w = world({
    sheets: {
      'sheet-la': [FIXTURE_HEADERS, row(1), row(2), FIXTURE_ROW_INCOMPLETE, FIXTURE_ROW_TEST],
      'sheet-lb': [FIXTURE_HEADERS, row(3, { 3: 'SI-BBBBBB-5B-1 · Tenant notice' }), row(4, { 3: 'SI-BBBBBB-5B-1 · Tenant notice' })],
    },
    links: [link('la', A), link('lb', B)],
    packs: { [A]: packA, [B]: packB },
  });
  // The same landlord's details appear in both sheets: still two owners, two leads.
  w.init.sheets['sheet-lb'].push(row(5, { 3: 'SI-BBBBBB-5B-1 · Tenant notice', 14: 'Lead Number1', 15: 'lead1@example.com', 16: 'p:+447700900001' }));
  await w.run();
  const owners = new Map([['la', A], ['lb', B]]);
  for (const r of w.rows.values()) assert.equal(r.ownerId, owners.get(r.linkId), 'a row carries its link’s owner');
  for (const l of w.leads) {
    const rowOfLead = [...w.rows.values()].find((r) => r.leadId === l.id);
    assert.ok(rowOfLead && rowOfLead.ownerId === l.ownerId);
  }
  assert.equal(w.leads.filter((l) => l.ownerId === A).length, 2);
  assert.equal(w.leads.filter((l) => l.ownerId === B).length, 3);
  for (const [leadId, p] of w.packLinks) assert.equal(p.owner_id, w.leads.find((l) => l.id === leadId)!.ownerId);
});

test('only links that are active or waiting are read: error and disconnected links are never touched', async () => {
  const w = world({
    sheets: { 'sheet-l1': [FIXTURE_HEADERS, row(1)] },
    links: [link('l1', A, { state: 'error' as ImportLink['state'] }), link('l2', B, { state: 'disconnected' as ImportLink['state'] })],
    packs: { [A]: packA },
  });
  const r = await w.run();
  assert.equal(r.links.length, 0);
  assert.equal(w.counters.reads, 0);
  assert.equal(w.counters.writes, 0);
});

// ── Dry run ──

test('a dry run counts what would happen and writes nothing and sends nothing', async () => {
  const w = world({
    sheets: { 'sheet-l1': [FIXTURE_HEADERS, row(1), row(2), FIXTURE_ROW_INCOMPLETE, FIXTURE_ROW_TEST, row(3, { 3: 'SI-BBBBBB-5B-1 · x' })] },
    links: [link('l1', A, { state: 'waiting_test_row' })],
    packs: { [A]: packA },
  });
  const r = await w.run({ dry: true });
  assert.equal(r.dry, true);
  const l = r.links[0];
  assert.deepEqual([l.imported, l.merged, l.incomplete, l.test, l.foreign, l.activated], [2, 0, 1, 1, 1, true]);
  assert.equal(w.counters.writes, 0, 'no write of any kind');
  assert.equal(w.rows.size, 0);
  assert.equal(w.leads.length, 0);
  assert.equal(w.sends.push.length + w.sends.notify.length, 0);
  assert.equal(w.links.get('l1')!.state, 'waiting_test_row');
  assert.equal(w.links.get('l1')!.lastRowRead, 0);
  assert.equal(w.links.get('l1')!.headerHash, null);

  // After a real run, the dry run sees every row as already saved.
  await w.run();
  const after = await w.run({ dry: true });
  assert.equal(after.links[0].saved, 0);
  assert.equal(after.links[0].alreadySaved, 5);
});

// ── Errors ──

test('google error codes land on the link; only not_shared and not_found make it an error', async () => {
  for (const [code, becomesError] of [['not_shared', true], ['not_found', true], ['rate_limited', false], ['error', false]] as const) {
    const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, row(1)] }, links: [link('l1', A)], packs: { [A]: packA } });
    w.faults.google = code;
    const r = await w.run();
    assert.equal(r.ok, false);
    assert.equal(r.links[0].code, code);
    assert.equal(w.links.get('l1')!.lastErrorCode, code);
    assert.equal(w.links.get('l1')!.state, becomesError ? 'error' : 'active');
    assert.equal(w.leads.length, 0);
    // The next run, with Google back, carries on and clears the code.
    if (!becomesError) {
      w.faults.google = null;
      await w.run();
      assert.equal(w.links.get('l1')!.lastErrorCode, null);
      assert.equal(w.leads.length, 1);
    }
  }
});

test('not_configured returns without touching any link', async () => {
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, row(1)] }, links: [link('l1', A)], packs: { [A]: packA } });
  w.faults.google = 'not_configured';
  const r = await w.run();
  assert.equal(r.code, 'not_configured');
  assert.deepEqual(r.links, []);
  assert.equal(w.counters.writes, 0);
  assert.equal(w.links.get('l1')!.lastErrorCode, null);
});

// ── Columns ──

test('a changed header row stamps columns_changed_at and keeps saving; with the ad columns gone the lead is untagged', async () => {
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, row(1)] }, links: [link('l1', A)], packs: { [A]: packA } });
  await w.run();
  assert.equal(w.links.get('l1')!.columnsChangedAt, null, 'the first read is not a change');
  assert.ok(w.links.get('l1')!.headerHash);

  const dropAds = (cells: string[]) => cells.filter((_, i) => i !== 2 && i !== 3);
  w.init.sheets['sheet-l1'] = [dropAds(FIXTURE_HEADERS), dropAds(row(1)), dropAds(row(2))];
  const r = await w.run();
  assert.equal(r.links[0].columnsChanged, true);
  assert.ok(w.links.get('l1')!.columnsChangedAt);
  // Row 1 keeps its Meta lead id (the same key), so it is not made again; row 2 is new and has no ad to name.
  assert.equal(r.links[0].alreadySaved, 1);
  assert.equal(r.links[0].saved, 1);
  const untagged = [...w.packLinks.values()].filter((p) => p.match === 'none');
  assert.equal(untagged.length, 1);
});

// ── Safety nets ──

test('nothing logs a lead: a failing run logs ids and codes only', async () => {
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, row(1, { 14: 'Alex Example', 15: 'alex@example.com' }), row(2)] }, links: [link('l1', A)], packs: { [A]: packA } });
  w.faults.failCaptureAt = 2;
  const logged: string[] = [];
  const orig = { e: console.error, w: console.warn, l: console.log };
  console.error = console.warn = console.log = (...a: unknown[]) => {
    logged.push(a.map(String).join(' '));
  };
  try {
    await w.run();
    w.faults.google = 'not_shared';
    await w.run();
  } finally {
    console.error = orig.e;
    console.warn = orig.w;
    console.log = orig.l;
  }
  assert.ok(logged.length > 0);
  for (const line of logged) {
    assert.ok(!/alex|example|SW1A|\+4477|07700/i.test(line), `a log line carried a lead's detail: ${line}`);
  }
});

test('the engine and its server wiring never write leads.status or crm_pushed_at, and the engine stays free of server-only', () => {
  const dir = new URL('.', import.meta.url);
  const engine = readFileSync(new URL('import.ts', dir), 'utf8');
  const server = readFileSync(new URL('import-server.ts', dir), 'utf8');
  const notify = readFileSync(new URL('notify-server.ts', dir), 'utf8');
  for (const src of [engine, server, notify]) {
    assert.ok(!/crm_pushed_at/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'crm_pushed_at is not written');
    assert.ok(!/from\('leads'\)\s*\.update\(\{[^}]*status/.test(src), 'leads.status is not written');
  }
  assert.ok(!/server-only/.test(engine.replace(/\/\*[\s\S]*?\*\//g, '')));
  assert.ok(/const base = \{ linkId: link\.id, ownerId: link\.ownerId,/.test(engine), 'a row’s owner comes from the link');
});

// ── Batch 35 review fixes ──

const MIN = 60 * 1000;

test('a row stuck at imported with no lead gets its lead on a later run, once; a fresh one is left alone', async () => {
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, row(1)] }, links: [link('l1', A)], packs: { [A]: packA } });
  w.faults.failCaptureAt = 1;
  w.faults.skipDelete = true; // the worker died between the insert and the lead
  const first = await w.run();
  assert.equal(first.ok, false);
  assert.equal(w.rows.size, 1);
  assert.equal(w.leads.length, 0);
  assert.equal([...w.rows.values()][0].leadId, null);

  w.faults.skipDelete = false;
  w.clock.t = new Date(NOW.getTime() + 2 * MIN); // younger than 5 minutes: another worker may still be on it
  const fresh = await w.run();
  assert.equal(w.leads.length, 0, 'a fresh orphan is left alone');
  assert.equal(fresh.links[0].alreadySaved, 1);

  w.clock.t = new Date(NOW.getTime() + 10 * MIN);
  const later = await w.run();
  assert.equal(later.links[0].imported, 1);
  assert.equal(w.leads.length, 1);
  const saved = [...w.rows.values()][0];
  assert.equal(saved.leadId, 'lead-1');
  assert.equal(saved.state, 'imported');
  assert.equal(w.packLinks.get('lead-1')!.match, 'code');
  assert.deepEqual(w.sends.push, ['lead-1']);
  assert.deepEqual(w.sends.notify, ['lead-1']);

  w.clock.t = new Date(NOW.getTime() + 30 * MIN);
  await w.run();
  assert.equal(w.leads.length, 1, 'never a second lead');
  assert.equal(w.sends.push.length, 1);
});

test('a row whose lead was made but never tied to it joins that lead on recovery: no second lead', async () => {
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, row(1)] }, links: [link('l1', A)], packs: { [A]: packA } });
  const realUpdate = w.store.updateRow;
  w.store.updateRow = async () => {
    throw new Error('died');
  };
  await w.run();
  assert.equal(w.leads.length, 1);
  assert.equal([...w.rows.values()][0].leadId, null);
  w.store.updateRow = realUpdate;
  w.clock.t = new Date(NOW.getTime() + 10 * MIN);
  await w.run();
  assert.equal(w.leads.length, 1);
  const saved = [...w.rows.values()][0];
  assert.equal(saved.leadId, 'lead-1');
  assert.equal(saved.state, 'merged');
});

test('two overlapping runs over a stuck row still make one lead', async () => {
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, row(1)] }, links: [link('l1', A)], packs: { [A]: packA } });
  w.faults.failCaptureAt = 1;
  w.faults.skipDelete = true;
  await w.run();
  w.faults.skipDelete = false;
  w.clock.t = new Date(NOW.getTime() + 10 * MIN);
  await Promise.all([w.run(), w.run()]);
  assert.equal(w.leads.length, 1);
  assert.equal(w.sends.push.length, 1);
});

test('the time budget stops the loop cleanly at the last saved row and the next run continues with no loss or duplicates', async () => {
  const sheet = [FIXTURE_HEADERS, row(1), row(2), row(3), row(4), row(5), row(6)];
  const w = world({ sheets: { 'sheet-l1': sheet }, links: [link('l1', A)], packs: { [A]: packA } });
  w.faults.captureAdvanceMs = 20_000; // each lead takes 20 s on this clock; the budget is 45 s
  const first = await w.run();
  assert.equal(first.ok, true, 'a budget stop is not an error');
  assert.equal(first.links[0].budgetStopped, true);
  assert.equal(first.links[0].imported, 3);
  assert.equal(w.leads.length, 3);
  assert.equal(w.links.get('l1')!.lastRowRead, 4, 'progress stays at the last row fully saved');
  assert.equal(w.links.get('l1')!.lastErrorCode, null);

  const second = await w.run();
  assert.equal(second.links[0].alreadySaved, 3);
  assert.equal(second.links[0].imported, 3);
  assert.equal(w.leads.length, 6);
  assert.equal(new Set([...w.rows.values()].map((r) => r.leadId)).size, 6);
  assert.equal(w.links.get('l1')!.lastRowRead, 7);
  assert.equal(w.links.get('l1')!.rowsImported, 6);
  assert.equal(w.sends.push.length, 6);
});

test('a test row that arrives while activation had not succeeded still activates the link on a later run', async () => {
  const w = world({ sheets: { 'sheet-l1': [FIXTURE_HEADERS, FIXTURE_ROW_TEST] }, links: [link('l1', A, { state: 'waiting_test_row' })], packs: { [A]: packA } });
  w.faults.failActivate = true;
  const first = await w.run();
  assert.equal(first.ok, false);
  assert.equal(w.links.get('l1')!.state, 'waiting_test_row');
  assert.equal(w.rows.size, 1, 'the test row was saved');

  w.faults.failActivate = false;
  const dry = await w.run({ dry: true });
  assert.equal(dry.links[0].activated, true, 'a dry run reports it too');
  assert.equal(w.links.get('l1')!.state, 'waiting_test_row');

  const second = await w.run();
  assert.equal(second.links[0].alreadySaved, 1, 'the insert did not win');
  assert.equal(second.links[0].activated, true);
  assert.equal(w.links.get('l1')!.state, 'active');
  assert.ok(w.links.get('l1')!.activatedAt);
  assert.equal(w.leads.length, 0);
});
