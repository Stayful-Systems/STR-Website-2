import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MIN_AREA_SAMPLES, NET_INCLUDES_MANAGEMENT_FEE, chooseSource, chooseSourceFor, matchArea, modalGroup, parseAreaKey, parseMinAreaSamples, type AreaOption } from './area.ts';
import type { MarketBedroomAgg } from '../market/types.ts';

const opt = (o: Partial<AreaOption> & Pick<AreaOption, 'areaKey' | 'level' | 'areaName' | 'samples'>): AreaOption => ({
  label: o.areaName,
  adLabel: o.areaName,
  areaCode: o.areaKey.replace(/\d.*$/, ''),
  localities: [],
  ...o,
});

const OPTIONS: AreaOption[] = [
  opt({ areaKey: 'NG', level: 'area', areaName: 'Nottingham', samples: 40 }),
  opt({ areaKey: 'NG7', level: 'district', areaName: 'Nottingham', samples: 12, localities: ['Lenton', 'Dunkirk', 'Radford'] }),
  opt({ areaKey: 'NG1', level: 'district', areaName: 'Nottingham', samples: 20, localities: ['City Centre', 'The Lace Market'] }),
  opt({ areaKey: 'CB', level: 'area', areaName: 'Cambridge', samples: 30 }),
  opt({ areaKey: 'CB1', level: 'district', areaName: 'Cambridge', samples: 18, localities: ['Mill Road', 'Romsey'] }),
  opt({ areaKey: 'LE', level: 'area', areaName: 'Leicester', samples: 25 }),
  opt({ areaKey: 'LE2', level: 'district', areaName: 'Leicester', samples: 9, localities: ['Clarendon Park', 'Knighton'] }),
  opt({ areaKey: 'AL', level: 'area', areaName: 'St Albans', samples: 6 }),
  opt({ areaKey: 'HU', level: 'area', areaName: 'Hull', samples: 11 }),
];
const m = (...areas: string[]) => matchArea(areas, OPTIONS)?.areaKey ?? null;

test('NET_INCLUDES_MANAGEMENT_FEE is pinned: change it only after re-reading the block in area.ts', () => {
  // The analyser's net (src/lib/analysis.ts) takes 15% platform + 15% management + 18% cleaning off the gross.
  // That 15% is not the operator's fee and the stored column is written outside this repo, so the conservative
  // reading stands: net is NOT treated as already carrying the operator's fee.
  assert.equal(NET_INCLUDES_MANAGEMENT_FEE, false);
});

test('matchArea: a town name pre-selects its postcode area', () => {
  assert.equal(m('Nottingham'), 'NG');
  assert.equal(m('nottingham'), 'NG');
  assert.equal(m('  NOTTINGHAM  '), 'NG');
  assert.equal(m('Cambridge'), 'CB');
  assert.equal(m('St. Albans'), 'AL');
  assert.equal(m('st albans'), 'AL');
});

test('matchArea: a locality pre-selects its district', () => {
  assert.equal(m('Lenton'), 'NG7');
  assert.equal(m('clarendon park'), 'LE2');
  assert.equal(m('Mill Road'), 'CB1');
  assert.equal(m('The Lace Market'), 'NG1');
});

test('matchArea: a postcode or outward code pre-selects its district, else its area', () => {
  assert.equal(m('NG7 2AB'), 'NG7');
  assert.equal(m('ng7'), 'NG7');
  assert.equal(m('NG72AB'), 'NG7');
  assert.equal(m('CB1'), 'CB1');
  assert.equal(m('CB4 1AB'), 'CB', 'CB4 is not in the list: its postcode area is');
  assert.equal(m('NG'), 'NG');
  assert.equal(m('hu'), 'HU');
});

test('matchArea: prefix on a word boundary, in either direction', () => {
  assert.equal(m('Nottingham city centre'), 'NG');
  assert.equal(m('Cambridge and surrounding villages'), 'CB');
  assert.equal(m('Clarendon'), 'LE2');
  assert.equal(m('Mill'), 'CB1', '"Mill" is the first whole word of "Mill Road"');
  assert.equal(m('Mil'), null, 'half a word is not a match');
});

test('matchArea: whole words inside the text; never half a word', () => {
  assert.equal(m('Central Cambridge'), 'CB');
  assert.equal(m('North Hull'), 'HU');
  assert.equal(m('Hullabaloo'), null);
  assert.equal(m('Camb'), null);
});

test('matchArea: nothing, an empty list and a stranger give null; only the first area counts', () => {
  assert.equal(m(), null);
  assert.equal(m(''), null);
  assert.equal(m('   '), null);
  assert.equal(m('Atlantis'), null);
  assert.equal(matchArea(['Cambridge'], []), null);
  assert.equal(m('Atlantis', 'Cambridge'), null, 'areas[1] is ignored');
  assert.equal(m('Cambridge', 'Leicester'), 'CB');
});

test('matchArea: deterministic: more reports win a tie, then the lower key; input order is irrelevant', () => {
  const twin = [
    opt({ areaKey: 'LS2', level: 'district', areaName: 'Leeds', samples: 5, localities: ['Headingley'] }),
    opt({ areaKey: 'LS6', level: 'district', areaName: 'Leeds', samples: 5, localities: ['Headingley'] }),
    opt({ areaKey: 'LS4', level: 'district', areaName: 'Leeds', samples: 9, localities: ['Headingley'] }),
  ];
  assert.equal(matchArea(['Headingley'], twin)?.areaKey, 'LS4');
  assert.equal(matchArea(['Headingley'], [...twin].reverse())?.areaKey, 'LS4');
  assert.equal(matchArea(['Headingley'], twin.slice(0, 2))?.areaKey, 'LS2');
  assert.equal(matchArea(['Headingley'], twin.slice(0, 2).reverse())?.areaKey, 'LS2');
  const before = JSON.stringify(OPTIONS);
  matchArea(['Nottingham'], OPTIONS);
  assert.equal(JSON.stringify(OPTIONS), before, 'the list is not reordered');
});

const g = (bedrooms: number, sample_count: number): MarketBedroomAgg => ({
  bedrooms,
  sample_count,
  avg_adr: 100,
  avg_occupancy: 70,
  avg_gross_revenue: 40000,
  avg_net_revenue: 20000,
  avg_property_value_low: null,
  avg_property_value_high: null,
});

test('modalGroup: most reports, the lowest bedroom count on a tie, null when empty', () => {
  assert.equal(modalGroup([g(1, 2), g(2, 9), g(3, 4)])?.bedrooms, 2);
  assert.equal(modalGroup([g(2, 5), g(3, 5)])?.bedrooms, 2);
  assert.equal(modalGroup([]), null);
});

test('chooseSource: the district first, the postcode area when the district is too thin, null when both are', () => {
  const district = { by_bedrooms: [g(2, 6), g(3, 2)] };
  const thinDistrict = { by_bedrooms: [g(2, 4)] };
  const area = { by_bedrooms: [g(3, 14), g(2, 5)] };
  const thinArea = { by_bedrooms: [g(3, 4)] };

  const a = chooseSource({ district, area, minSamples: 5 });
  assert.equal(a?.level, 'district');
  assert.equal(a?.group.bedrooms, 2);
  assert.equal(a?.fellBack, false);

  const b = chooseSource({ district: thinDistrict, area, minSamples: 5 });
  assert.equal(b?.level, 'area');
  assert.equal(b?.group.bedrooms, 3);
  assert.equal(b?.fellBack, true);

  assert.equal(chooseSource({ district: thinDistrict, area: thinArea, minSamples: 5 }), null);
  assert.equal(chooseSource({ district: null, area: thinArea, minSamples: 5 }), null);
  const c = chooseSource({ district: null, area, minSamples: 5 });
  assert.equal(c?.level, 'area');
  assert.equal(c?.fellBack, false, 'an area asked for directly is not a fall-back');
  assert.equal(chooseSource({ district: thinDistrict, area: thinArea, minSamples: 3 })?.level, 'district', 'the setting is the threshold');
  assert.equal(chooseSource({ district, area, minSamples: 6 })?.level, 'district', 'exactly the minimum counts');
  assert.equal(chooseSource({ district, area, minSamples: 7 })?.level, 'area');
  assert.equal(chooseSource({ district: { by_bedrooms: [] }, area, minSamples: 5 })?.level, 'area');
});

test('parseAreaKey and parseMinAreaSamples', () => {
  assert.deepEqual(parseAreaKey('ng7'), { key: 'NG7', level: 'district', areaCode: 'NG' });
  assert.deepEqual(parseAreaKey('E1W'), { key: 'E1W', level: 'district', areaCode: 'E' });
  assert.deepEqual(parseAreaKey('NG'), { key: 'NG', level: 'area', areaCode: 'NG' });
  assert.equal(parseAreaKey('Nottingham'), null);
  assert.equal(parseAreaKey(''), null);
  assert.equal(parseAreaKey(null), null);
  assert.equal(parseMinAreaSamples(5), 5);
  assert.equal(parseMinAreaSamples('3'), 3);
  assert.equal(parseMinAreaSamples(0), DEFAULT_MIN_AREA_SAMPLES);
  assert.equal(parseMinAreaSamples(2.5), DEFAULT_MIN_AREA_SAMPLES);
  assert.equal(parseMinAreaSamples(null), DEFAULT_MIN_AREA_SAMPLES);
  assert.equal(parseMinAreaSamples(true), DEFAULT_MIN_AREA_SAMPLES);
  assert.equal(parseMinAreaSamples(''), DEFAULT_MIN_AREA_SAMPLES);
});

test('the generator never triggers the house-paid long-let lookup (it also runs on refused requests and dry runs)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./area-server.ts', import.meta.url), 'utf8');
  assert.ok(!/getAreaLongLetRent\s*\(/.test(src), 'area-server.ts must not call getAreaLongLetRent');
});

test('chooseSourceFor (Batch 55 step 5): the preferred bedroom count when it has enough reports, district then area, else chooseSource', () => {
  const district = { by_bedrooms: [g(2, 6), g(3, 2)] };
  const area = { by_bedrooms: [g(3, 14), g(2, 5), g(1, 9)] };
  // No preference: exactly chooseSource.
  for (const bedrooms of [undefined, null]) {
    const plain = chooseSourceFor({ district, area, minSamples: 5, bedrooms });
    assert.deepEqual(plain, { ...chooseSource({ district, area, minSamples: 5 }), preferred: false });
  }
  // 2 beds: the district has 6 reports at 2.
  const two = chooseSourceFor({ district, area, minSamples: 5, bedrooms: 2 });
  assert.deepEqual([two?.level, two?.group.bedrooms, two?.fellBack, two?.preferred], ['district', 2, false, true]);
  // 1 bed: the district has none, the area has 9: the area, as a fall-back.
  const one = chooseSourceFor({ district, area, minSamples: 5, bedrooms: 1 });
  assert.deepEqual([one?.level, one?.group.bedrooms, one?.fellBack, one?.preferred], ['area', 1, true, true]);
  // 3 beds: too thin in the district (2), enough in the area.
  assert.equal(chooseSourceFor({ district, area, minSamples: 5, bedrooms: 3 })?.level, 'area');
  // 5 beds: nowhere: the most common count, as before.
  const five = chooseSourceFor({ district, area, minSamples: 5, bedrooms: 5 });
  assert.deepEqual([five?.level, five?.group.bedrooms, five?.preferred], ['district', 2, false]);
});
