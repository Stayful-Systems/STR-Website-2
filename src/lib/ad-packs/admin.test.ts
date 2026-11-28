import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adPackAdminRunner, NOT_ALLOWED, pageGuard, planToken, type AdPackAdminDeps, type RegenSource } from './admin-run.ts';
import { ADMIN_PACK_LIMIT, buildAdminView, type AdminAdInput, type AdminLinkInput, type AdminRenderInput } from './admin-view.ts';
import { linkMissing, type AttributionStore, type LinkRow, type MissingLead } from './attribution.ts';
import { operatorCode, packCode } from './codes.ts';
import type { GenerateInput } from './generate-core.ts';
import { harness, type Harness } from './test-store.ts';
import type { PackRow } from './store-types.ts';

/**
 * Batch 38 phase 10: the admin's ad pack table and its two actions, on the
 * in-memory store and a fake attribution store (no database, no network).
 */

const OWNER_A = '3f9a2c11-1111-4111-8111-111111111111';
const OWNER_B = '7b1d4e22-2222-4222-8222-222222222222';
const PACK_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const ADMIN = { email: 'zac@stayful.co.uk' };

// ── A website that can change between a dry run and a run ──

type Site = { company: string; logoUrl: string | null; colour: string | null; fee: number | null; domain: string; photos: string[]; approved: boolean };

function baseSite(): Site {
  return { company: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/logo.png', colour: '#1F6F5C', fee: 12, domain: 'brightstone.co.uk', photos: ['https://cdn.example.test/p1.jpg'], approved: false };
}

function inputOf(s: Site): GenerateInput {
  return {
    areaKey: 'NG7',
    photos: s.photos,
    brand: { company: s.company, logoUrl: s.logoUrl, brandColour: s.colour, feePct: s.fee, areas: ['Nottingham'], photoUrl: null },
    domain: s.domain,
    websiteId: '00000000-0000-4000-8000-0000000000aa',
    typeOnly: s.logoUrl === null,
  };
}

type Rig = {
  h: Harness;
  site: Site;
  calls: string[];
  runner: ReturnType<typeof adPackAdminRunner>;
  user: { email: string | null } | null;
  audit: string[];
  source: RegenSource | null;
};

async function rig(opts: { made?: boolean; approved?: boolean } = {}): Promise<Rig> {
  const h = harness();
  const site = baseSite();
  const r = { h, site, calls: [] as string[], user: ADMIN as { email: string | null } | null, audit: [] as string[], source: null as RegenSource | null } as Rig;
  if (opts.made !== false) {
    const made = await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: inputOf(site) });
    assert.ok(made.ok && !made.dry);
    if (opts.approved) {
      await h.finishVideo(OWNER_A); // 38b: a pack is approved only with its video ready
      assert.ok((await h.engine.approvePack({ ownerId: OWNER_A })).ok);
    }
  }
  const deps: AdPackAdminDeps = {
    currentUser: async () => r.user,
    readRegenSource: async (packId) => {
      r.calls.push(`source:${packId}`);
      if (r.source) return r.source;
      if (packId !== PACK_A) return { ok: false, code: 'no_pack' };
      const pack = await h.store.getPack(OWNER_A);
      return { ok: true, ownerId: OWNER_A, company: r.site.company, wasApproved: pack?.approvedAt != null, input: inputOf(r.site) };
    },
    generate: async (req) => {
      r.calls.push(`generate:${req.by}:${req.dry ? 'dry' : 'run'}`);
      return h.engine.generatePack(req);
    },
    linkMissing: async () => {
      throw new Error('not wired in this rig');
    },
    audit: (line) => r.audit.push(line),
  };
  r.runner = adPackAdminRunner(deps);
  return r;
}

const snapshot = (h: Harness) => JSON.stringify({ p: [...h.store.packs.entries()], a: [...h.store.ads.entries()], r: h.store.runs });

// ── The page guard ──

test('the page guard: no user signs in, a non-admin gets not-found, an admin sees the page', () => {
  assert.equal(pageGuard(null), 'login');
  assert.equal(pageGuard(undefined), 'login');
  assert.equal(pageGuard({ email: 'someone@example.com' }), 'not_found');
  assert.equal(pageGuard({ email: null }), 'not_found');
  assert.equal(pageGuard({ email: 'ZAC@stayful.co.uk' }), 'ok');
  // The admin test is injectable and is what decides.
  assert.equal(pageGuard({ email: 'x@y.z' }, () => true), 'ok');
});

// ── Non-admin is refused everywhere, before anything is read ──

test('a non-admin, and a signed-out visitor, is refused by every action and nothing is read, planned or written', async () => {
  for (const user of [{ email: 'landlord@example.com' }, { email: null }, null]) {
    const r = await rig();
    r.user = user;
    const before = snapshot(r.h);
    const results = [
      await r.runner.dryRegenerate(PACK_A),
      await r.runner.runRegenerate(PACK_A, 'whatever'),
      await r.runner.dryLinkMissing(),
      await r.runner.runLinkMissing(OWNER_A),
    ];
    for (const res of results) {
      assert.equal(res.ok, false);
      assert.equal(res.canRun, false);
      assert.equal(res.message, NOT_ALLOWED);
      assert.deepEqual(res.lines, []);
    }
    assert.deepEqual(r.calls, [], 'no pack or website was read, nothing was generated');
    assert.equal(snapshot(r.h), before);
    assert.deepEqual(r.audit, []);
  }
});

test('the verified user decides, never an argument: a second argument cannot make a non-admin an admin', async () => {
  const r = await rig();
  r.user = { email: 'landlord@example.com' };
  // @ts-expect-error the runner takes no identity argument; an extra one is ignored
  const res = await r.runner.dryRegenerate(PACK_A, { email: 'zac@stayful.co.uk' });
  assert.equal(res.message, NOT_ALLOWED);
});

// ── Dry runs write nothing ──

test('a dry regenerate writes nothing: no pack, ad, run or file, no render, no upload', async () => {
  const r = await rig({ approved: true });
  r.site.company = 'Brightstone Lettings'; // a brand change: the plan is for version 2
  const before = snapshot(r.h);
  const writes = r.h.store.writes.length;
  const renders = r.h.renderer.calls.length;
  const uploads = r.h.uploader.calls;
  const files = r.h.uploader.files.size;

  const res = await r.runner.dryRegenerate(PACK_A);

  assert.equal(res.ok, true);
  assert.equal(res.canRun, true);
  assert.ok(res.token);
  assert.match(res.message, /Dry run passed: nothing was changed/);
  assert.equal(snapshot(r.h), before);
  assert.equal(r.h.store.writes.length, writes);
  assert.equal(r.h.renderer.calls.length, renders);
  assert.equal(r.h.uploader.calls, uploads);
  assert.equal(r.h.uploader.files.size, files);
  assert.deepEqual(r.calls, [`source:${PACK_A}`, 'generate:admin:dry']);
  assert.deepEqual(r.audit, [], 'a dry run is not an audited change');
  const text = res.lines.join('\n');
  assert.match(text, /Brightstone Lettings/, 'the plan is built from the website as it is now');
  assert.match(text, /Would make version 2/);
  assert.match(text, /approved now[\s\S]*approves the new version[\s\S]*keep linking/, 'an approved pack is warned it goes back to preview, and that old ads keep linking');
  assert.match(text, /does not use the operator’s free regeneration/);
});

test('a dry run that would be refused says why and offers no Run', async () => {
  const r = await rig();
  r.h.area.result = { error: 'not_enough_data' };
  const thin = await r.runner.dryRegenerate(PACK_A);
  assert.equal(thin.ok, false);
  assert.equal(thin.canRun, false);
  assert.equal(thin.token, null);
  assert.match(thin.message, /not enough data in your area/i);

  const r2 = await rig();
  r2.h.store.spendUnreadable = true;
  const unknown = await r2.runner.dryRegenerate(PACK_A);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.canRun, false);
  assert.match(unknown.message, /would be refused/);
  assert.match(unknown.message, /month’s limit/);
  assert.equal(unknown.token, null);
  assert.ok(unknown.lines.length > 0, 'the plan is still shown');
  assert.equal(r2.h.store.runs.length, 1, 'only the operator’s first run exists');
});

test('a pack whose checks would fail offers no Run (it would hide the version the operator can see)', async () => {
  const r = await rig();
  r.site.logoUrl = null;
  r.source = { ok: true, ownerId: OWNER_A, company: 'Brightstone Stays', wasApproved: false, input: { ...inputOf(r.site), typeOnly: false } };
  const res = await r.runner.dryRegenerate(PACK_A);
  assert.equal(res.ok, false);
  assert.equal(res.canRun, false);
  assert.match(res.message, /checks would fail/);
  assert.ok(res.lines.some((l) => /no logo/i.test(l)));
  assert.equal(r.h.store.packs.get([...r.h.store.packs.keys()][0])!.version, 1);
});

test('a pack that cannot be rebuilt says why in plain English', async () => {
  for (const [code, re] of [
    ['no_pack', /not found/],
    ['no_site', /no website/],
    ['no_domain', /no live \.co\.uk domain/],
    ['no_area', /no saved area/],
    ['unreadable', /try again/],
  ] as const) {
    const r = await rig();
    r.source = { ok: false, code };
    const res = await r.runner.dryRegenerate(PACK_A);
    assert.equal(res.ok, false);
    assert.match(res.message, re);
    assert.ok(!r.calls.includes('generate:admin:dry'), 'nothing is planned without a source');
  }
});

test('a pack id that is not an id is refused before anything is read', async () => {
  const r = await rig();
  for (const bad of ['', 'pack-1', 'x'.repeat(40), 42, null, undefined, { id: PACK_A }]) {
    assert.equal((await r.runner.dryRegenerate(bad)).message, 'That is not a pack.');
    assert.equal((await r.runner.runRegenerate(bad, 'tok')).message, 'That is not a pack.');
  }
  assert.deepEqual(r.calls, []);
});

// ── Run: needs the dry run's token and re-validates ──

test('Run is refused without the token, with a blank or wrong token; nothing is made', async () => {
  const r = await rig();
  r.site.company = 'Brightstone Lettings';
  const before = snapshot(r.h);
  for (const t of [undefined, null, '', 'nope', 7]) {
    const res = await r.runner.runRegenerate(PACK_A, t);
    assert.equal(res.ok, false);
  }
  assert.equal(snapshot(r.h), before);
  assert.ok(!r.calls.includes('generate:admin:run'));
});

test('Run with the dry run’s token makes version 2 from the CURRENT website; admin regenerate never counts', async () => {
  const r = await rig({ approved: true });
  r.site.company = 'Brightstone Lettings';
  r.site.colour = '#123456';
  r.site.fee = 10;
  r.site.domain = 'brightstone-lettings.co.uk';
  const dry = await r.runner.dryRegenerate(PACK_A);
  assert.ok(dry.token);

  const res = await r.runner.runRegenerate(PACK_A, dry.token);

  assert.equal(res.ok, true, res.message);
  assert.match(res.message, /Regenerated/);
  assert.equal(res.canRun, false);
  assert.equal(res.token, null);
  const pack = (await r.h.store.getPack(OWNER_A)) as PackRow;
  assert.equal(pack.version, 2);
  assert.equal(pack.status, 'preview');
  assert.equal(pack.regenCount, 0, 'an admin regenerate never counts toward the operator’s free regeneration');
  assert.ok(pack.approvedAt, 'an admin regenerate keeps the first approval time, so ads already running keep linking leads');
  const ads = (await r.h.store.listAds(OWNER_A, pack.id)).filter((a) => a.version === 2);
  assert.equal(ads.length, 3);
  for (const a of ads) assert.ok(a.link.startsWith('https://brightstone-lettings.co.uk/?ad='), a.link);
  assert.match(JSON.stringify(ads.map((a) => a.texts)), /Brightstone Lettings/);
  const run = r.h.store.runs.at(-1)!;
  assert.equal(run.by, 'admin');
  assert.equal(run.result?.regenerate, true);
  assert.equal(r.audit.length, 1);
  assert.match(r.audit[0], /^zac@stayful\.co\.uk regenerated pack 11111111-aaaa-4aaa-8aaa-111111111111: version 2, preview$/);
});

test('admin regenerate is unlimited: repeated, and with no brand change, still allowed', async () => {
  const r = await rig();
  // The operator has already used their one free regeneration.
  r.site.company = 'Brightstone Lettings';
  assert.ok((await r.h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: inputOf(r.site) })).ok);
  const used = (await r.h.store.getPack(OWNER_A))!.regenCount;
  assert.equal(used, 1);
  assert.equal((await r.h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: inputOf(r.site) })).ok, false, 'the operator is stopped');

  for (let i = 0; i < 3; i++) {
    const dry = await r.runner.dryRegenerate(PACK_A);
    assert.equal(dry.canRun, true, dry.message);
    const res = await r.runner.runRegenerate(PACK_A, dry.token);
    assert.equal(res.ok, true, res.message);
  }
  const pack = (await r.h.store.getPack(OWNER_A))!;
  assert.equal(pack.version, 5);
  assert.equal(pack.regenCount, used, 'still the operator’s count only');
});

test('Run re-validates: a website change after the dry run refuses it and makes nothing', async () => {
  const r = await rig();
  r.site.company = 'Brightstone Lettings';
  const dry = await r.runner.dryRegenerate(PACK_A);
  assert.ok(dry.token);
  const before = snapshot(r.h);

  r.site.colour = '#ABCDEF'; // the operator changed their colour in the meantime
  const res = await r.runner.runRegenerate(PACK_A, dry.token);

  assert.equal(res.ok, false);
  assert.match(res.message, /changed since that dry run/);
  assert.equal(snapshot(r.h), before);
  assert.ok(!r.calls.includes('generate:admin:run'));
  // A fresh dry run gives a fresh token that works.
  const again = await r.runner.dryRegenerate(PACK_A);
  assert.notEqual(again.token, dry.token);
  assert.equal((await r.runner.runRegenerate(PACK_A, again.token)).ok, true);
});

test('Run re-validates: a pack that was regenerated since the dry run (another admin) refuses the old token', async () => {
  const r = await rig();
  r.site.company = 'Brightstone Lettings';
  const dry = await r.runner.dryRegenerate(PACK_A);
  assert.equal((await r.runner.runRegenerate(PACK_A, dry.token)).ok, true);
  const res = await r.runner.runRegenerate(PACK_A, dry.token);
  assert.equal(res.ok, false);
  assert.match(res.message, /changed since that dry run/);
  assert.equal((await r.h.store.getPack(OWNER_A))!.version, 2);
});

test('Run reports an engine refusal in plain English and audits the code only', async () => {
  const r = await rig();
  r.site.company = 'Brightstone Lettings';
  const dry = await r.runner.dryRegenerate(PACK_A);
  r.h.uploader.fail = true;
  const res = await r.runner.runRegenerate(PACK_A, dry.token);
  assert.equal(res.ok, false);
  assert.match(res.message, /Something went wrong making your pack/);
  assert.deepEqual(r.audit.map((l) => l.replace(/^\S+ /, '')), [`regenerate pack ${PACK_A}: upload_failed`]);
});

test('planToken moves with the brand, the version and the operator', () => {
  const a = { brandHash: 'a'.repeat(64), version: 2, operatorCode: '3F9A2C' };
  assert.notEqual(planToken(a), planToken({ ...a, brandHash: 'b'.repeat(64) }));
  assert.notEqual(planToken(a), planToken({ ...a, version: 3 }));
  assert.notEqual(planToken(a), planToken({ ...a, operatorCode: '7B1D4E' }));
  assert.equal(planToken(a), planToken({ ...a }));
});

// ── Link missing leads ──

const LEAD_ADA = { id: 'd1a2b3c4-0001-4000-8000-000000000001', email: 'ada.lovelace@example.com', name: 'Ada Lovelace', address: '12 Analytical Row, Nottingham' };
const LEAD_BOB = { id: 'd1a2b3c4-0002-4000-8000-000000000002', email: 'bob.builder@example.com', name: 'Bob Builder', address: '1 Scaffold Way, Leeds' };
const LEAD_DONE = { id: 'd1a2b3c4-0003-4000-8000-000000000003', email: 'cleo@example.com', name: 'Cleo Patra', address: '3 Nile Street, Derby' };

function attribution() {
  const OPA = operatorCode(OWNER_A);
  const code = packCode(OPA, '5b', 1);
  const leads = [
    { ...LEAD_ADA, ownerId: OWNER_A, adCode: code },
    { ...LEAD_BOB, ownerId: OWNER_A, adCode: null as string | null },
    { ...LEAD_DONE, ownerId: OWNER_B, adCode: null as string | null },
  ];
  const links = new Map<string, LinkRow>();
  let writes = 0;
  const store: AttributionStore = {
    async lead(id) {
      const l = leads.find((x) => x.id === id);
      return l ? { ownerId: l.ownerId, isWebsiteLead: true } : null;
    },
    async sources(id) {
      const l = leads.find((x) => x.id === id);
      return l ? { adCode: l.adCode, utmContent: null } : null;
    },
    async pack(owner) {
      return { operatorCode: owner === OWNER_A ? OPA : operatorCode(OWNER_B), approvedAt: '2026-11-01T00:00:00Z' };
    },
    async packAds(owner) {
      return owner === OWNER_A ? [{ id: 'ad-a', code, ownerId: OWNER_A, version: 1 }] : [];
    },
    async knownMetaAdIds() {
      return new Map();
    },
    async upsertLink(row) {
      writes++;
      links.set(row.lead_id, row);
    },
    async missingLeads(o): Promise<MissingLead[]> {
      return leads.filter((l) => !links.has(l.id) && (!o.ownerId || l.ownerId === o.ownerId)).slice(0, o.limit).map((l) => ({ leadId: l.id, ownerId: l.ownerId }));
    },
  };
  return { store, links, writes: () => writes, leads };
}

function linkRig() {
  const att = attribution();
  const seen: { ownerId?: string; sinceApproved?: boolean; dry?: boolean }[] = [];
  const runner = adPackAdminRunner({
    currentUser: async () => ADMIN,
    readRegenSource: async () => ({ ok: false, code: 'no_pack' }),
    generate: async () => {
      throw new Error('no generator here');
    },
    linkMissing: async (opts) => {
      seen.push(opts);
      return linkMissing(att.store, opts);
    },
  });
  return { att, seen, runner };
}

test('the link-missing dry run counts and writes nothing; Run links, and is idempotent', async () => {
  const { att, runner, seen } = linkRig();
  const dry = await runner.dryLinkMissing();
  assert.equal(dry.ok, true);
  assert.equal(dry.canRun, true);
  assert.equal(dry.count, 3);
  assert.equal(att.writes(), 0, 'a dry run writes nothing');
  assert.equal(att.links.size, 0);
  assert.match(dry.message, /3 website leads across all operators/);
  assert.match(dry.message, /Nothing was changed/);
  assert.deepEqual(seen[0], { sinceApproved: true, dry: true });

  const run = await runner.runLinkMissing();
  assert.equal(run.ok, true);
  assert.equal(run.count, 3);
  assert.equal(run.linked, 1);
  assert.equal(run.untagged, 2);
  assert.equal(att.writes(), 3);
  assert.match(run.message, /Looked at 3 leads: 1 recorded against an ad, 2 recorded as no ad/);

  const again = await runner.runLinkMissing();
  assert.equal(again.count, 0);
  assert.equal(att.writes(), 3, 'nothing is written twice');
  const drySecond = await runner.dryLinkMissing();
  assert.equal(drySecond.canRun, false);
  assert.match(drySecond.message, /no website leads/);
});

test('link missing can be scoped to one owner; an owner id that is not an id is refused', async () => {
  const { att, runner, seen } = linkRig();
  const dry = await runner.dryLinkMissing(OWNER_B);
  assert.equal(dry.count, 1);
  assert.match(dry.message, /for that operator/);
  assert.deepEqual(seen.at(-1), { ownerId: OWNER_B, sinceApproved: true, dry: true });
  const run = await runner.runLinkMissing(OWNER_B);
  assert.equal(run.count, 1);
  assert.equal(att.links.size, 1);
  assert.equal([...att.links.values()][0].owner_id, OWNER_B);

  const before = seen.length;
  for (const bad of ['not-an-id', "x' or 1=1", 5, {}]) {
    assert.equal((await runner.dryLinkMissing(bad)).message, 'That is not an operator id.');
    assert.equal((await runner.runLinkMissing(bad)).message, 'That is not an operator id.');
  }
  assert.equal(seen.length, before, 'nothing was looked up for a bad id');
});

test('nothing a link-missing action returns holds a lead’s name, email, address or id', async () => {
  const { att, runner } = linkRig();
  const results = [await runner.dryLinkMissing(), await runner.runLinkMissing(), await runner.dryLinkMissing(OWNER_A), await runner.runLinkMissing(OWNER_B)];
  const blob = JSON.stringify(results);
  for (const l of att.leads) {
    for (const secret of [l.email, l.name, l.address, l.id, l.name.split(' ')[0]]) assert.ok(!blob.includes(secret), `leaked ${secret}`);
  }
  for (const res of results) assert.deepEqual(Object.keys(res).sort(), ['canRun', 'count', 'failed', 'linked', 'lines', 'message', 'ok', 'skipped', 'untagged'].sort());
});

test('a failing link-missing read says so without an error body, and the run is not audited as a success', async () => {
  const audit: string[] = [];
  const runner = adPackAdminRunner({
    currentUser: async () => ADMIN,
    readRegenSource: async () => ({ ok: false, code: 'no_pack' }),
    generate: async () => {
      throw new Error('x');
    },
    linkMissing: async (o) => ({ ok: false, code: 'error', dry: o.dry === true, leadIds: [], count: 0, linked: 0, untagged: 0, skipped: 0, failed: 0 }),
    audit: (l) => audit.push(l),
  });
  const dry = await runner.dryLinkMissing();
  assert.equal(dry.ok, false);
  assert.equal(dry.canRun, false);
  assert.match(dry.message, /Nothing was changed/);
  const run = await runner.runLinkMissing();
  assert.equal(run.ok, false);
  assert.deepEqual(audit, []);
});

// ── The view model ──

function pack(over: Partial<PackRow> & Pick<PackRow, 'id' | 'ownerId'>): PackRow {
  return {
    websiteId: null, status: 'approved', route: 'academy', operatorCode: 'AAAAAA', version: 2, voiceKey: null, voiceChanges: 0, regenCount: 1, brandHash: 'h',
    areaKey: 'NG7', areaLabel: 'Lenton', coverage: null, coverageAreas: [], bedrooms: 3, figures: [], photos: [], checks: null, errorCode: null, costPence: 125,
    generatedAt: '2026-11-10T10:00:00Z', approvedAt: '2026-11-11T10:00:00Z', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-11T10:00:00Z',
    ...over,
  };
}

const ad = (id: string, packId: string, version: number, angle: string, code: string): AdminAdInput => ({ id, packId, version, angle, code });
const link = (ownerId: string, packAdId: string | null, match: string): AdminLinkInput => ({ ownerId, packAdId, match });

test('the view counts leads per ad and untagged leads per owner from sample rows', () => {
  const packs = [pack({ id: 'p-a', ownerId: OWNER_A, costPence: 150 }), pack({ id: 'p-b', ownerId: OWNER_B, status: 'preview', approvedAt: null, regenCount: 0, version: 1, costPence: 0 })];
  const ads = [
    ad('a5b1', 'p-a', 1, '5b', 'SI-AAAAAA-5B-1'),
    ad('a3a1', 'p-a', 1, '3a', 'SI-AAAAAA-3A-1'),
    ad('a5b2', 'p-a', 2, '5b', 'SI-AAAAAA-5B-2'),
    ad('a3a2', 'p-a', 2, '3a', 'SI-AAAAAA-3A-2'),
    ad('a172', 'p-a', 2, '17', 'SI-AAAAAA-17-2'),
    ad('b5b1', 'p-b', 1, '5b', 'SI-BBBBBB-5B-1'),
  ];
  const links = [
    link(OWNER_A, 'a5b2', 'code'), link(OWNER_A, 'a5b2', 'code'), link(OWNER_A, 'a5b2', 'ad_id'),
    link(OWNER_A, 'a5b1', 'code'), // an older version's code still counts
    link(OWNER_A, 'a172', 'code'),
    link(OWNER_A, null, 'none'), link(OWNER_A, null, 'none'), link(OWNER_A, null, 'foreign_code'),
    link(OWNER_A, null, 'code'), // its ad was deleted
    link(OWNER_B, 'b5b1', 'code'),
    link(OWNER_B, null, 'none'),
  ];
  const owners = new Map([[OWNER_A, { company: 'Alpha Stays', email: 'alpha@example.com' }], [OWNER_B, { company: null, email: 'beta@example.com' }]]);

  const { rows, totals } = buildAdminView({ packs, owners, ads, links });

  assert.equal(rows.length, 2);
  const [a, b] = rows;
  assert.equal(a.company, 'Alpha Stays');
  assert.equal(a.email, 'alpha@example.com');
  assert.equal(a.statusLabel, 'Approved');
  assert.equal(a.costLabel, '£1.50');
  assert.equal(a.regenCount, 1);
  assert.deepEqual(a.ads.map((x) => [x.code, x.leads, x.current]), [
    ['SI-AAAAAA-5B-2', 3, true],
    ['SI-AAAAAA-3A-2', 0, true],
    ['SI-AAAAAA-17-2', 1, true],
    ['SI-AAAAAA-5B-1', 1, false],
    ['SI-AAAAAA-3A-1', 0, false],
  ]);
  assert.equal(a.taggedLeads, 5);
  assert.equal(a.untagged, 3, 'none and foreign_code');
  assert.equal(a.unplaced, 1);
  assert.equal(a.canRegenerate, true);
  assert.equal(b.company, null);
  assert.equal(b.statusLabel, 'Ready to look at');
  assert.equal(b.taggedLeads, 1);
  assert.equal(b.untagged, 1);
  assert.equal(b.unplaced, 0);
  assert.deepEqual(totals, { packs: 2, taggedLeads: 6, untagged: 4, unplaced: 1, costPence: 150 });
});

const render = (packId: string, version: number, over: Partial<AdminRenderInput> = {}): AdminRenderInput => ({ packId, version, voiceKey: 'jane', state: 'done', attempts: 1, errorCode: null, costPence: 20, ...over });

test('the view has a Video line per pack: voice, render state, attempts, short error code and the render cost so far', () => {
  const packs = [
    pack({ id: 'p-a', ownerId: OWNER_A, version: 2, voiceKey: 'olivia' }),
    pack({ id: 'p-b', ownerId: OWNER_B, version: 1, voiceKey: 'oliver' }),
    pack({ id: 'p-c', ownerId: OWNER_B, version: 1, voiceKey: null }),
  ];
  const renders = [
    render('p-a', 1, { voiceKey: 'jane', costPence: 18 }),
    render('p-a', 2, { voiceKey: 'olivia', state: 'failed', attempts: 3, errorCode: 'sandbox_failed', costPence: 35 }),
    render('p-b', 1, { voiceKey: 'oliver', state: 'running', attempts: 1, costPence: 0 }),
  ];
  const { rows } = buildAdminView({ packs, owners: new Map(), ads: [], links: [], renders });
  const [a, b, c] = rows.map((r) => r.video);
  assert.deepEqual(a, { hasRender: true, voiceLabel: 'Olivia', state: 'failed', stateLabel: 'Failed', attempts: 3, errorCode: 'sandbox_failed', renderCostPence: 53, renderCostLabel: '£0.53' });
  assert.deepEqual([b.voiceLabel, b.stateLabel, b.attempts, b.errorCode, b.renderCostLabel], ['Oliver', 'Running', 1, null, '£0']);
  // A pack with no render yet says so, and costs nothing.
  assert.deepEqual([c.hasRender, c.state, c.stateLabel, c.attempts, c.renderCostLabel], [false, null, 'No video yet', 0, '£0']);
  // Only the current version's state and code are shown; the cost covers every version.
  assert.equal(buildAdminView({ packs: [pack({ id: 'p-a', ownerId: OWNER_A, version: 3 })], owners: new Map(), ads: [], links: [], renders }).rows[0].video.hasRender, false);
  // Without any render rows the view still works (the older call shape).
  assert.equal(buildAdminView({ packs, owners: new Map(), ads: [], links: [] }).rows[2].video.stateLabel, 'No video yet');
});

test('the Video column shows only states, counts and short codes: never files, paths, sandbox ids or a text', () => {
  const blob = JSON.stringify(buildAdminView({ packs: [pack({ id: 'p-a', ownerId: OWNER_A })], owners: new Map(), ads: [], links: [], renders: [render('p-a', 2, { errorCode: 'x'.repeat(200) })] }));
  assert.doesNotMatch(blob, /sandbox_id|files|path|\.mp4|\.png|voice\.mp3/);
  assert.ok(!blob.includes('x'.repeat(61)), 'an error code is cut at 60 characters');
  const server = code(read('./admin-server.ts'));
  assert.match(server, /select\('pack_id, version, voice_key, state, attempts, error_code, cost_pence'\)/);
  assert.doesNotMatch(server, /sandbox_id|lease_until|\bfiles\b.*ad_pack_renders/);
  const panel = code(read('../../app/admin/ad-packs/AdPacksPanel.tsx'));
  assert.match(panel, /<th className="pr-3 font-medium">Video<\/th>/);
  assert.match(panel, /r\.video\.voiceLabel/);
  assert.doesNotMatch(panel, /requeue|Re-queue/i, 'no new action on a render from this screen');
});

test('the admin dry run says the video is made by the worker, not now, and never says "coming"', async () => {
  const r = await rig();
  r.site.company = 'Brightstone Lettings';
  const dry = await r.runner.dryRegenerate(PACK_A);
  const text = dry.lines.join('\n');
  assert.match(text, /video, made by the render worker in Jane’s voice \(nothing is made by a dry run\)/);
  assert.doesNotMatch(text, /video coming/i);
});

test('the view: a pack with no ads or links reads as zeros; no stored area means no regenerate; an unknown angle is skipped', () => {
  const { rows, totals } = buildAdminView({
    packs: [pack({ id: 'p-a', ownerId: OWNER_A, areaKey: null, status: 'failed', generatedAt: null, approvedAt: null, version: 1, regenCount: 0, costPence: 0 })],
    owners: new Map(),
    ads: [ad('x', 'p-a', 1, '99', 'SI-X-99-1')],
    links: [],
  });
  assert.equal(rows[0].ads.length, 0);
  assert.equal(rows[0].taggedLeads, 0);
  assert.equal(rows[0].untagged, 0);
  assert.equal(rows[0].canRegenerate, false);
  assert.equal(rows[0].company, null);
  assert.equal(rows[0].email, null);
  assert.equal(rows[0].statusLabel, 'Failed');
  assert.equal(totals.packs, 1);
});

test('the view lists at most 200 packs', () => {
  const packs = Array.from({ length: ADMIN_PACK_LIMIT + 25 }, (_, i) => pack({ id: `p-${i}`, ownerId: `owner-${i}` }));
  assert.equal(buildAdminView({ packs, owners: new Map(), ads: [], links: [] }).rows.length, 200);
});

test('the view takes nothing that identifies a lead', () => {
  const links = [link(OWNER_A, 'a5b1', 'code')];
  assert.deepEqual(Object.keys(links[0]).sort(), ['match', 'ownerId', 'packAdId']);
  const blob = JSON.stringify(buildAdminView({ packs: [pack({ id: 'p-a', ownerId: OWNER_A })], owners: new Map(), ads: [ad('a5b1', 'p-a', 2, '5b', 'SI-AAAAAA-5B-2')], links }));
  assert.doesNotMatch(blob, /@/);
});

// ── Source pins (the server files need a database and Next) ──

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the actions are thin hand-overs to the runner: one runner call each, no argument can name the admin', () => {
  const src = code(read('../../app/admin/ad-packs/actions.ts'));
  assert.match(src, /^\s*'use server';/);
  const exported = [...src.matchAll(/export async function (\w+)\(([^)]*)\)/g)];
  assert.deepEqual(exported.map((m) => m[1]), ['dryRunRegenerateAction', 'runRegenerateAction', 'dryRunLinkMissingAction', 'runLinkMissingAction']);
  for (const m of exported) assert.doesNotMatch(m[2], /email|admin|user/i, `${m[1]} takes no identity`);
  assert.equal((src.match(/liveAdPackAdminRunner\(\)\./g) ?? []).length, 4);
  for (const method of ['dryRegenerate', 'runRegenerate', 'dryLinkMissing', 'runLinkMissing']) assert.match(src, new RegExp(`liveAdPackAdminRunner\\(\\)\\.${method}\\(`));
  assert.doesNotMatch(src, /generatePack|linkMissingLeads|createAdminClient|\.from\(/, 'the actions never reach past the runner');
  assert.ok(!/export (const|let|type|interface)/.test(src.replace(/export type/g, '')), "a 'use server' module exports only async functions");
});

test('the live runner takes the user from the verified session and every method gates on it first', () => {
  const server = code(read('./admin-server.ts'));
  assert.match(server, /supabase\.auth\.getUser\(\)/);
  const run = code(read('./admin-run.ts'));
  for (const fn of ['dryRegenerate', 'runRegenerate', 'dryLinkMissing', 'runLinkMissing']) {
    const body = run.slice(run.indexOf(`async function ${fn}(`));
    const firstAwait = body.indexOf('await ');
    assert.match(body.slice(firstAwait, firstAwait + 40), /gate\(\)/, `${fn} checks the admin before anything else`);
  }
});

test('the page gates on pageGuard and the config traces the fonts for /admin/ad-packs', () => {
  const page = code(read('../../app/admin/ad-packs/page.tsx'));
  assert.match(page, /pageGuard\(user\)/);
  assert.match(page, /redirect\("\/login\?redirect=\/admin\/ad-packs"\)/);
  assert.match(page, /notFound\(\)/);
  assert.ok(page.indexOf('pageGuard(user)') < page.indexOf('loadAdPacksAdmin()'), 'nothing is read before the guard');
  const config = code(read('../../../next.config.ts'));
  assert.match(config, /"\/admin\/ad-packs": AD_PACK_FONTS,/);
});

test('the admin reads never write, never touch leads, and select no lead details', () => {
  const server = code(read('./admin-server.ts'));
  assert.doesNotMatch(server, /\.(insert|update|upsert|delete|rpc)\(/);
  assert.doesNotMatch(server, /from\('leads'\)|crm_pushed_at/);
  assert.match(server, /select\('owner_id, pack_ad_id, match'\)/);
  const run = code(read('./admin-run.ts'));
  assert.doesNotMatch(run, /leadIds/, 'lead ids never leave the engine, only counts');
  assert.doesNotMatch(run + code(read('./admin-view.ts')), /server-only/);
});
