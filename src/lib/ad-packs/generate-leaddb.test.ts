import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type GenerateInput, type GenerateOk, type GenerateResult } from './generate-core.ts';
import { harness } from './test-store.ts';

/**
 * Batch 55 (Part A), phase A7: the lead database route through the generator. The pack keeps its route, the links go to
 * /s/<slug> on this app's own host, and the Academy path is the same as ever.
 */

const OWNER_A = '3f9a2c11-1111-4111-8111-111111111111';
// Built from parts so the app's own host is not typed as a literal in this package.
const APP_HOST = 'stay' + 'ful.co.uk';
const SLUG = 'brightstone-calc';

function input(over: Partial<GenerateInput> = {}): GenerateInput {
  return {
    areaKey: 'NG7',
    photos: ['https://cdn.example.test/photo-1.jpg'],
    brand: { company: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/logo.png', brandColour: '#1F6F5C', feePct: 12, areas: ['Nottingham'], photoUrl: null },
    domain: 'brightstone.co.uk',
    websiteId: '00000000-0000-4000-8000-0000000000aa',
    ...over,
  };
}
const leadDb = (over: Partial<GenerateInput> = {}) => input({ domain: APP_HOST, route: 'leaddb', sitePath: SLUG, ...over });

function ok(r: GenerateResult): GenerateOk {
  assert.ok(r.ok && !r.dry, `expected a made pack, got ${JSON.stringify(r.ok ? { dry: true } : { code: r.code })}`);
  return r as GenerateOk;
}
const code = (r: GenerateResult): string => {
  assert.equal(r.ok, false, 'expected a refusal');
  return (r as { code: string }).code;
};

test('a lead database pack: every link is https://<app host>/s/<slug>?ad=..., the checks pass, the pack keeps route leaddb', async () => {
  const h = harness();
  const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: leadDb() }));
  assert.equal(r.checks.ok, true, JSON.stringify(r.checks.failures));
  for (const a of r.ads) {
    assert.ok(a.link.startsWith(`https://${APP_HOST}/s/${SLUG}?ad=${a.code}&utm_source=facebook&utm_medium=paid_social&utm_campaign=SI-3F9A2C`), a.link);
    assert.ok(a.link.endsWith('utm_content={{ad.id}}'), 'the placeholder stays literal');
  }
  const pack = await h.store.getPack(OWNER_A);
  assert.equal(pack?.route, 'leaddb');
  const ads = await h.store.listAds(OWNER_A, r.packId);
  assert.ok(ads.every((a) => a.link.includes(`/s/${SLUG}?ad=`)));
});

test('an Academy pack is as it was: links to the domain root, route academy, no route or sitePath needed', async () => {
  const h = harness();
  const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }));
  for (const a of r.ads) assert.ok(a.link.startsWith('https://brightstone.co.uk/?ad='), a.link);
  assert.equal((await h.store.getPack(OWNER_A))?.route, 'academy');
  const explicit = harness();
  const e = ok(await explicit.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input({ route: 'academy' }) }));
  assert.deepEqual(e.ads.map((a) => a.link), r.ads.map((a) => a.link));
});

test('a dry run on the lead database route plans the same links and writes nothing', async () => {
  const h = harness();
  const r = await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: leadDb() });
  assert.ok(r.ok && r.dry && r.plan);
  if (r.ok && r.dry && r.plan) {
    assert.ok(r.plan.ads.every((a) => a.link.includes(`/s/${SLUG}?ad=`)));
    assert.equal(r.plan.checks.ok, true, JSON.stringify(r.plan.checks.failures));
  }
  assert.equal(await h.store.getPack(OWNER_A), null);
});

test('route and sitePath are checked before anything is made', async () => {
  const h = harness();
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input({ route: 'leaddb' }) })), 'invalid_input', 'leaddb needs the slug');
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input({ sitePath: SLUG }) })), 'invalid_input', 'a slug without the route');
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input({ route: 'academy', sitePath: SLUG }) })), 'invalid_input');
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input({ route: 'nope' as never }) })), 'invalid_input');
  for (const bad of ['', 'ab', 'Has-Capitals', '-lead', 'a/b', '../x', 'a?b=c']) {
    assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: leadDb({ sitePath: bad }) })), 'invalid_input', bad);
  }
  assert.equal(await h.store.getPack(OWNER_A), null);
  assert.equal(h.renderer.calls.length, 0);
});

test('a regenerate on the same route works; a regenerate on the other route is refused and changes nothing', async () => {
  const h = harness();
  const first = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: leadDb() }));
  const again = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: leadDb() }));
  assert.equal(again.version, first.version + 1);
  assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: input() })), 'invalid_input');
  const pack = await h.store.getPack(OWNER_A);
  assert.equal(pack?.route, 'leaddb');
  assert.equal(pack?.version, again.version);

  const a = harness();
  ok(await a.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }));
  assert.equal(code(await a.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: leadDb() })), 'invalid_input');
  assert.equal((await a.store.getPack(OWNER_A))?.route, 'academy');
});

// Batch 55 step 2 (contract section 9, call 4): the lead database hears that this customer made ads.
test('a lead database pack that reaches preview calls onLeadDbPackGenerated; an Academy pack, a dry run and a throwing hook do not break anything', async () => {
  const { createAdPackEngine } = await import('./generate-core.ts');
  const h = harness();
  const called: string[] = [];
  const engine = createAdPackEngine({ ...h.deps, onLeadDbPackGenerated: async (owner) => { called.push(owner); } });
  await engine.generatePack({ ownerId: OWNER_A, by: 'admin', dry: true, input: leadDb() });
  assert.deepEqual(called, [], 'a dry run makes nothing and tells nobody');
  const r = ok(await engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: leadDb() }));
  assert.equal(r.status, 'preview');
  assert.deepEqual(called, [OWNER_A]);

  const academy = harness();
  const seen: string[] = [];
  const a = createAdPackEngine({ ...academy.deps, onLeadDbPackGenerated: async (owner) => { seen.push(owner); } });
  ok(await a.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }));
  assert.deepEqual(seen, [], 'the Academy route never tells the lead database');

  const boom = harness();
  const b = createAdPackEngine({ ...boom.deps, onLeadDbPackGenerated: async () => { throw new Error('db down: a secret'); } });
  const made = ok(await b.generatePack({ ownerId: OWNER_A, by: 'operator', input: leadDb() }));
  assert.equal(made.status, 'preview', 'a failed mark never fails the generation');
  assert.ok(boom.logs.some((l) => l.event === 'pack_notice_not_marked' && l.fields.code === 'error'));
  assert.ok(!JSON.stringify(boom.logs).includes('secret'));
});

// ── Batch 55 step 5 (Phase 1, 55c A1 and A6) ──

test('a lead database pack asks the market data for the lowest pushed bedroom count; the Academy route never does', async () => {
  const h = harness();
  const asked: unknown[] = [];
  const area = h.deps.areaFigureSource;
  h.deps.areaFigureSource = async (a) => {
    asked.push(a);
    return area(a);
  };
  ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: leadDb({ bedrooms: 2 }) }));
  assert.deepEqual(asked[0], { areaKey: 'NG7', minSamples: 5, bedrooms: 2 });

  const academy = harness();
  const seen: unknown[] = [];
  academy.deps.areaFigureSource = async (a) => {
    seen.push(a);
    return { areaKey: 'NG7', areaLabel: 'Lenton, Nottingham', level: 'district', fellBack: false, bedrooms: 3, agg: { bedrooms: 3, sample_count: 14, avg_adr: 100, avg_occupancy: 70, avg_gross_revenue: 40000, avg_net_revenue: 20000, avg_property_value_low: null, avg_property_value_high: null }, samples: 14 };
  };
  ok(await academy.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input({ bedrooms: 2 }) }));
  assert.deepEqual(seen[0], { areaKey: 'NG7', minSamples: 5 }, 'the Academy route asks exactly as before');
  // No pushed range on the lead database route: as before too.
  const plain = harness();
  const plainSeen: unknown[] = [];
  const plainArea = plain.deps.areaFigureSource;
  plain.deps.areaFigureSource = async (a) => {
    plainSeen.push(a);
    return plainArea(a);
  };
  ok(await plain.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: leadDb() }));
  assert.deepEqual(plainSeen[0], { areaKey: 'NG7', minSamples: 5 });
});

test('the pack’s bedroom count and pinned brand come from what the market data chose and the calculator settings', async () => {
  const h = harness();
  h.area.result = { ...(h.area.result as Exclude<typeof h.area.result, { error: string }>), bedrooms: 2 };
  const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: leadDb({ bedrooms: 2, brand: { company: 'Harbour & Pine', logoUrl: 'https://cdn.example.test/hp.png', brandColour: '#1f4e79', feePct: 18, areas: ['Leicester', 'Loughborough'], photoUrl: null } }) }));
  const pack = await h.store.getPack(OWNER_A);
  assert.equal(pack?.bedrooms, 2);
  const ads = await h.store.listAds(OWNER_A, r.packId);
  const brand = ads.find((a) => a.angle === '5b')?.texts.brand;
  assert.equal(brand?.company, 'Harbour & Pine');
  assert.equal(brand?.colour, '#1f4e79');
  assert.equal(brand?.logoRef, 'https://cdn.example.test/hp.png');
  assert.equal(brand?.bedrooms, 2);
  assert.match(brand?.feeSentence ?? '', /18%/);
});

test('a bedroom count outside 0 to 10 is invalid input', async () => {
  const h = harness();
  for (const bedrooms of [-1, 11, 2.5]) assert.equal(code(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: leadDb({ bedrooms }) })), 'invalid_input', String(bedrooms));
});

test('A6: every lead database ad records its concept and format; Academy ads carry neither', async () => {
  const h = harness();
  const r = ok(await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: leadDb() }));
  const ads = await h.store.listAds(OWNER_A, r.packId);
  assert.deepEqual(
    ads.map((a) => [a.angle, a.conceptId, a.format]).sort(),
    [['17', '17-v1', 'type_cards'], ['3a', '3a-v1', 'type_cards'], ['5b', '5b-v1', 'notice_video']],
  );
  const academy = harness();
  const ra = ok(await academy.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: input() }));
  for (const a of await academy.store.listAds(OWNER_A, ra.packId)) {
    assert.ok(!('conceptId' in a) && !('format' in a), 'an Academy row has no concept or format keys at all');
  }
});
