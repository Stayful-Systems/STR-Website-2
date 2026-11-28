import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANGLES, type Angle } from './codes.ts';
import { buildFigure } from './figures.ts';
import { factsFor, checkLineAgainstFacts, allowedNumbers } from './facts.ts';
import { ldConceptFor, renderLdPack, type Look } from './ld-angles.ts';
import {
  chooseLook,
  colourHistogram,
  frameCorrelation,
  histogramOverlap,
  ldGateChecks,
  picturesTooSimilar,
  HIST_BINS,
  THUMB,
  PICTURE_MAX_CORRELATION,
  PICTURE_MAX_OVERLAP,
  type LdGateAd,
  type PictureStats,
} from './ld-gate.ts';
import { mergeLdPictureChecks, mergeVideoChecks, runChecks, CHECK_IDS, type CheckInput } from './checks.ts';

const AGG = { bedrooms: 3, sample_count: 14, avg_gross_revenue: 48_200, avg_net_revenue: 31_000, avg_occupancy: 71.4 };
const FIG = buildFigure({ area_label: 'Leicester', agg: AGG, feePct: 12, netIncludesFee: false });
const BRAND = { company: 'Harbour & Pine', area: 'Leicester', feePct: 12 };
const FACTS = factsFor({ company: BRAND.company, areas: ['Leicester', 'Loughborough'], feePct: 12, figure: FIG, bedrooms: { min: 2, max: 3 } });

function goodAds(look?: Look): LdGateAd[] {
  const p = renderLdPack(BRAND, FIG, look);
  return ANGLES.map((a) => ({ angle: a, format: ldConceptFor(a).format, texts: p[a], screenLines: [...p[a].screenLines], script: p[a].script ? [...p[a].script!] : null }));
}

function solid(r: number, g: number, b: number): PictureStats {
  const px: number[] = [];
  for (let i = 0; i < 100; i++) px.push(r, g, b);
  return { hist: colourHistogram(px, 3), thumb: new Array(THUMB * THUMB).fill(Math.round((r + g + b) / 3)) };
}
function gradient(dir: 'h' | 'v', tint: [number, number, number]): PictureStats {
  const px: number[] = [];
  const thumb: number[] = [];
  for (let y = 0; y < THUMB; y++)
    for (let x = 0; x < THUMB; x++) {
      const v = dir === 'h' ? (x * 255) / (THUMB - 1) : (y * 255) / (THUMB - 1);
      thumb.push(v);
      px.push(Math.min(255, v * tint[0]), Math.min(255, v * tint[1]), Math.min(255, v * tint[2]));
    }
  return { hist: colourHistogram(px, 3), thumb };
}

const rulesOf = (ads: LdGateAd[], extra: Partial<Parameters<typeof ldGateChecks>[0]> = {}) => ldGateChecks({ ads, facts: FACTS, areaLabel: 'Leicester', ...extra }).map((f) => f.rule);

test('gate: a good pack passes every rule', () => {
  assert.deepEqual(ldGateChecks({ ads: goodAds(), facts: FACTS, areaLabel: 'Leicester' }), []);
  assert.deepEqual(ldGateChecks({ ads: goodAds({ base: 'white', hook: 'b' }), facts: FACTS, areaLabel: 'Leicester' }), []);
});

test('gate: two ads of the same format fail', () => {
  const ads = goodAds();
  ads[2].format = 'phone_recording';
  assert.ok(rulesOf(ads).includes('format_repeated'));
  const none = goodAds();
  none[1].format = null;
  assert.ok(rulesOf(none).includes('format_missing'));
});

test('gate: a line in two ads fails (copy and on-screen), the CTA line does not', () => {
  const copy = goodAds();
  copy[1].texts.headlines[0] = copy[0].texts.headlines[2];
  assert.ok(rulesOf(copy).includes('line_shared'));
  const screen = goodAds();
  screen[2].screenLines[1] = screen[0].screenLines[1];
  assert.ok(rulesOf(screen).includes('line_shared'));
  assert.ok(!rulesOf(goodAds()).includes('line_shared'));
});

test('gate: a line the facts do not back fails', () => {
  const ads = goodAds();
  ads[0].texts.descriptions[0] = 'You will earn more, guaranteed';
  ads[1].screenLines[1] = 'Our fee is 15% plus extras';
  ads[2].texts.headlines[0] = 'Exclusive to 40 landlords';
  const r = rulesOf(ads);
  for (const rule of ['you_will_earn', 'guarantee', 'percent_not_fee', 'exclusive', 'number_not_fact']) assert.ok(r.includes(rule), rule);
});

test('gate: offer late, question first, no owner line, frame one or CTA wrong all fail', () => {
  const late = goodAds();
  late[0].texts.primary[0] = 'Tenant handed in their notice? Harbour & Pine can help, and you stay the owner. In Leicester we offer a free income report for landlords. Get your free income report.';
  const r1 = rulesOf(late);
  assert.ok(r1.includes('offer_late') && r1.includes('question_first'));
  const owner = goodAds();
  owner[1].texts.primary[1] = 'Homeowners in Leicester moving abroad: free income report for your home. Get your free income report.';
  assert.ok(rulesOf(owner).includes('owner_missing'));
  const frame = goodAds();
  frame[2].screenLines[0] = 'Short lets are popular';
  frame[2].screenLines[frame[2].screenLines.length - 1] = 'Visit our website';
  const r3 = rulesOf(frame);
  assert.ok(r3.includes('frame_one') && r3.includes('cta_last'));
  const voice = goodAds();
  voice[0].script![0] = 'Has your tenant handed in their notice?';
  assert.ok(rulesOf(voice).includes('voice_first'));
});

test('picture measure: identical starts are too similar, different ones pass', () => {
  const a = solid(245, 244, 237);
  assert.equal(histogramOverlap(a.hist, a.hist), 100);
  assert.ok(picturesTooSimilar(a, a).tooSimilar);
  const h = gradient('h', [1, 0.2, 0.2]);
  const v = gradient('v', [0.2, 0.2, 1]);
  const m = picturesTooSimilar(h, v);
  assert.ok(m.overlap < PICTURE_MAX_OVERLAP && m.correlation < PICTURE_MAX_CORRELATION, JSON.stringify(m));
  assert.equal(frameCorrelation(h.thumb, h.thumb), 100);
  assert.equal(colourHistogram([0, 0, 0, 255, 255, 255, 255, 255], 4).length, HIST_BINS);
});

test('gate: the picture rule runs only when asked, and fails a pair that starts alike', () => {
  const ads = goodAds();
  ads[0].picture = solid(250, 250, 250);
  ads[1].picture = solid(250, 250, 250);
  ads[2].picture = gradient('v', [0.2, 0.2, 1]);
  assert.ok(!rulesOf(ads).includes('picture_similar'));
  assert.ok(rulesOf(ads, { pictures: true }).includes('picture_similar'));
  ads[1].picture = gradient('h', [1, 0.2, 0.2]);
  assert.ok(!rulesOf(ads, { pictures: true }).includes('picture_similar'));
  ads[1].picture = null;
  assert.ok(rulesOf(ads, { pictures: true }).includes('picture_missing'));
});

test('same area: a second customer in the same area gets a different base and frame one, for free', () => {
  const first = chooseLook([]);
  assert.deepEqual(first, { look: { base: 'cream', hook: 'a' }, switched: false });
  const second = chooseLook([first.look]);
  assert.equal(second.switched, true);
  assert.notEqual(second.look.base, first.look.base);
  assert.notEqual(second.look.hook, first.look.hook);
  const p1 = renderLdPack(BRAND, FIG, first.look);
  const p2 = renderLdPack({ ...BRAND, company: 'Other Lets' }, FIG, second.look);
  for (const a of ANGLES) assert.notEqual(p1[a].screenLines[0], p2[a].screenLines[0]);
  // All four taken: the least used.
  const all: Look[] = [
    { base: 'cream', hook: 'a' },
    { base: 'white', hook: 'b' },
    { base: 'white', hook: 'a' },
    { base: 'cream', hook: 'b' },
    { base: 'cream', hook: 'a' },
  ];
  assert.notDeepEqual(chooseLook(all).look, { base: 'cream', hook: 'a' });
});

test('facts: the numbers allowed are the fee, the forecast, the figure and the bedrooms', () => {
  const n = allowedNumbers(FACTS);
  for (const v of [12, 2, 3, 14]) assert.ok(n.has(v), String(v));
  assert.deepEqual(checkLineAgainstFacts('A 12-month forecast for a 3-bed', FACTS), []);
  assert.deepEqual(checkLineAgainstFacts(FIG!.sentence, FACTS), []);
  assert.ok(checkLineAgainstFacts('About £2,100 a month', FACTS).some((p) => p.rule === 'pound_not_example'));
  assert.ok(checkLineAgainstFacts('Rated best in Leicester', FACTS).some((p) => p.rule === 'superlative'));
  assert.ok(checkLineAgainstFacts('As seen on ' + 'Stay' + 'ful', FACTS).some((p) => p.rule === 'source_brand'));
  const noFee = factsFor({ company: 'X', areas: ['York'], feePct: null, figure: null });
  assert.ok(checkLineAgainstFacts('Our management fee is 12%.', noFee).some((p) => p.rule === 'percent_not_fee'));
  assert.deepEqual(checkLineAgainstFacts('Flat 9 Lets in NG7', factsFor({ company: 'Flat 9 Lets', areas: ['NG7'], feePct: null, figure: null })), []);
});

// ── runChecks integration ──

function checkInput(ld?: CheckInput['ld']): CheckInput {
  const p = renderLdPack(BRAND, FIG);
  const ads = ANGLES.map((angle: Angle) => ({
    angle,
    code: `SI-ABC123-${angle.toUpperCase()}-1`,
    adName: `SI-ABC123-${angle.toUpperCase()}-1`,
    link: 'https://example.com/',
    texts: { primary: p[angle].primary, headlines: p[angle].headlines, descriptions: p[angle].descriptions },
  }));
  return { brand: { company: BRAND.company, logoUrl: null, brandColour: '#1A5FB4', feePct: 12, areaLabel: 'Leicester', areaKey: 'LE', typeOnly: true }, ads, figures: [], operatorCode: 'ABC123', domain: 'example.com', ...(ld ? { ld } : {}) };
}

test('runChecks: without ld (the Academy route) the results are the batch 38 rows only', () => {
  const r = runChecks(checkInput());
  assert.deepEqual(r.results.map((x) => x.check), [...CHECK_IDS]);
  const merged = mergeVideoChecks(r, []);
  assert.deepEqual(merged.results.map((x) => x.check), [...CHECK_IDS]);
});

test('runChecks: with ld, the gate rows follow, and a gate failure fails the pack with a plain reason', () => {
  const good = runChecks(checkInput({ ads: goodAds(), facts: FACTS, areaLabel: 'Leicester' }));
  assert.ok(good.results.some((x) => x.check === 'ld_format' && x.ok));
  assert.equal(good.failures.filter((f) => f.check.startsWith('ld_')).length, 0);
  const bad = goodAds();
  bad[1].format = 'phone_recording';
  const r = runChecks(checkInput({ ads: bad, facts: FACTS, areaLabel: 'Leicester' }));
  assert.equal(r.ok, false);
  const f = r.failures.find((x) => x.check === 'ld_format');
  assert.ok(f && f.detail.length > 10 && !/_/.test(f.detail));
  // The video merge keeps the gate's rows.
  assert.ok(mergeVideoChecks(r, []).results.some((x) => x.check === 'ld_format'));
});

test('mergeLdPictureChecks: replaces earlier picture failures and keeps the rest', () => {
  const base = runChecks(checkInput({ ads: goodAds(), facts: FACTS, areaLabel: 'Leicester' }));
  const alike = mergeLdPictureChecks(base, [
    { angle: '5b', picture: solid(250, 250, 250) },
    { angle: '3a', picture: solid(250, 250, 250) },
    { angle: '17', picture: gradient('v', [0.2, 0.2, 1]) },
  ]);
  assert.ok(alike.failures.some((f) => f.rule === 'picture_similar'));
  const fixed = mergeLdPictureChecks(alike, [
    { angle: '5b', picture: gradient('h', [1, 0.2, 0.2]) },
    { angle: '3a', picture: solid(250, 250, 250) },
    { angle: '17', picture: gradient('v', [0.2, 0.2, 1]) },
  ]);
  assert.ok(!fixed.failures.some((f) => f.check === 'ld_picture'));
  assert.equal(fixed.failures.length, base.failures.length);
});
