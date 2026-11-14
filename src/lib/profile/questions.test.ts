import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_ORDER, MARKS_WRITTEN, PREDECESSORS, QUESTIONS, RETIRED, answerLabel, applyAnswer, clearAnswer, currentValue, emptyAnswers, imageOf, isQuestionId, moneyQuestionsFor, optionsOf, questionById, questionsFor, text, type Answers, type QuestionId } from './questions.ts';
import { DEFAULT_FINANCE } from '../listing/deal.ts';

test('"not sure" on finance and profit is the house finance, from its one definition', () => {
  const a = emptyAnswers(DEFAULT_GOALS, null, []);
  assert.equal(clearAnswer('finance', a).goals.finance.depositPct, DEFAULT_FINANCE.depositPct);
  assert.equal(clearAnswer('finance', a).goals.finance.mortgageRatePct, DEFAULT_FINANCE.mortgageRatePct);
  assert.equal(clearAnswer('min_profit', a).goals.finance.targetMarginPcm, DEFAULT_FINANCE.targetMarginPcm);
});
import { DEFAULT_GOALS, GOAL_OPTIONS } from '../market/goals.ts';
import { ABOUT_OPTIONS, DEFAULT_ABOUT } from './about.ts';
import { QUIZ_IMAGES } from './images.ts';

const fresh = (): Answers => emptyAnswers(DEFAULT_GOALS, null, []);

function answer(a: Answers, id: QuestionId, value: unknown): Answers {
  const r = applyAnswer(id, value, a);
  assert.ok(r.ok, `${id}: ${r.ok ? '' : r.error}`);
  return r.answers;
}

test('every question has an id, a why line, a photo or answer cards, and a short label', () => {
  const ids = new Set<string>();
  for (const q of QUESTIONS) {
    assert.ok(!ids.has(q.id), `duplicate ${q.id}`);
    ids.add(q.id);
    assert.ok(q.short.length > 0, q.id);
    const a = fresh();
    assert.ok(text(q.why, a).length > 0, `${q.id} has no why`);
    assert.ok(text(q.title, a).length > 0, `${q.id} has no title`);
    const img = imageOf(q, a);
    if (img === 'cards') {
      const opts = optionsOf(q, a);
      assert.ok(opts.some((o) => o.image && o.image !== 'plain'), `${q.id}: answer cards carry no photo`);
      for (const o of opts) if (o.image && o.image !== 'plain') assert.ok(o.image in QUIZ_IMAGES, `${q.id}: ${o.image}`);
    } else {
      assert.ok(img in QUIZ_IMAGES, `${q.id}: no image for ${img}`);
    }
    if (q.kind === 'single' || q.kind === 'multi') assert.ok(optionsOf(q, { ...a, about: { ...a.about, roles: ['investor', 'r2r'] } }).length >= 2, `${q.id} has no options`);
  }
});

test('the mandatory questions are the only ones without "Not sure", and every option value is stored as given', () => {
  const mandatory = QUESTIONS.filter((q) => q.mandatory).map((q) => q.id).sort();
  assert.deepEqual(mandatory, ['btl_priority', 'cash_available', 'deal_types', 'setup_budget', 'where'].sort(), 'what you are looking for, where, Buying cash, R2R setup cash, and Buy to let’s "What are you after?"');
  // Every single-choice option round-trips through applyAnswer and reads back with its label.
  for (const q of QUESTIONS) {
    if (q.kind !== 'single') continue;
    const base: Answers = { ...fresh(), goals: { ...DEFAULT_GOALS, path: 'buy' }, about: { ...DEFAULT_ABOUT, roles: ['investor'], mainRole: 'investor' } };
    for (const o of optionsOf(q, base)) {
      const r = applyAnswer(q.id, o.value, base);
      assert.ok(r.ok, `${q.id} refused ${o.value}`);
      assert.equal(currentValue(q.id, r.answers), o.value, `${q.id}: ${o.value} did not store`);
      assert.equal(answerLabel(q.id, r.answers), o.label);
    }
    assert.equal(applyAnswer(q.id, 'not-an-option', base).ok, false, `${q.id} accepts junk`);
  }
});

test('the questions a profile gets follow its deal types, with the money question for each', () => {
  let a = fresh();
  assert.deepEqual(questionsFor(a).slice(0, 2).map((q) => q.id), ['deal_types', 'where'], 'nothing type-specific until they say');
  a = answer(a, 'deal_types', ['buy_str']);
  assert.equal(a.goals.sourcingKind, 'sale');
  assert.deepEqual(a.about.roles, ['investor'], 'the roles follow the ticks');
  const ids = questionsFor(a).map((q) => q.id);
  assert.deepEqual(ids.slice(0, 5), ['deal_types', 'where', 'cash_available', 'funding', 'min_profit']);
  assert.ok(ids.includes('short_let_rules') && ids.includes('main_goal'), 'the buying section');
  assert.ok(!ids.includes('setup_budget') && !ids.includes('brrr_work') && !ids.includes('looking_for'), 'no other section');
  assert.ok(!ids.includes('unit_areas'), 'unit areas are not asked any more');
});

test('Batch 30: no retired question is ever asked, for any combination of ticks', () => {
  const combos: string[][] = [['buy_str'], ['brrr'], ['r2r'], ['btl'], ['all'], ['source'], ['manage'], ['exploring'], ['buy_str', 'source', 'manage'], ['brrr', 'r2r', 'btl', 'source', 'manage', 'exploring']];
  const live = new Set<string>(LIVE_ORDER);
  for (const c of combos) {
    for (const q of questionsFor(answer(fresh(), 'deal_types', c))) {
      assert.ok(live.has(q.id) && !q.retired, `${c.join('+')} was asked ${q.id}`);
      assert.ok(!RETIRED[q.id], q.id);
    }
  }
  assert.equal(LIVE_ORDER.length + Object.keys(RETIRED).length, QUESTIONS.length, 'every question is live or retired, never both');
  for (const id of LIVE_ORDER) assert.ok(!RETIRED[id], id);
  for (const q of QUESTIONS) if (q.retired) assert.ok(!q.mandatory, `${q.id} retired but mandatory`);
});
test('"All of them" ticks every type; the kind searched follows; nothing is required but at least one', () => {
  let a = fresh();
  assert.equal(applyAnswer('deal_types', [], a).ok, false);
  assert.equal(applyAnswer('deal_types', ['nonsense'], a).ok, false);
  a = answer(a, 'deal_types', ['all']);
  assert.deepEqual(a.goals.dealTypes, ['buy_str', 'brrr', 'r2r', 'btl']);
  assert.deepEqual(a.about.roles, ['investor', 'r2r']);
  assert.equal(a.goals.sourcingKind, 'both');
  assert.equal(answerLabel('deal_types', a), 'All of them');
  assert.deepEqual(moneyQuestionsFor(a.goals.dealTypes!), ['setup_budget', 'cash_available']);
  const ids = questionsFor(a).map((q) => q.id);
  for (const id of ['setup_budget', 'cash_available', 'funding', 'btl_priority', 'brrr_work', 'short_let_rules'] as QuestionId[]) assert.ok(ids.includes(id), id);
  assert.equal(ids.filter((id) => id === 'cash_available').length, 1, 'Buying cash is one question, shared');
  a = answer(a, 'deal_types', ['r2r']);
  assert.equal(a.goals.sourcingKind, 'rent');
  assert.equal(answerLabel('deal_types', a), 'Rent-to-rent');
  assert.deepEqual(currentValue('deal_types', a), ['r2r']);
});

test('Batch 30: "What are you looking for?" writes the roles and the deal types for every option', () => {
  const read = (ticks: string[], from: Answers = fresh()) => {
    const a = answer(from, 'deal_types', ticks);
    return { roles: a.about.roles, types: a.goals.dealTypes, kind: a.goals.sourcingKind, main: a.about.mainRole };
  };
  assert.deepEqual(read(['buy_str']), { roles: ['investor'], types: ['buy_str'], kind: 'sale', main: 'investor' });
  assert.deepEqual(read(['brrr']), { roles: ['investor'], types: ['brrr'], kind: 'sale', main: 'investor' });
  assert.deepEqual(read(['r2r']), { roles: ['r2r'], types: ['r2r'], kind: 'rent', main: 'r2r' });
  assert.deepEqual(read(['btl']), { roles: ['investor'], types: ['btl'], kind: 'sale', main: 'investor' });
  assert.deepEqual(read(['all']), { roles: ['investor', 'r2r'], types: ['buy_str', 'brrr', 'r2r', 'btl'], kind: 'both', main: null });
  assert.deepEqual(read(['source']), { roles: ['sourcer'], types: ['buy_str', 'r2r'], kind: 'both', main: 'sourcer' }, 'a sourcer with no type ticked: their old types, written explicitly');
  assert.deepEqual(read(['manage']), { roles: ['manager'], types: ['buy_str'], kind: 'sale', main: 'manager' });
  assert.deepEqual(read(['exploring']), { roles: ['exploring'], types: ['buy_str', 'brrr', 'r2r', 'btl'], kind: 'both', main: 'exploring' }, 'exploring: every available type');
  assert.deepEqual(read(['r2r', 'source']), { roles: ['r2r', 'sourcer'], types: ['r2r'], kind: 'rent', main: null }, 'a ticked type wins; the role is kept');
  // Prefilled from the roles: answering again with what is shown keeps every role.
  for (const ticks of [['source'], ['manage'], ['exploring'], ['buy_str', 'source'], ['r2r', 'manage', 'brrr'], ['all', 'source']]) {
    const once = answer(fresh(), 'deal_types', ticks);
    const shown = currentValue('deal_types', once) as string[];
    const again = answer(once, 'deal_types', shown);
    assert.deepEqual(again.about.roles, once.about.roles, `${ticks.join('+')} keeps its roles`);
    assert.deepEqual(again.goals.dealTypes, once.goals.dealTypes, `${ticks.join('+')} keeps its types`);
  }
});

test('Batch 30: the merged question reads back as a label', () => {
  assert.equal(answerLabel('deal_types', answer(fresh(), 'deal_types', ['source'])), 'I source deals for clients');
  assert.equal(answerLabel('deal_types', answer(fresh(), 'deal_types', ['buy_str', 'btl'])), 'Buy a ready short-let, Buy to let');
  assert.equal(answerLabel('deal_types', answer(fresh(), 'deal_types', ['all', 'manage'])), 'All of them, I run a management company');
});
test('the question count per combination (the Batch 30 table)', () => {
  const count = (ticks: string[]) => questionsFor(answer(fresh(), 'deal_types', ticks)).length;
  assert.equal(count(['buy_str']), 12, 'Buy');
  assert.equal(count(['r2r']), 9, 'R2R');
  assert.equal(count(['brrr']), 13, 'BRRR');
  assert.equal(count(['buy_str', 'r2r']), 13, 'Buy + R2R');
  assert.equal(count(['buy_str', 'brrr', 'r2r']), 14, 'all three older types');
  assert.equal(count(['all']), 15, 'all four, sharing Buying cash');
  assert.equal(count(['btl']), 10, 'Buy to let only');
  assert.equal(count(['source']), 15, 'a sourcer sees Buy + R2R');
  assert.equal(count(['manage']), 14, 'a management company sees Buy');
});

test('Batch 30: R2R alone is never asked a buying question; a buyer is never asked a setup one', () => {
  const r2r = questionsFor(answer(fresh(), 'deal_types', ['r2r'])).map((q) => q.id);
  assert.ok(r2r.includes('setup_budget'));
  for (const id of ['cash_available', 'funding', 'main_goal', 'short_let_rules', 'brrr_work', 'btl_priority'] as QuestionId[]) assert.ok(!r2r.includes(id), id);
  const buy = questionsFor(answer(fresh(), 'deal_types', ['buy_str'])).map((q) => q.id);
  assert.ok(buy.includes('cash_available') && !buy.includes('setup_budget'));
  const btl = questionsFor(answer(fresh(), 'deal_types', ['btl'])).map((q) => q.id);
  assert.ok(btl.includes('cash_available') && btl.includes('btl_priority') && !btl.includes('funding'), 'Buy to let shares Buying cash and has its own priority');
  assert.deepEqual(moneyQuestionsFor(['r2r']), ['setup_budget']);
  assert.deepEqual(moneyQuestionsFor(['buy_str', 'brrr', 'btl']), ['cash_available']);
});

test('Batch 30: the two money questions have their own photos, labels and bands', () => {
  const a = fresh();
  const cash = questionById('cash_available')!;
  const setup = questionById('setup_budget')!;
  assert.notEqual(QUIZ_IMAGES[imageOf(cash, a) as keyof typeof QUIZ_IMAGES], QUIZ_IMAGES[imageOf(setup, a) as keyof typeof QUIZ_IMAGES]);
  assert.equal(text(cash.label!, a), 'Buying');
  assert.equal(text(setup.label!, a), 'Rent-to-rent');
  assert.equal(cash.short, 'Buying cash');
  assert.equal(setup.short, 'R2R setup cash');
  assert.deepEqual(optionsOf(setup, a).map((o) => o.label), ['Under £10k', '£10–15k', '£15–20k', '£20k+']);
  assert.deepEqual(optionsOf(cash, a).map((o) => o.label), ['Under £30k', '£30–60k', '£60–100k', '£100–200k', '£200k+']);
  const sourcer = answer(a, 'deal_types', ['source']);
  assert.equal(text(setup.title, sourcer), 'How much can your clients spend setting up a rent-to-rent property?');
  assert.equal(text(cash.title, sourcer), 'How much cash can your clients put into buying a property?');
  assert.equal(text(cash.title, a), 'How much cash can you put into buying a property?');
  assert.match(text(setup.why, a), /landlord’s deposit or first month’s rent/);
});

test('Batch 30: Buying cash sets the older budget as a ceiling, the Buy to let band, and says what it buys', () => {
  let a = answer(fresh(), 'deal_types', ['buy_str', 'btl']);
  a = answer(a, 'cash_available', 'u30');
  assert.equal(a.goals.buyer.cashAvailable, 'u30');
  assert.equal(a.goals.budget, 'u100');
  assert.equal(a.goals.brrr.budget, 'u100');
  assert.equal(a.goals.btl.cashBand, 'under_25k');
  a = answer(a, 'cash_available', '200+');
  assert.equal(a.goals.budget, null, 'above £200k there is no band: the cash filter caps the price');
  assert.equal(a.goals.btl.cashBand, '100k_plus');
  a = answer(a, 'cash_available', '60-100');
  assert.equal(a.goals.btl.cashBand, '50k_100k');
  const cash = questionById('cash_available')!;
  assert.match(cash.lineFor!('30-60', a)!, /^With a mortgage, that's up to about £/);
  a = answer(a, 'funding', 'cash');
  assert.match(cash.lineFor!('30-60', a)!, /^With cash, up to about £/);
  assert.match(questionById('funding')!.lineFor!('btl', a)!, /^With a mortgage/);
  // A worked-out band says so on the profile page and clears once it is answered.
  const worked = { ...a, goals: { ...a.goals, buyer: { ...a.goals.buyer, cashAvailable: '30-60' as const, cashFromBudget: true } } };
  assert.equal(answerLabel('cash_available', worked), '£30–60k (worked out from your budget)');
  assert.equal(answer(worked, 'cash_available', '30-60').goals.buyer.cashFromBudget, false);
  // Funding moves the ceiling with the price a band buys; a worked-out band is left alone.
  const at30 = answer(a, 'cash_available', '30-60');
  assert.equal(answer(at30, 'funding', 'btl').goals.budget, 'u200', 'a mortgage stretches £30–60k to under £200k');
  assert.equal(answer(at30, 'funding', 'cash').goals.budget, 'u100', 'cash alone reaches under £100k');
  assert.equal(answer(worked, 'funding', 'cash').goals.budget, worked.goals.budget);
});

test('Batch 30: stage, property, short-let rules and minimum profit write the older fields too', () => {
  let a = fresh();
  a = answer(a, 'stage', '3-10');
  assert.deepEqual([a.about.stage, a.about.dealsDone, a.about.unitsNow], ['3-10', '4-10', '3-5']);
  assert.equal(answerLabel('stage', a), '3–10 units');
  assert.equal(answer(answer(a, 'unit_areas', ['NG']), 'stage', 'none').about.unitAreas.length, 0);
  assert.equal(currentValue('stage', { ...a, about: { ...a.about, stage: null } }), '3-10', 'read back from units');
  assert.equal(applyAnswer('stage', 'lots', a).ok, false);

  a = answer(a, 'property', { type: 'flat', bedrooms: 3 });
  assert.deepEqual([a.goals.buyer.propertyType, a.goals.bedrooms], ['flat', 3]);
  assert.equal(answerLabel('property', a), 'Flat, 3 bed');
  assert.equal(applyAnswer('property', { type: 'flat' }, a).ok, false, 'bedrooms are required');
  assert.equal(applyAnswer('property', { bedrooms: 2 }, a).ok, false, 'the type is required');
  assert.equal(answerLabel('property', answer(a, 'property', { type: 'either', bedrooms: '4' })), 'Either, 4+ bed');
  const cleared = clearAnswer('property', a);
  assert.deepEqual([cleared.goals.buyer.propertyType, cleared.goals.bedrooms], [null, null], '"Not sure" clears both');

  const hide = answer(a, 'short_let_rules', 'hide');
  assert.deepEqual([hide.goals.buyer.leaseholdOk, hide.goals.buyer.restrictedAreas], ['no', 'avoid']);
  const warn = answer(a, 'short_let_rules', 'warn');
  assert.deepEqual([warn.goals.buyer.leaseholdOk, warn.goals.buyer.restrictedAreas], ['depends', 'warn']);
  assert.equal(currentValue('short_let_rules', hide), 'hide');
  assert.equal(currentValue('short_let_rules', warn), 'warn');
  assert.equal(applyAnswer('short_let_rules', 'maybe', a).ok, false);
  assert.deepEqual([clearAnswer('short_let_rules', hide).goals.buyer.leaseholdOk, clearAnswer('short_let_rules', hide).goals.buyer.restrictedAreas], [null, null]);

  const m = answer(a, 'min_profit', 750);
  assert.deepEqual([m.goals.finance.targetMarginPcm, m.goals.r2r.minMarginPcm], [750, 750], 'one answer, both fields');
  assert.equal(clearAnswer('min_profit', m).goals.r2r.minMarginPcm, null);
});

test('Batch 30: finance marks the member’s own rate; clearing it goes back to today’s average', () => {
  let a = answer(fresh(), 'finance', { depositPct: 25, mortgageRatePct: 6 });
  assert.equal(a.goals.finance.rateSet, true);
  a = clearAnswer('finance', a);
  assert.equal(a.goals.finance.rateSet, false);
  assert.equal(a.goals.finance.mortgageRatePct, DEFAULT_FINANCE.mortgageRatePct);
});

test('Batch 30: the old ids still parse, still apply and read back; the editable ones are marked', () => {
  for (const id of ['roles', 'budget', 'brrr_budget', 'max_rent', 'btl_cash', 'deals_done', 'units_now', 'unit_areas', 'blocker', 'finance', 'entity', 'property_type', 'bedrooms', 'leasehold', 'restricted_areas', 'r2r_min_profit', 'deal_structure', 'break_even', 'payback', 'furnished', 'deals_wanted', 'deals_per_month', 'units_managed', 'growth_target']) {
    assert.ok(isQuestionId(id), id);
    assert.ok(RETIRED[id as QuestionId], `${id} is retired`);
  }
  for (const id of ['budget', 'brrr_budget', 'max_rent', 'blocker', 'finance', 'r2r_min_profit'] as QuestionId[]) assert.equal(RETIRED[id], 'editable', id);
  assert.equal(RETIRED.roles, true);
  // An old retired answer still saves and reads back.
  let a = answer(fresh(), 'budget', '350-500');
  a = answer(a, 'max_rent', 1500);
  assert.equal(answerLabel('budget', a), '£350k–£500k');
  assert.equal(clearAnswer('max_rent', a).goals.maxRentPcm, null, 'a stored max rent can be cleared');
  assert.equal(answer(fresh(), 'blocker', 'funding').about.blocker, 'funding');
  // The replacement mappings only name real ids.
  for (const [k, v] of [...Object.entries(MARKS_WRITTEN), ...Object.entries(PREDECESSORS)]) {
    assert.ok(isQuestionId(k) && !RETIRED[k as QuestionId], `${k} is a live question`);
    for (const id of v!) assert.ok(isQuestionId(id) && RETIRED[id], `${k}: ${id} is a retired question`);
  }
});
test('sourcers and managers get their sections, and the money questions in their words', () => {
  const s = answer(fresh(), 'deal_types', ['source']);
  assert.deepEqual(s.about.roles, ['sourcer']);
  assert.deepEqual(s.goals.dealTypes, ['buy_str', 'r2r']);
  const ids = questionsFor(s).map((q) => q.id);
  assert.ok(ids.includes('sourcing_fee') && ids.includes('motivated_sellers'));
  assert.ok(!ids.includes('looking_for'));
  const both = answer(s, 'deal_types', ['buy_str', 'source']);
  assert.equal(text(questionById('cash_available')!.title, both), 'How much cash can you put into buying a property?', 'anyone who also invests answers for themselves');
  const m = answer(fresh(), 'deal_types', ['manage']);
  assert.ok(questionsFor(m).some((x) => x.id === 'looking_for') && questionsFor(m).some((x) => x.id === 'operating_areas'));
});
test('BRRR: the project budget and how much work, stored on their own', () => {
  let a = answer(answer(fresh(), 'roles', ['investor']), 'deal_types', ['brrr']);
  a = answer(a, 'brrr_budget', 'u200');
  assert.equal(a.goals.brrr.budget, 'u200');
  assert.equal(a.goals.budget, null, 'the short-let budget is its own answer');
  assert.equal(answerLabel('brrr_budget', a), 'Under £200k');
  a = answer(a, 'brrr_work', 'either');
  assert.equal(a.goals.brrr.work, 'either');
  assert.equal(answerLabel('brrr_work', a), 'Either');
  assert.equal(clearAnswer('brrr_work', a).goals.brrr.work, null);
});

test('where: near needs a postcode and a radius, areas need areas, anywhere needs nothing', () => {
  const a = fresh();
  assert.equal(applyAnswer('where', { mode: 'near' }, a).ok, false);
  assert.equal(applyAnswer('where', { mode: 'near', postcode: 'NG2 5GB', miles: 15 }, a).ok, false, 'not a step of ten');
  const near = answer(a, 'where', { mode: 'near', postcode: 'ng2 5gb', miles: '40' });
  assert.deepEqual(near.goals.home, { postcode: 'NG2 5GB', lat: null, lng: null });
  assert.equal(near.goals.maxDistanceMiles, 40);
  assert.equal(near.goals.where, 'near');
  assert.deepEqual(near.savedAreas, []);
  assert.equal(answerLabel('where', near), 'Within 40 miles of NG2');

  // The same postcode keeps its coordinates; a new one loses them (the server places it).
  const placed = { ...near, goals: { ...near.goals, home: { ...near.goals.home!, lat: 52.9, lng: -1.1 } } };
  assert.equal(answer(placed, 'where', { mode: 'near_plus_best', postcode: 'NG2 5GB', miles: 60 }).goals.home?.lat, 52.9);
  assert.equal(answer(placed, 'where', { mode: 'near', postcode: 'M1 1AE', miles: 60 }).goals.home?.lat, null);
  assert.equal(answerLabel('where', answer(placed, 'where', { mode: 'near_plus_best', postcode: 'NG2 5GB', miles: 60 })), 'Within 60 miles of NG2, plus the best elsewhere');

  assert.equal(applyAnswer('where', { mode: 'areas', areas: [] }, a).ok, false);
  const areas = answer(placed, 'where', { mode: 'areas', areas: ['ng', 'M', 'ZZ'] });
  assert.equal(areas.goals.home, null);
  assert.equal(areas.goals.maxDistanceMiles, null);
  assert.deepEqual(areas.savedAreas, ['NG', 'M']);
  assert.equal(answerLabel('where', areas), 'Nottingham, Manchester');

  const anywhere = answer(areas, 'where', { mode: 'anywhere' });
  assert.deepEqual(anywhere.savedAreas, []);
  assert.equal(anywhere.goals.home, null);
  assert.equal(answerLabel('where', anywhere), 'Anywhere in the UK');
  assert.equal(applyAnswer('where', { mode: 'space' }, a).ok, false);
});

test('money, rent, finance and profit are checked and read back', () => {
  let a = answer(fresh(), 'roles', ['investor']);
  assert.equal(applyAnswer('budget', 'any', a).ok, false);
  a = answer(a, 'budget', '350-500');
  assert.equal(a.goals.budget, '350-500');
  assert.equal(answerLabel('budget', a), '£350k–£500k');

  assert.equal(applyAnswer('max_rent', 50, a).ok, false);
  a = answer(a, 'max_rent', '£1,250');
  assert.equal(a.goals.maxRentPcm, 1250);
  assert.equal(answerLabel('max_rent', a), 'Up to £1,250 a month');

  assert.equal(applyAnswer('finance', { depositPct: 120, mortgageRatePct: 5 }, a).ok, false);
  a = answer(a, 'finance', { depositPct: '15', mortgageRatePct: 6.2 });
  assert.equal(a.goals.finance.depositPct, 15);
  assert.equal(a.goals.finance.mortgageRatePct, 6.2);
  assert.equal(a.goals.finance.termYears, 25, 'the rest of finance is untouched');
  assert.equal(answerLabel('finance', a), '15% deposit, 6.2% rate');

  assert.equal(applyAnswer('min_profit', -5, a).ok, false);
  a = answer(a, 'min_profit', '800');
  assert.equal(a.goals.finance.targetMarginPcm, 800);
  assert.equal(answerLabel('min_profit', a), '£800 a month');
  assert.equal(answerLabel('r2r_min_profit', a), '£800 a month', 'Batch 30: the one minimum profit writes the rent-to-rent figure too');
  a = answer(a, 'r2r_min_profit', 650);
  assert.equal(a.goals.r2r.minMarginPcm, 650);
  assert.equal(a.goals.finance.targetMarginPcm, 800, 'the retired rent-to-rent answer never overwrites the buyer’s');
});

test('the two mirrors: time sets management, risk sets risk appetite; "Not sure" puts them back', () => {
  let a = answer(fresh(), 'time', 'hands_on');
  assert.equal(a.goals.management, 'self');
  a = answer(a, 'risk', 'go');
  assert.equal(a.goals.riskAppetite, 'tolerant');
  a = clearAnswer('time', a);
  assert.equal(a.about.time, null);
  assert.equal(a.goals.management, 'managed');
  a = clearAnswer('risk', a);
  assert.equal(a.goals.riskAppetite, 'balanced');
  assert.equal(answerLabel('risk', a), null);
});

test('"Not sure" clears every optional answer and leaves the mandatory ones alone', () => {
  let a = answer(fresh(), 'roles', ['investor']);
  a = answer(a, 'where', { mode: 'anywhere' });
  a = answer(a, 'budget', 'u200');
  for (const q of QUESTIONS) {
    if (q.mandatory || q.retired) continue;
    const cleared = clearAnswer(q.id, a);
    const v = currentValue(q.id, cleared);
    if (q.id === 'min_profit') assert.equal(v, 500, q.id);
    else if (q.id === 'motivated_sellers') assert.equal(v, 'off');
    else assert.equal(v, null, q.id);
  }
  const same = clearAnswer('budget', a);
  assert.equal(same.goals.budget, 'u200');
  assert.equal(clearAnswer('roles', a).about.roles.length, 1);
});

test('areas answers, bedrooms and the numeric options', () => {
  let a = answer(fresh(), 'roles', ['manager']);
  assert.equal(applyAnswer('operating_areas', [], a).ok, false);
  a = answer(a, 'operating_areas', ['l', 'LS']);
  assert.deepEqual(a.goals.manager.operatingAreas, ['L', 'LS']);
  assert.equal(answerLabel('operating_areas', a), 'Liverpool, Leeds');
  a = answer(a, 'growth_target', '25');
  assert.equal(a.goals.manager.growthTarget, 25);
  assert.equal(answerLabel('growth_target', a), '+25 units');
  assert.equal(applyAnswer('growth_target', 7, a).ok, false);

  let b = answer(fresh(), 'roles', ['investor']);
  b = answer(b, 'bedrooms', '4');
  assert.equal(b.goals.bedrooms, 4);
  assert.equal(answerLabel('bedrooms', b), '4 or more');
  assert.equal(applyAnswer('bedrooms', '5', b).ok, false);

  let r = answer(fresh(), 'roles', ['r2r']);
  r = answer(r, 'break_even', '60');
  r = answer(r, 'payback', 18);
  assert.equal(r.goals.r2r.breakEvenOccupancyPct, 60);
  assert.equal(r.goals.r2r.paybackMonths, 18);
  assert.equal(applyAnswer('break_even', 65, r).ok, false);
  r = answer(r, 'unit_areas', ['NG']);
  assert.deepEqual(r.about.unitAreas, ['NG']);
});

test('the option lists in the questions match the stored vocabularies', () => {
  const single = (id: QuestionId) => optionsOf(QUESTIONS.find((q) => q.id === id)!, fresh()).map((o) => o.value);
  assert.deepEqual(single('cash_available'), [...GOAL_OPTIONS.cashAvailable]);
  assert.deepEqual(single('funding'), [...GOAL_OPTIONS.funding]);
  assert.deepEqual(single('deal_structure'), [...GOAL_OPTIONS.dealStructure]);
  assert.deepEqual(single('units_managed'), [...GOAL_OPTIONS.unitsManaged]);
  assert.deepEqual(single('deals_done'), [...ABOUT_OPTIONS.dealsDone]);
  assert.deepEqual(single('blocker'), [...ABOUT_OPTIONS.blocker]);
  assert.deepEqual(single('risk'), [...ABOUT_OPTIONS.risk]);
  assert.deepEqual(single('where'), [...GOAL_OPTIONS.where]);
});

test('Batch 22c: the budget questions offer five brackets; a stored Under £200k is still accepted and read, never offered', () => {
  for (const id of ['budget', 'brrr_budget'] as const) {
    const options = optionsOf(QUESTIONS.find((x) => x.id === id)!, fresh());
    assert.deepEqual(options.map((o) => o.value), ['u100', '100-200', '200-350', '350-500', '500+'], id);
    assert.deepEqual(options.map((o) => o.label), ['Under £100k', '£100k–£200k', '£200k–£350k', '£350k–£500k', '£500k+'], id);
  }
  let a = answer(answer(fresh(), 'roles', ['investor']), 'deal_types', ['buy_str']);
  a = answer(a, 'budget', 'u100');
  assert.equal(a.goals.budget, 'u100');
  assert.equal(answerLabel('budget', a), 'Under £100k');
  a = answer(a, 'budget', '100-200');
  assert.equal(answerLabel('budget', a), '£100k–£200k');
  // A member who chose Under £200k before keeps it, labelled as it always was.
  a = answer(a, 'budget', 'u200');
  assert.equal(a.goals.budget, 'u200');
  assert.equal(answerLabel('budget', a), 'Under £200k');
});

test('Batch 28 (Batch 30): Buy to let asks "What are you after?" once and shares Buying cash, only when it is chosen', () => {
  let a = answer(fresh(), 'deal_types', ['buy_str']);
  let ids = questionsFor(a).map((q) => q.id);
  assert.ok(!ids.includes('btl_priority'));
  a = answer(a, 'deal_types', ['buy_str', 'btl']);
  ids = questionsFor(a).map((q) => q.id);
  assert.equal(ids.filter((id) => id === 'btl_priority').length, 1);
  assert.ok(!ids.includes('btl_cash'), 'its own cash question is retired');
  assert.equal(ids.filter((id) => id === 'cash_available').length, 1, 'one Buying cash for both');
  a = answer(answer(a, 'btl_priority', 'growth'), 'btl_cash', '25k_50k');
  assert.deepEqual(a.goals.btl, { priority: 'growth', cashBand: '25k_50k' }, 'an existing buy-to-let answer still saves');
  assert.equal(answerLabel('btl_priority', a), 'Value going up');
  assert.equal(answerLabel('btl_cash', a), '£25k to £50k');
  assert.equal(applyAnswer('btl_cash', '1m', a).ok, false);
  assert.deepEqual(clearAnswer('btl_priority', a).goals.btl, a.goals.btl, 'mandatory: no "Not sure"');
});