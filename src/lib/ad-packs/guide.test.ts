import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GUIDE_STEPS,
  audienceChecklistFor,
  availableShots,
  clampStep,
  copyListFor,
  guideStep,
  needsAdPicker,
  nextStepIndex,
  prevStepIndex,
  screenshotUrl,
  screenshotView,
  stepNumberLabel,
  UPLOAD_STEP_ID,
  adProgressLabel,
  EMPTY_PROGRESS,
  guideStorageKey,
  nextAdToSetUp,
  nextWording,
  parseProgress,
  serializeProgress,
  stepPercent,
  uploadHelp,
  withDone,
  withStep,
  wordingLabel,
} from './guide.ts';
import { AREA_RADIUS_MILES, INTERESTS, LAST_CHECKED, OBJECTIVE_PROPOSED, RECIPE_ITEMS, recipeItemsFor, recipeLine } from './targeting-recipe.ts';

const sentences = (s: string) => s.split(/[.!?](?:\s+|$)/).filter((x) => x.trim() !== '');
const allText = () => JSON.stringify(GUIDE_STEPS);

test('every step has a title, one non-empty one-sentence action, and a Stuck answer of 1 to 3 sentences', () => {
  assert.ok(GUIDE_STEPS.length >= 10);
  for (const s of GUIDE_STEPS) {
    assert.ok(s.title.trim() !== '', `${s.id} title`);
    assert.ok(s.action.trim() !== '', `${s.id} action`);
    assert.equal(sentences(s.action).length, 1, `${s.id} action is one sentence: ${s.action}`);
    assert.match(s.action, /[.]$/, `${s.id} action ends with a full stop`);
    assert.doesNotMatch(s.action, /\band then\b/i, `${s.id} action asks for one thing`);
    assert.ok(s.stuck.trim() !== '', `${s.id} stuck`);
    const n = sentences(s.stuck).length;
    assert.ok(n >= 1 && n <= 3, `${s.id} stuck has ${n} sentences`);
    assert.ok(s.screenshot.alt.trim() !== '', `${s.id} alt`);
  }
});

test('step ids are unique, and each screenshot file is public/ad-packs/guide/<id>.png', () => {
  const ids = GUIDE_STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of GUIDE_STEPS) {
    assert.match(s.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(s.screenshot.file, `public/ad-packs/guide/${s.id}.png`);
  }
});

test('the screenshot README lists exactly the step ids as file names', () => {
  const readme = readFileSync(new URL('../../../public/ad-packs/guide/README.md', import.meta.url), 'utf8');
  const listed = [...readme.matchAll(/`([a-z0-9-]+)\.png`/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, GUIDE_STEPS.map((s) => s.id).sort());
  assert.match(readme, /1200 ?px/);
  assert.match(readme, /personal data/i);
});

test('the guide runs in the order Meta asks, and the name and link steps copy the name and the link', () => {
  const ids = GUIDE_STEPS.map((s) => s.id);
  const order = ['open-ads-manager', 'create-campaign', 'choose-traffic', 'set-budget', 'set-audience', 'upload-file', 'paste-primary', 'paste-headline', 'paste-description', 'paste-ad-name', 'paste-link', 'publish'];
  let last = -1;
  for (const id of order) {
    const at = ids.indexOf(id);
    assert.ok(at > last, `${id} comes after the one before it`);
    last = at;
  }
  assert.equal(guideStep('paste-ad-name')?.copy.kind, 'ad_name');
  assert.equal(guideStep('paste-link')?.copy.kind, 'link');
  assert.equal(guideStep('paste-primary')?.copy.kind, 'primary');
  assert.equal(guideStep('paste-headline')?.copy.kind, 'headline');
  assert.equal(guideStep('paste-description')?.copy.kind, 'description');
  assert.equal(guideStep('nope'), null);
  // Only the five text steps copy anything.
  const copying = GUIDE_STEPS.filter((s) => s.copy.kind !== 'none').map((s) => s.id);
  assert.deepEqual(copying, ['paste-primary', 'paste-headline', 'paste-description', 'paste-ad-name', 'paste-link']);
});

test('the name and link steps say why they must be pasted exactly, and leave the {{ad.id}} part alone', () => {
  assert.match(guideStep('paste-ad-name')!.detail ?? '', /exactly as it is, so we can show you which ad each enquiry came from/);
  const link = guideStep('paste-link')!.detail ?? '';
  assert.ok(link.includes('{{ad.id}}'));
  assert.match(link, /Facebook fills it in/);
  assert.match(link, /do not change anything/);
  assert.match(link, /which ad works/);
});

test('a text step names the Facebook box it goes into and the name we use for it; the other steps name neither', () => {
  const expected: Record<string, [string, string]> = {
    'paste-primary': ['Primary text', 'Main text'],
    'paste-headline': ['Headline', 'Headline'],
    'paste-description': ['Description', 'Extra line'],
    'paste-ad-name': ['Ad name', 'Ad name'],
    'paste-link': ['Website URL', 'Website link'],
  };
  for (const s2 of GUIDE_STEPS) {
    const e = expected[s2.id];
    if (!e) {
      assert.equal(s2.facebookFieldName, undefined, s2.id);
      assert.equal(s2.ourName, undefined, s2.id);
      continue;
    }
    assert.equal(s2.facebookFieldName, e[0], s2.id);
    assert.equal(s2.ourName, e[1], s2.id);
    assert.ok(s2.action.includes(`the box called ${e[0]} in Facebook`), `${s2.id}: ${s2.action}`);
  }
});

test('it covers the Traffic goal, a page and ad account, the audience and the review wait', () => {
  assert.match(guideStep('choose-traffic')!.action, /Traffic/);
  assert.match(guideStep('open-ads-manager')!.action, /adsmanager\.facebook\.com/);
  assert.match(guideStep('open-ads-manager')!.stuck, /Facebook page/);
  assert.match(guideStep('open-ads-manager')!.stuck, /ad account/);
  assert.equal(guideStep('set-audience')!.title, 'Set up your audience');
  assert.match(guideStep('publish')!.detail ?? '', /up to a day/);
  assert.match(guideStep('set-budget')!.action, /comfortable/);
});

test('the guide has no product name, no pound sign, no em dash, no promise, and is UK English', () => {
  const text = allText();
  assert.doesNotMatch(text, /stayful/i);
  assert.doesNotMatch(text, /£|\\u00a3/);
  assert.doesNotMatch(text, /—|\\u2014|—/);
  assert.doesNotMatch(text, /\d[\d,]*\s?(?:pounds|GBP)/i);
  assert.doesNotMatch(text, /guarantee(?!d)|you will earn|you.ll earn|make money|passive income/i);
  assert.doesNotMatch(text, /\b(?:optimize|color|center|organize|customize)/i);
});

test('the upload step says which file to add, for the video ad and for a picture ad', () => {
  const step = guideStep('upload-file')!;
  assert.equal(step.id, UPLOAD_STEP_ID);
  assert.equal(sentences(step.action).length, 1);
  assert.doesNotMatch(step.action, /image file/, 'the notice ad is a video, so the step says "file"');
  const video = uploadHelp(true, 0);
  const pictures = uploadHelp(false, 5);
  assert.match(video, /This ad is a video\. Use the Feed one for most people\./);
  assert.match(video, /Full screen one too if Facebook asks for Stories and Reels/);
  assert.match(pictures, /This ad has 5 pictures\. Add all of them, in order\. Use the Feed size for most people\./);
  assert.match(uploadHelp(false, 1), /This ad has 1 picture\. Add it\./);
  for (const t of [video, pictures]) {
    assert.equal(sentences(t).length, t === video ? 3 : 3, t);
    assert.doesNotMatch(t, /stayful|£|—/i);
  }
});

test('stepNumberLabel and the pager stay inside 1 to n', () => {
  assert.equal(stepNumberLabel(0, 12), 'Step 1 of 12');
  assert.equal(stepNumberLabel(11, 12), 'Step 12 of 12');
  assert.equal(stepNumberLabel(99, 12), 'Step 12 of 12');
  assert.equal(stepNumberLabel(-3, 12), 'Step 1 of 12');
  assert.equal(stepNumberLabel(0, 0), 'Step 0 of 0');
  assert.equal(clampStep(5, 3), 2);
  assert.equal(clampStep(-1, 3), 0);
  assert.equal(clampStep(Number.NaN, 3), 0);
  assert.equal(clampStep(1.9, 3), 1);
  assert.equal(clampStep(4, 0), 0);
  assert.equal(nextStepIndex(0, 3), 1);
  assert.equal(nextStepIndex(2, 3), 2);
  assert.equal(prevStepIndex(1, 3), 0);
  assert.equal(prevStepIndex(0, 3), 0);
  assert.equal(nextStepIndex(50, 3), 2);
});

test('a screenshot is shown only when its file exists; otherwise a plain box with the alt text', () => {
  const step = GUIDE_STEPS[0];
  assert.deepEqual(availableShots(['README.md', `${step.id}.png`, 'other.png']), [step.id]);
  assert.deepEqual(availableShots([]), []);
  const have = screenshotView(step, [step.id]);
  assert.equal(have.kind, 'image');
  if (have.kind === 'image') {
    assert.equal(have.src, `/ad-packs/guide/${step.id}.png`);
    assert.equal(have.alt, step.screenshot.alt);
  }
  const none = screenshotView(step, []);
  assert.deepEqual(none, { kind: 'placeholder', text: `Picture to come: ${step.screenshot.alt}` });
  assert.equal(screenshotUrl('publish'), '/ad-packs/guide/publish.png');
});

test('copyListFor offers the right texts for each kind, and nothing for a step that copies nothing', () => {
  const copy = { name: 'N', link: 'L', primary: ['p1', 'p2'], headlines: ['h1'], descriptions: ['d1', 'd2', 'd3'] };
  assert.deepEqual(copyListFor('ad_name', copy), ['N']);
  assert.deepEqual(copyListFor('link', copy), ['L']);
  assert.deepEqual(copyListFor('primary', copy), ['p1', 'p2']);
  assert.deepEqual(copyListFor('headline', copy), ['h1']);
  assert.deepEqual(copyListFor('description', copy), ['d1', 'd2', 'd3']);
  assert.deepEqual(copyListFor('none', copy), []);
});

test('the ad picker shows on the copy steps and the upload step only', () => {
  const picking = GUIDE_STEPS.filter(needsAdPicker).map((s) => s.id);
  assert.deepEqual(picking, ['upload-file', 'paste-primary', 'paste-headline', 'paste-description', 'paste-ad-name', 'paste-link']);
});

test('the guide is its own page: owner only, approved ads only, screenshots checked on the server, copy logged without the text, progress kept in the browser only', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const page = code(read('../../app/leads/ads/guide/page.tsx'));
  const wizard = code(read('../../app/leads/ads/guide/GuideWizard.tsx'));
  const server = code(read('./guide-server.ts'));
  assert.match(page, /ownerIdOrNull\(user\)/);
  assert.match(page, /packEligibility\(user\.id, \{ admin \}\)/);
  assert.match(page, /screen\.kind !== "approved"/);
  assert.match(page, /availableGuideShots\(\)/);
  assert.match(page, /<GuideWizard\b/);
  assert.doesNotMatch(page, /searchParams|params\b/, 'nothing in the address chooses whose ads are shown');
  assert.match(server, /^import 'server-only';/);
  assert.match(server, /existsSync/);
  assert.match(wizard, /^"use client";/);
  assert.match(wizard, /localStorage/);
  assert.match(wizard, /try \{[\s\S]*localStorage\.getItem[\s\S]*\} catch/);
  assert.match(wizard, /try \{[\s\S]*localStorage\.setItem[\s\S]*\} catch/);
  assert.match(wizard, /recordCopy\(adId, item\.kind, item\.index\)/);
  assert.doesNotMatch(wizard, /recordCopy\([^)]*\.text/);
  assert.doesNotMatch(wizard, /from "node:fs"|from "fs"/);
  const config = read('../../../next.config.ts');
  assert.match(config, /"\/leads\/ads\/guide": AD_PACK_GUIDE_SHOTS/);
  assert.match(config, /public\/ad-packs\/guide/);
});

test('wording: the first text is the suggestion and "another wording" goes round and comes back', () => {
  assert.equal(nextWording(0, 5), 1);
  assert.equal(nextWording(4, 5), 0);
  assert.equal(nextWording(0, 1), 0);
  assert.equal(nextWording(0, 0), 0);
  assert.equal(wordingLabel(0, 5), 'Wording 1 of 5');
  assert.equal(wordingLabel(4, 5), 'Wording 5 of 5');
  assert.equal(wordingLabel(0, 1), null);
  const seen = new Set<number>();
  let i = 0;
  for (let k = 0; k < 5; k++) {
    seen.add(i);
    i = nextWording(i, 5);
  }
  assert.equal(seen.size, 5);
  assert.equal(i, 0);
});

test('the progress bar never starts empty and ends full', () => {
  assert.equal(stepPercent(0, 13), 8);
  assert.equal(stepPercent(12, 13), 100);
  assert.equal(stepPercent(99, 13), 100);
  assert.equal(stepPercent(0, 0), 0);
});

test('progress is kept for each ad, read safely, and offers the next ad that is not done', () => {
  const ids = ['a', 'b', 'c'];
  const N = GUIDE_STEPS.length;
  assert.equal(guideStorageKey('p1'), 'ad-guide:v2:p1');
  let p = withStep(EMPTY_PROGRESS, 'a', 4, N);
  assert.deepEqual(p.ads.a, { step: 4, done: false });
  assert.equal(p.last, 'a');
  assert.equal(adProgressLabel(p, 'a', N), `You are on step 5 of ${N}`);
  assert.equal(adProgressLabel(p, 'b', N), 'Not started');
  assert.equal(adProgressLabel(withStep(p, 'b', 0, N), 'b', N), 'Not started');
  p = withDone(p, 'a', N);
  assert.equal(adProgressLabel(p, 'a', N), 'Done');
  assert.equal(nextAdToSetUp(p, ids, 'a'), 'b');
  p = withDone(withDone(p, 'b', N), 'c', N);
  assert.equal(nextAdToSetUp(p, ids, 'c'), null);
  assert.equal(nextAdToSetUp(EMPTY_PROGRESS, [], null), null);
  // Round trip, and anything unreadable, unknown or out of range is dropped.
  assert.deepEqual(parseProgress(serializeProgress(p), ids, N), p);
  assert.deepEqual(parseProgress(null, ids, N), EMPTY_PROGRESS);
  assert.deepEqual(parseProgress('not json', ids, N), EMPTY_PROGRESS);
  assert.deepEqual(parseProgress('[1]', ids, N), { ads: {}, last: null });
  const odd = parseProgress(JSON.stringify({ ads: { a: { step: 999, done: false }, zzz: { step: 1, done: true }, b: 'x' }, last: 'zzz' }), ids, N);
  assert.deepEqual(odd, { ads: { a: { step: N - 1, done: false } }, last: null });
});

test('the guide uses no internal word: no pack, version, code, regenerate or checks, and "Primary text" only as the Facebook box name', () => {
  // What the operator reads: not the file paths (they live under ad-packs).
  const text = JSON.stringify(GUIDE_STEPS.map((st) => ({ id: st.id, title: st.title, action: st.action, detail: st.detail, ourName: st.ourName, stuck: st.stuck, alt: st.screenshot.alt }))).replace(/box called Primary text( in Facebook)?/g, '');
  assert.doesNotMatch(text, /\b(?:packs?|versions?|regenerat\w*|checks|render\w*|codes?|allowance|hash|type-only)\b/i);
  assert.doesNotMatch(text, /primary text/i);
});

// ── The audience recipe (Batch 55, A9) ──

const audience = () => guideStep('set-audience')!;
const audienceText = () => JSON.stringify({ title: audience().title, action: audience().action, detail: audience().detail, checklist: audience().checklist, stuck: audience().stuck, alt: audience().screenshot.alt });

test('the audience step lists the seven settings in order, built from the recipe', () => {
  const list = audience().checklist ?? [];
  assert.equal(list.length, 7);
  assert.deepEqual(list, RECIPE_ITEMS.map(recipeLine));
  assert.deepEqual(RECIPE_ITEMS.map((r) => r.id), ['location', 'age-gender', 'advantage-audience', 'interests', 'placements', 'campaign-budget', 'exclusions']);
  assert.match(list[0], /^Location: United Kingdom, living in or recently in\./);
  assert.match(list[0], /narrow this to your own area/);
  assert.match(list[0], /wider setting gives Meta more to learn from/);
  assert.match(list[1], /^Age and gender: 18 to 65\+, all genders\./);
  assert.match(list[2], /^Advantage\+ audience: On\./);
  assert.match(list[3], /^Interests: /);
  assert.match(list[4], /^Placements: Advantage\+ placements\./);
  assert.match(list[5], /^Campaign budget: On\./);
  assert.match(list[5], /Do not type an amount/);
  assert.match(list[6], /^Exclusions and lookalikes: Leave both empty\./);
  assert.match(list[6], /add your own list if you have one/);
  // The other steps carry no checklist, and the old 30 to 65 age is gone for everyone.
  assert.deepEqual(GUIDE_STEPS.filter((s) => s.checklist).map((s) => s.id), ['set-audience']);
  assert.doesNotMatch(allText(), /30 to 65/);
  assert.doesNotMatch(allText(), /Leave Interests empty/);
});

test('the interests are Real property, Landlord and Airbnb, and the step says them', () => {
  assert.deepEqual([...INTERESTS], ['Real property (property)', 'Landlord', 'Airbnb (lodging)']);
  const line = audience().checklist![3];
  for (const i of INTERESTS) assert.ok(line.includes(i), `${i} in ${line}`);
});

test('the audience step has one-sentence action, a short Stuck answer, and still one screenshot named after its id', () => {
  assert.equal(sentences(audience().action).length, 1);
  assert.match(audience().action, /\.$/);
  const n = sentences(audience().stuck).length;
  assert.ok(n >= 1 && n <= 3, `stuck has ${n} sentences`);
  assert.equal(audience().screenshot.file, 'public/ad-packs/guide/set-audience.png');
  assert.equal(GUIDE_STEPS.length, 13);
});

test('no audience text names the product, an account, spend or a result, or has a pound sign or an exclamation mark', () => {
  for (const text of [audienceText(), JSON.stringify(RECIPE_ITEMS)]) {
    assert.doesNotMatch(text, /stayful/i);
    assert.doesNotMatch(text, /account/i);
    assert.doesNotMatch(text, /spend|spent/i);
    assert.doesNotMatch(text, /results?\b/i);
    assert.doesNotMatch(text, /£|\\u00a3/);
    assert.doesNotMatch(text, /!/);
    assert.doesNotMatch(text, /—|\\u2014/);
    assert.doesNotMatch(text, /\d[\d,]*\s?(?:pounds|GBP|pence|p\b)/i);
  }
});

test('the recipe is dated, and the proposed campaign goal is recorded but not shown in the guide', () => {
  assert.equal(LAST_CHECKED, '2026-11-23');
  assert.equal(OBJECTIVE_PROPOSED.status, 'proposed');
  assert.equal(OBJECTIVE_PROPOSED.goal, 'Leads');
  assert.equal(OBJECTIVE_PROPOSED.destination, 'Website');
  assert.equal(OBJECTIVE_PROPOSED.optimiseFor, 'Maximise number of landing page views');
  assert.doesNotMatch(allText(), /landing page views/i);
  assert.match(guideStep('choose-traffic')!.action, /Traffic/);
});

// ── Batch 55 step 5 (Phase 3): the location follows the lead database pack's coverage ──

test('audience location, lead database: nationwide says the UK with no note to narrow it; areas list each town with a radius', () => {
  const uk = recipeItemsFor({ mode: 'uk' });
  assert.equal(uk.length, 7);
  assert.equal(recipeLine(uk[0]), 'Location: United Kingdom, living in or recently in.');
  assert.doesNotMatch(recipeLine(uk[0]), /narrow/);
  const areas = recipeItemsFor({ mode: 'areas', areas: ['Leeds', 'York', 'Harrogate'] });
  assert.equal(AREA_RADIUS_MILES, 25);
  assert.match(recipeLine(areas[0]), /^Location: Add each of these towns with a 25 mile radius: Leeds, York and Harrogate\./);
  assert.match(recipeLine(areas[0]), /living in or recently in/);
  assert.match(recipeLine(recipeItemsFor({ mode: 'areas', areas: ['Leeds'] })[0]), /^Location: Add this town with a 25 mile radius: Leeds\./);
  assert.match(recipeLine(recipeItemsFor({ mode: 'areas', areas: ['Lenton, Nottingham', 'York'] })[0]), /Lenton, Nottingham and York\./);
  // Every other line is the shared recipe, word for word.
  for (const items of [uk, areas]) assert.deepEqual(items.slice(1).map(recipeLine), RECIPE_ITEMS.slice(1).map(recipeLine));
  for (const text of [JSON.stringify(uk), JSON.stringify(areas)]) {
    assert.doesNotMatch(text, /stayful|account|spend|results?\b|£|!|—/i);
  }
});

test('audience location: the Academy guide is unchanged (no coverage passed), and the recipe date is not moved', () => {
  assert.deepEqual(audienceChecklistFor(), RECIPE_ITEMS.map(recipeLine));
  assert.deepEqual(audienceChecklistFor(), guideStep('set-audience')!.checklist);
  assert.match(audienceChecklistFor()[0], /narrow this to your own area/);
  assert.match(audienceChecklistFor({ mode: 'areas', areas: ['York'] })[0], /York/);
  assert.equal(LAST_CHECKED, '2026-11-23');
});
