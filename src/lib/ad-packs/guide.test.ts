import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GUIDE_STEPS,
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
} from './guide.ts';

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

test('the guide explains the pack code in the name and leaves the {{ad.id}} part alone', () => {
  assert.match(guideStep('paste-ad-name')!.detail ?? '', /pack code/);
  const link = guideStep('paste-link')!.detail ?? '';
  assert.ok(link.includes('{{ad.id}}'));
  assert.match(link, /Meta fills it in/);
  assert.match(link, /Do not edit/);
  assert.match(link, /which ad works/);
});

test('it covers the Traffic objective, no pixel, a Page and ad account, placements and the review wait', () => {
  assert.match(guideStep('choose-traffic')!.action, /Traffic/);
  assert.match(guideStep('open-ads-manager')!.action, /adsmanager\.facebook\.com/);
  assert.match(guideStep('open-ads-manager')!.stuck, /Facebook Page/);
  assert.match(guideStep('open-ads-manager')!.stuck, /ad account/);
  assert.match(guideStep('upload-file')!.detail ?? '', /4:5/);
  assert.match(guideStep('upload-file')!.detail ?? '', /9:16/);
  assert.match(guideStep('upload-file')!.detail ?? '', /1:1/);
  assert.match(guideStep('upload-file')!.detail ?? '', /video that arrives later/);
  assert.match(guideStep('set-audience')!.detail ?? '', /30 to 65 and over/);
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
  assert.deepEqual(none, { kind: 'placeholder', text: `Screenshot to come: ${step.screenshot.alt}` });
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

test('the screen wires the guide: server-side screenshot check, #guide kept, copy buttons reused, progress only in the browser', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const page = code(read('../../app/leads/ads/page.tsx'));
  const client = code(read('../../app/leads/ads/Guide.tsx'));
  const server = code(read('./guide-server.ts'));
  assert.match(page, /id="guide"/);
  assert.match(page, /<Guide\b/);
  assert.match(page, /availableGuideShots\(\)/);
  assert.match(server, /^import 'server-only';/);
  assert.match(server, /existsSync/);
  assert.match(client, /^"use client";/);
  assert.match(client, /TextRow/);
  assert.match(client, /<details/);
  assert.match(client, /localStorage/);
  assert.doesNotMatch(client, /from "node:fs"|from "fs"/);
  assert.match(read('../../../next.config.ts'), /public\/ad-packs\/guide/);
});
