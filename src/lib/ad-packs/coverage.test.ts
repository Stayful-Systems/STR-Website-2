import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANGLES } from './codes.ts';
import { buildFigure } from './figures.ts';
import { AD_LIMITS, checkLength, firstSentence } from './limits.ts';
import { factsFor, checkLineAgainstFacts } from './facts.ts';
import { CTA_LINE, ldConceptFor, renderLdPack, type LdBrand } from './ld-angles.ts';
import { chooseLook, ldGateChecks, type LdGateAd } from './ld-gate.ts';
import {
  cleanCoverageAreas,
  coverageColumns,
  coverageOfPack,
  inAreaPhrase,
  joinNatural,
  lookKey,
  makeCoverage,
  manageSentence,
  MAX_COVERAGE_AREAS,
  namesCoverage,
  offerNeedle,
  placeCandidates,
  shortInPhrase,
  spokenInPhrase,
  spokenNames,
  UK_LOOK_KEY,
  type Coverage,
} from './coverage.ts';
import { MemoryAdPackStore } from './test-store.ts';

const AGG = { bedrooms: 3, sample_count: 14, avg_gross_revenue: 48_200, avg_net_revenue: 31_000, avg_occupancy: 71.4 };
const FIG = buildFigure({ area_label: 'Leeds', agg: AGG, feePct: 12, netIncludesFee: false });
const SEVEN = ['Leeds', 'York', 'Harrogate', 'Wakefield', 'Bradford', 'Halifax', 'Huddersfield'];

const COVERAGES: { name: string; c: Coverage }[] = [
  { name: 'nationwide', c: { mode: 'uk', areas: [] } },
  { name: '1 area', c: { mode: 'areas', areas: ['Leeds'] } },
  { name: '3 areas', c: { mode: 'areas', areas: SEVEN.slice(0, 3) } },
  { name: '7 areas', c: { mode: 'areas', areas: SEVEN } },
];

// ── The phrases ──

test('coverage phrases: UK, one, three and seven areas', () => {
  const [uk, one, three, seven] = COVERAGES.map((x) => x.c);
  assert.equal(inAreaPhrase(uk), 'across the UK');
  assert.equal(inAreaPhrase(one), 'in Leeds');
  assert.equal(inAreaPhrase(three), 'in Leeds, York and Harrogate');
  assert.equal(inAreaPhrase(seven), 'in Leeds, York, Harrogate and nearby areas');
  assert.equal(shortInPhrase(uk), 'across the UK');
  assert.equal(shortInPhrase(three), 'in Leeds, York and more');
  assert.equal(shortInPhrase({ mode: 'areas', areas: ['Leeds', 'York'] }), 'in Leeds and York');
  assert.equal(spokenInPhrase(seven), 'in Leeds, York and nearby areas');
  assert.equal(manageSentence('Acme', uk), 'Acme manages short lets across the UK.');
  assert.equal(manageSentence('Acme', seven), 'Acme manages short lets in Leeds, York, Harrogate, Wakefield, Bradford, Halifax and Huddersfield.');
  assert.equal(manageSentence('', one), 'Our team manages short lets in Leeds.');
  assert.equal(joinNatural(['A', 'B', 'C']), 'A, B and C');
  assert.deepEqual(placeCandidates(three), ['Leeds, York and more', 'Leeds and more', 'Leeds', 'your area']);
  assert.deepEqual(placeCandidates(uk), ['the UK']);
});

test('coverage phrases: a district label keeps its full name alone, and its first part in a list', () => {
  assert.deepEqual(spokenNames({ mode: 'areas', areas: ['Lenton, Nottingham'] }), ['Lenton, Nottingham']);
  assert.deepEqual(spokenNames({ mode: 'areas', areas: ['Lenton, Nottingham', 'York'] }), ['Lenton', 'York']);
  assert.equal(inAreaPhrase({ mode: 'areas', areas: ['Lenton, Nottingham'] }), 'in Lenton, Nottingham');
});

test('coverage phrases: long names make the opening phrase name fewer, never the long list', () => {
  const long: Coverage = { mode: 'areas', areas: ['Newcastle upon Tyne and Gateshead', 'Middlesbrough and Stockton-on-Tees', 'Sunderland'] };
  assert.ok(inAreaPhrase(long).length <= 60, inAreaPhrase(long));
  assert.ok(inAreaPhrase(long).startsWith('in Newcastle upon Tyne and Gateshead'));
  assert.ok(shortInPhrase(long).length <= 45, shortInPhrase(long));
});

test('coverage: cleaning, making and reading a stored pack', () => {
  assert.deepEqual(cleanCoverageAreas([' Leeds ', 'leeds', 'York']), ['Leeds', 'York']);
  assert.equal(cleanCoverageAreas(['']), null);
  assert.equal(cleanCoverageAreas(['x'.repeat(81)]), null);
  assert.equal(cleanCoverageAreas([1]), null);
  assert.equal(cleanCoverageAreas(Array.from({ length: MAX_COVERAGE_AREAS + 1 }, (_, i) => `Town ${i}`)), null);
  assert.deepEqual(makeCoverage('uk', ['ignored']), { mode: 'uk', areas: [] });
  assert.equal(makeCoverage('areas', []), null);
  assert.equal(makeCoverage('everywhere', ['Leeds']), null);
  // A lead database pack made before Phase 3 (coverage null) reads as its one area: today's wording.
  assert.deepEqual(coverageOfPack({ coverage: null, coverageAreas: [], areaLabel: 'Lenton, Nottingham' }), { mode: 'areas', areas: ['Lenton, Nottingham'] });
  assert.deepEqual(coverageOfPack({ coverage: 'uk', coverageAreas: [], areaLabel: 'Leeds' }), { mode: 'uk', areas: [] });
  assert.deepEqual(coverageOfPack({ coverage: 'areas', coverageAreas: ['York', 'Leeds'], areaLabel: 'York' }), { mode: 'areas', areas: ['York', 'Leeds'] });
  assert.deepEqual(coverageColumns({ mode: 'uk', areas: [] }), { coverage: 'uk', coverageAreas: [] });
  assert.equal(offerNeedle({ mode: 'uk', areas: [] }), 'uk');
  assert.equal(offerNeedle({ mode: 'areas', areas: ['Leeds', 'York'] }), 'leeds');
  assert.ok(namesCoverage('Landlords across the UK: free', { mode: 'uk', areas: [] }));
  assert.ok(!namesCoverage('Landlords in Leeds', { mode: 'uk', areas: [] }));
});

// ── The copy, per coverage ──

for (const { name, c } of COVERAGES) {
  const brand: LdBrand = { company: 'Harbour & Pine', area: 'Leeds', feePct: 12, coverage: c };
  const pack = renderLdPack(brand, FIG);
  const facts = factsFor({ company: brand.company, areas: ['Leeds'], feePct: 12, figure: FIG, bedrooms: { min: 2, max: 3 }, coverage: c });
  const manage = manageSentence(brand.company, c);

  test(`coverage copy (${name}): the first 125 characters say who, where, "free" and "report"; the long list stays out`, () => {
    for (const a of ANGLES) {
      for (const t of pack[a].primary) {
        const head = t.slice(0, AD_LIMITS.primary.visible);
        assert.match(head, /\b(?:Landlords|Homeowners)\b/, t);
        assert.ok(head.includes(inAreaPhrase(c)), `${inAreaPhrase(c)} | ${t}`);
        assert.match(head, /\bfree\b/i, t);
        assert.match(head, /\breport\b/i, t);
        if (c.mode === 'areas' && c.areas.length > 3) assert.ok(!head.includes(c.areas.at(-1)!), `the last area is not in the first 125: ${t}`);
        assert.ok(!firstSentence(t).includes('?'), t);
        assert.match(t, /\byou stay the owner\b/i, t);
        assert.ok(t.endsWith(`${CTA_LINE}.`), t);
        assert.notEqual(checkLength('primary', t).level, 'red', t);
      }
      assert.equal(pack[a].screenLines.at(-1), CTA_LINE);
      if (pack[a].script) {
        assert.match(pack[a].script![0], /\bfree\b.*\breport\b/i);
        assert.ok(pack[a].script![0].includes(spokenInPhrase(c)), pack[a].script![0]);
        assert.equal(pack[a].script!.at(-1), `${CTA_LINE}.`);
      }
    }
  });

  test(`coverage copy (${name}): every primary text has the sentence naming every chosen area`, () => {
    for (const a of ANGLES) for (const t of pack[a].primary) assert.ok(t.includes(manage), `${manage} | ${t}`);
    if (c.mode === 'areas') for (const n of c.areas) assert.ok(manage.includes(n), n);
  });

  test(`coverage copy (${name}): frame one and the fifth headline say where, short`, () => {
    for (const a of ANGLES) {
      assert.ok(pack[a].screenLines[0].includes(shortInPhrase(c)), pack[a].screenLines[0]);
      const h = pack[a].headlines.at(-1)!;
      assert.equal(pack[a].headlines.length, 5);
      assert.ok(h.length <= AD_LIMITS.headline.hard, h);
      assert.ok(c.mode === 'uk' ? /\bUK\b/.test(h) : h.includes('Leeds'), h);
      if (c.mode === 'areas' && c.areas.length > 2) assert.match(h, /and more$/, h);
    }
  });

  test(`coverage copy (${name}): every line passes the facts list, and no line is in two ads (the CTA excepted)`, () => {
    const seen = new Map<string, string>();
    for (const a of ANGLES) {
      const r = pack[a];
      for (const t of [...r.primary, ...r.headlines, ...r.descriptions, ...r.screenLines, ...(r.script ?? [])]) {
        assert.deepEqual(checkLineAgainstFacts(t, facts), [], t);
        assert.ok(!/[{}!—]/.test(t), t);
      }
      const mine = new Set([...r.primary, ...r.headlines, ...r.descriptions, ...r.screenLines, ...(r.script ?? [])].map((l) => l.toLowerCase().replace(/[.\s]+$/, '')));
      for (const l of mine) {
        if (l === CTA_LINE.toLowerCase()) continue;
        assert.ok(!seen.has(l) || seen.get(l) === a, `"${l}" is in ${seen.get(l)} and ${a}`);
        seen.set(l, a);
      }
    }
  });

  test(`coverage gate (${name}): the pack passes, offer first looks for the coverage`, () => {
    const ads: LdGateAd[] = ANGLES.map((a) => ({ angle: a, format: ldConceptFor(a).format, texts: pack[a], screenLines: [...pack[a].screenLines], script: pack[a].script ? [...pack[a].script!] : null }));
    assert.deepEqual(ldGateChecks({ ads, facts, areaLabel: 'Leeds', coverage: c }), []);
    // The same pack checked against another coverage fails the offer rule.
    const other: Coverage = c.mode === 'uk' ? { mode: 'areas', areas: ['Bristol'] } : { mode: 'uk', areas: [] };
    const rules = ldGateChecks({ ads, facts, areaLabel: 'Leeds', coverage: other }).map((f) => f.rule);
    assert.ok(rules.includes('offer_late') && rules.includes('frame_one'), rules.join(','));
  });
}

test('coverage copy: one long area name still fits every limit (the fallbacks keep the offer and the owner line)', () => {
  const c: Coverage = { mode: 'areas', areas: ['Newcastle upon Tyne and Gateshead'] };
  const pack = renderLdPack({ company: 'Oakridge Property Lettings and Management', area: 'x', feePct: 12.5, coverage: c }, null);
  for (const a of ANGLES) {
    for (const t of pack[a].primary) {
      assert.ok(t.length <= AD_LIMITS.primary.hard, t);
      assert.match(t, /\byou stay the owner\b/i);
      assert.ok(t.slice(0, 125).includes('Newcastle upon Tyne and Gateshead'));
    }
    for (const h of pack[a].headlines) assert.ok(h.length <= AD_LIMITS.headline.hard, h);
  }
});

test('coverage copy: without a coverage the single area reads as before (in-flight packs)', () => {
  const before = renderLdPack({ company: 'A', area: 'York', feePct: null }, null);
  const one = renderLdPack({ company: 'A', area: 'ignored', feePct: null, coverage: { mode: 'areas', areas: ['York'] } }, null);
  assert.deepEqual(before, one);
  assert.ok(before['5b'].primary[0].startsWith('Landlords in York: get a free report'));
});

// ── The same-area look ──

test('coverage look: nationwide packs share one pool, an areas pack is keyed by its first area', async () => {
  assert.equal(lookKey({ mode: 'uk', areas: [] }, 'LS'), UK_LOOK_KEY);
  assert.equal(lookKey({ mode: 'areas', areas: ['Leeds', 'York'] }, 'LS'), 'LS');
  const store = new MemoryAdPackStore();
  const mk = async (owner: string, coverage: 'uk' | 'areas' | null, areaKey: string, look: { base: 'cream' | 'white'; hook: 'a' | 'b' }) => {
    const p = await store.insertPack({ ownerId: owner, websiteId: null, operatorCode: owner.slice(0, 6).toUpperCase(), status: 'preview', route: 'leaddb' });
    await store.updatePack(owner, p.id, { coverage, coverageAreas: coverage === 'areas' ? ['Leeds'] : [], areaKey });
    await store.insertAds(owner, [
      { packId: p.id, ownerId: owner, version: 1, angle: '5b', n: 1, code: `SI-${owner.slice(0, 6).toUpperCase()}-5B-1`, adName: 'x', link: 'https://x.test/', texts: { primary: [], headlines: [], descriptions: [], ld: { screenLines: [], look } }, leadForm: [], files: { images: [], video: null } },
    ]);
  };
  await mk('aaaaaa01-0000-4000-8000-000000000001', 'uk', 'LS', { base: 'cream', hook: 'a' });
  await mk('bbbbbb02-0000-4000-8000-000000000002', 'areas', 'LS', { base: 'white', hook: 'b' });
  await mk('cccccc03-0000-4000-8000-000000000003', null, 'LS', { base: 'white', hook: 'a' });
  const me = 'dddddd04-0000-4000-8000-000000000004';
  assert.deepEqual(await store.otherLooksInArea(me, UK_LOOK_KEY), [{ base: 'cream', hook: 'a' }]);
  assert.deepEqual(await store.otherLooksInArea(me, 'LS'), [{ base: 'white', hook: 'b' }, { base: 'white', hook: 'a' }]);
  assert.deepEqual(chooseLook(await store.otherLooksInArea(me, UK_LOOK_KEY)).look, { base: 'white', hook: 'b' });
});
