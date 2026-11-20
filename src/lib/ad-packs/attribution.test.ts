import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchLeadToAd, linkLead, linkMissing, packAdLineView, type AttributionStore, type LinkRow, type PackAdRef } from './attribution.ts';
import { operatorCode, packCode } from './codes.ts';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const OPA = operatorCode(A);
const OPB = operatorCode(B);
const A5B1 = packCode(OPA, '5b', 1);
const A5B2 = packCode(OPA, '5b', 2);
const A3A2 = packCode(OPA, '3a', 2);
const B5B1 = packCode(OPB, '5b', 1);

const ads: PackAdRef[] = [
  { id: 'ad-a-5b-1', code: A5B1, ownerId: A, version: 1 }, // superseded by v2, still ours
  { id: 'ad-a-5b-2', code: A5B2, ownerId: A, version: 2 },
  { id: 'ad-a-3a-2', code: A3A2, ownerId: A, version: 2 },
  { id: 'ad-b-5b-1', code: B5B1, ownerId: B, version: 1 },
];
const none = new Map<string, string>();
const m = (adCodeRaw: string | null, utmContentRaw: string | null = null, known = none, packAds = ads) =>
  matchLeadToAd({ ownerId: A, adCodeRaw, utmContentRaw, packAds, knownMetaAdIds: known });

test('a known code links to the right ad', () => {
  assert.deepEqual(m(A5B2), { match: 'code', packAdId: 'ad-a-5b-2', adCodeSeen: A5B2, metaAdIdSeen: null });
  assert.equal(m(A3A2).packAdId, 'ad-a-3a-2');
});

test('a renamed ad still links: the code rides in the link, the name is never read', () => {
  // The Meta ad was renamed to anything; only the code in the link and the (changed) ad name differ.
  const renamed = ads.map((a) => (a.id === 'ad-a-5b-2' ? { ...a } : a));
  const r = m(A5B2, '120212345678901', none, renamed);
  assert.equal(r.match, 'code');
  assert.equal(r.packAdId, 'ad-a-5b-2');
  assert.equal(r.metaAdIdSeen, '120212345678901');
});

test('a superseded v1 code still links', () => {
  assert.deepEqual(m(A5B1), { match: 'code', packAdId: 'ad-a-5b-1', adCodeSeen: A5B1, metaAdIdSeen: null });
});

test('lowercase, padded and encoded codes normalise', () => {
  assert.equal(m(`  ${A5B2.toLowerCase()}  `).packAdId, 'ad-a-5b-2');
  assert.equal(m(encodeURIComponent(A5B2)).match, 'code');
  assert.equal(m(A5B2.replace(/-/g, '–')).match, 'code'); // en dashes
});

test('no code at all: none, lead kept as untagged', () => {
  assert.deepEqual(m(null), { match: 'none', packAdId: null, adCodeSeen: null, metaAdIdSeen: null });
  assert.equal(m('   ').match, 'none');
  assert.equal(m('   ').adCodeSeen, null);
});

test("another owner's code is foreign: not linked", () => {
  const r = m(B5B1);
  assert.equal(r.match, 'foreign_code');
  assert.equal(r.packAdId, null);
  // Not in packAds at all (not looked up) but another operator's code: still foreign.
  const r2 = m(packCode('CCCCCC', '3a', 1), null, none, ads.filter((a) => a.ownerId === A));
  assert.equal(r2.match, 'foreign_code');
  assert.equal(r2.packAdId, null);
});

test('a code that does not parse, or is unknown, is none; the code seen is kept, truncated to 40', () => {
  const junk = 'x'.repeat(80);
  const r = m(junk);
  assert.equal(r.match, 'none');
  assert.equal(r.adCodeSeen, 'x'.repeat(40));
  // Ours, well-formed, but not an ad we know (a code that was never generated).
  const unknown = packCode(OPA, '17', 9);
  assert.equal(m(unknown).match, 'none');
  assert.equal(m(unknown).adCodeSeen, unknown);
});

test('the literal {{ad.id}} placeholder is no Meta id; digits only are kept', () => {
  assert.equal(m(A5B2, '{{ad.id}}').metaAdIdSeen, null);
  assert.equal(m(A5B2, encodeURIComponent('{{ad.id}}')).metaAdIdSeen, null);
  assert.equal(m(A5B2, 'abc123').metaAdIdSeen, null);
  assert.equal(m(A5B2, '1'.repeat(31)).metaAdIdSeen, null);
  assert.equal(m(A5B2, ' 6001234567890 ').metaAdIdSeen, '6001234567890');
});

test('a Meta id alone links only if it was seen with a code for the same owner', () => {
  const known = new Map([['6001', 'ad-a-5b-2']]);
  assert.deepEqual(m(null, '6001', known), { match: 'ad_id', packAdId: 'ad-a-5b-2', adCodeSeen: null, metaAdIdSeen: '6001' });
  // Never seen: untagged, but the id is still captured.
  assert.deepEqual(m(null, '7002', known), { match: 'none', packAdId: null, adCodeSeen: null, metaAdIdSeen: '7002' });
  // Seen, but for an ad that is not this owner's: no link.
  assert.equal(m(null, '6001', new Map([['6001', 'ad-b-5b-1']])).match, 'none');
  // Placeholder: nothing to match.
  assert.equal(m(null, '{{ad.id}}', known).match, 'none');
});

// ── The injectable core ───────────────────────────────────────────────────

interface World {
  leads: Map<string, { ownerId: string; website: boolean; createdAt: string }>;
  sources: Map<string, { adCode: string | null; utmContent: string | null }>;
  packs: Map<string, { operatorCode: string; approvedAt: string | null }>;
  links: Map<string, LinkRow>;
  writes: string[];
}

function world(): World {
  return {
    leads: new Map(),
    sources: new Map(),
    packs: new Map([[A, { operatorCode: OPA, approvedAt: '2026-01-01T00:00:00Z' }]]),
    links: new Map(),
    writes: [],
  };
}

function fake(w: World): AttributionStore {
  return {
    async lead(id) {
      const l = w.leads.get(id);
      return l ? { ownerId: l.ownerId, isWebsiteLead: l.website } : null;
    },
    async sources(id) {
      return w.sources.get(id) ?? null;
    },
    async pack(o) {
      return w.packs.get(o) ?? null;
    },
    async packAds(o, also) {
      return ads.filter((a) => a.ownerId === o || (also !== null && a.code === also));
    },
    async knownMetaAdIds(o) {
      const out = new Map<string, string>();
      for (const l of w.links.values()) if (l.owner_id === o && l.match === 'code' && l.pack_ad_id && l.meta_ad_id_seen) out.set(l.meta_ad_id_seen, l.pack_ad_id);
      return out;
    },
    async upsertLink(row) {
      w.writes.push(`ad_pack_lead_links:${row.lead_id}`);
      w.links.set(row.lead_id, row);
    },
    async missingLeads({ ownerId, sinceApproved, limit }) {
      const out: { leadId: string; ownerId: string }[] = [];
      for (const [id, l] of w.leads) {
        const p = w.packs.get(l.ownerId);
        if (!p?.approvedAt || !l.website || w.links.has(id)) continue;
        if (ownerId && l.ownerId !== ownerId) continue;
        if (sinceApproved && l.createdAt < p.approvedAt) continue;
        out.push({ leadId: id, ownerId: l.ownerId });
      }
      return out.slice(0, limit);
    },
  };
}

function addLead(w: World, id: string, adCode: string | null, utm: string | null = null, owner = A, website = true, createdAt = '2026-02-01T00:00:00Z') {
  w.leads.set(id, { ownerId: owner, website, createdAt });
  w.sources.set(id, { adCode, utmContent: utm });
}

test('linkLead: a lead with a known code is linked and its Meta id kept', async () => {
  const w = world();
  addLead(w, 'l1', A5B2, '6001');
  assert.equal(await linkLead(fake(w), 'l1'), 'linked');
  assert.deepEqual(w.links.get('l1'), { lead_id: 'l1', owner_id: A, pack_ad_id: 'ad-a-5b-2', match: 'code', ad_code_seen: A5B2, meta_ad_id_seen: '6001' });
});

test('linkLead: a later lead with only that Meta id links by ad id', async () => {
  const w = world();
  addLead(w, 'l1', A5B2, '6001');
  addLead(w, 'l2', null, '6001');
  addLead(w, 'l3', null, '9999');
  const s = fake(w);
  await linkLead(s, 'l1');
  assert.equal(await linkLead(s, 'l2'), 'linked');
  assert.equal(w.links.get('l2')?.match, 'ad_id');
  assert.equal(await linkLead(s, 'l3'), 'untagged');
  assert.equal(w.links.get('l3')?.match, 'none');
  assert.equal(w.links.get('l3')?.meta_ad_id_seen, '9999');
});

test('linkLead: no code writes an untagged row and the lead is kept (nothing else is touched)', async () => {
  const w = world();
  addLead(w, 'l1', null);
  assert.equal(await linkLead(fake(w), 'l1'), 'untagged');
  assert.equal(w.links.get('l1')?.match, 'none');
  assert.ok(w.leads.has('l1'));
  assert.deepEqual(w.writes, ['ad_pack_lead_links:l1']);
});

test("linkLead: another owner's code is stored untagged as foreign_code, never linked", async () => {
  const w = world();
  addLead(w, 'l1', B5B1);
  assert.equal(await linkLead(fake(w), 'l1'), 'untagged');
  assert.equal(w.links.get('l1')?.match, 'foreign_code');
  assert.equal(w.links.get('l1')?.pack_ad_id, null);
});

test('linkLead: an owner with no approved pack (or no pack) writes nothing; so does a non-website lead', async () => {
  const w = world();
  w.packs.set(B, { operatorCode: OPB, approvedAt: null });
  addLead(w, 'draft', null, null, B);
  addLead(w, 'nopack', null, null, 'cccccccc-3333-4333-8333-333333333333');
  addLead(w, 'app', null, null, A, false);
  const s = fake(w);
  assert.equal(await linkLead(s, 'draft'), 'skipped_no_approved_pack');
  assert.equal(await linkLead(s, 'nopack'), 'skipped_no_approved_pack');
  assert.equal(await linkLead(s, 'app'), 'skipped_not_website_lead');
  assert.equal(await linkLead(s, 'missing'), 'skipped_not_found');
  assert.deepEqual(w.writes, []);
});

test('linkLead never throws: a failing store returns a code and logs only the lead id', async () => {
  const boom = new Proxy({}, { get() { throw new Error('secret address 1 High Street'); } }) as unknown as AttributionStore;
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    assert.equal(await linkLead(boom, 'lead-1'), 'error');
  } finally {
    console.error = orig;
  }
  assert.ok(logged.join('\n').includes('lead-1'));
  assert.ok(!logged.join('\n').includes('High Street'));
});

test('linkLead is idempotent: twice gives one row, same content', async () => {
  const w = world();
  addLead(w, 'l1', A5B1, '6001');
  const s = fake(w);
  await linkLead(s, 'l1');
  const first = { ...w.links.get('l1')! };
  await linkLead(s, 'l1');
  assert.equal(w.links.size, 1);
  assert.deepEqual(w.links.get('l1'), first);
});

test('linkMissing: dry lists lead ids and writes nothing; the real run links them; a second run finds none', async () => {
  const w = world();
  addLead(w, 'l1', A5B2);
  addLead(w, 'l2', null);
  addLead(w, 'old', A5B2, null, A, true, '2025-06-01T00:00:00Z'); // before approval
  addLead(w, 'app', null, null, A, false);
  const s = fake(w);

  const dry = await linkMissing(s, { dry: true });
  assert.deepEqual([dry.ok, dry.dry, dry.count, [...dry.leadIds].sort()], [true, true, 2, ['l1', 'l2']]);
  assert.deepEqual(w.writes, []);
  assert.equal(w.links.size, 0);

  const run = await linkMissing(s, {});
  assert.deepEqual([run.ok, run.count, run.linked, run.untagged, run.failed], [true, 2, 1, 1, 0]);
  assert.equal(w.links.size, 2);

  const again = await linkMissing(s, {});
  assert.deepEqual([again.ok, again.count, again.linked], [true, 0, 0]);
  assert.equal(w.writes.length, 2);
  const dryAgain = await linkMissing(s, { dry: true });
  assert.equal(dryAgain.count, 0);
});

test('linkMissing: sinceApproved false reaches leads from before approval; ownerId narrows', async () => {
  const w = world();
  addLead(w, 'old', A5B2, null, A, true, '2025-06-01T00:00:00Z');
  w.packs.set(B, { operatorCode: OPB, approvedAt: '2026-01-01T00:00:00Z' });
  addLead(w, 'b1', null, null, B);
  const s = fake(w);
  assert.equal((await linkMissing(s, { dry: true, sinceApproved: false, ownerId: A })).count, 1);
  assert.equal((await linkMissing(s, { dry: true, ownerId: A })).count, 0);
  assert.deepEqual((await linkMissing(s, { dry: true, ownerId: B })).leadIds, ['b1']);
});

test('linkMissing never throws', async () => {
  const boom = new Proxy({}, { get() { throw new Error('x'); } }) as unknown as AttributionStore;
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await linkMissing(boom, {});
    assert.deepEqual([r.ok, r.code, r.count], [false, 'error', 0]);
  } finally {
    console.error = orig;
  }
});

test('the lead page line: hidden without an approved pack, "Ad unknown" for none/foreign/missing, the ad when matched', () => {
  const ad = { code: A5B2, angle: '5b' };
  assert.deepEqual(packAdLineView({ hasApprovedPack: false, link: { match: 'code', packAdId: 'x' }, ad }), { kind: 'hidden' });
  assert.deepEqual(packAdLineView({ hasApprovedPack: false, link: null, ad: null }), { kind: 'hidden' });
  for (const link of [null, { match: 'none', packAdId: null }, { match: 'foreign_code', packAdId: null }]) {
    assert.deepEqual(packAdLineView({ hasApprovedPack: true, link, ad: null }), { kind: 'unknown', text: 'Ad unknown' });
  }
  assert.deepEqual(packAdLineView({ hasApprovedPack: true, link: { match: 'code', packAdId: 'x' }, ad }), { kind: 'matched', text: `Ad: ${A5B2} · Tenant notice` });
  assert.equal(packAdLineView({ hasApprovedPack: true, link: { match: 'ad_id', packAdId: 'x' }, ad }).kind, 'matched');
  // The ad row is gone (deleted): unknown, not a crash.
  assert.equal(packAdLineView({ hasApprovedPack: true, link: { match: 'code', packAdId: 'x' }, ad: null }).kind, 'unknown');
});
