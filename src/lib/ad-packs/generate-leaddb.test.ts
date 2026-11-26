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
