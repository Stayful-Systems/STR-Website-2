import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleCopy, buildCopyPrompt, checkPageCopy, COPY_PAGES, GUARDRAILS, PAGE_SCHEMAS, parsePageCopy, type CopyPage, type PageCopy } from './copy-prompt.ts';
import { buildSitePages, listAreas } from './page-model.ts';
import { checkSite } from './checks.ts';
import { SAMPLE_COPY, SAMPLE_SETTINGS, SAMPLE_SITE } from './sample-site.ts';

const base = { companyName: SAMPLE_SETTINGS.companyName, areas: SAMPLE_SETTINGS.areas };
const prompt = (page: CopyPage) => buildCopyPrompt({ ...base, page, areaName: page === 'area' ? 'Leeds' : undefined });

test('every page prompt carries every guardrail, word for word', () => {
  for (const page of COPY_PAGES) {
    const { system } = prompt(page);
    for (const g of GUARDRAILS) assert.ok(system.includes(g.rule), `${page} prompt is missing ${g.id}`);
  }
});

test('the guardrails cover the brief: no income ranges, never "you will earn", "you stay the owner", no guarantees, no "no voids", no invented stats', () => {
  const rules = GUARDRAILS.map((g) => g.rule).join('\n');
  assert.match(rules, /income, rent, profit or yield figure or range/);
  assert.match(rules, /"you will earn"/);
  assert.match(rules, /you stay the owner/);
  assert.match(rules, /no guarantees of any kind/i);
  assert.match(rules, /"no voids"/);
  assert.match(rules, /invent statistics/);
  assert.equal(new Set(GUARDRAILS.map((g) => g.id)).size, GUARDRAILS.length);
});

test('the prompt carries the company and areas but never contact details or the fee', () => {
  const { system, user } = buildCopyPrompt({ ...base, page: 'about', aboutText: 'We are a family firm.' });
  assert.match(user, /Northern Lets/);
  assert.match(user, /Leeds, Harrogate/);
  assert.match(user, /family firm/);
  const all = `${system}\n${user}`;
  assert.ok(!all.includes(SAMPLE_SETTINGS.contactEmail));
  assert.ok(!all.includes('0113'));
  assert.ok(!/15\s?%/.test(all));
  // The member's own words are only used on the about page.
  assert.ok(!buildCopyPrompt({ ...base, page: 'home', aboutText: 'We are a family firm.' }).user.includes('family firm'));
});

test('an area prompt names its area; a retry prompt lists what went wrong', () => {
  assert.match(prompt('area').user, /This page is about: Leeds/);
  const retry = buildCopyPrompt({ ...base, page: 'home', problems: [{ field: 'intro', rule: 'banned_claim', message: 'Not allowed ("you will earn"): "you will earn more"' }] });
  assert.match(retry.user, /refused/);
  assert.match(retry.user, /intro: Not allowed/);
});

test('each page has a closed JSON schema', () => {
  for (const page of COPY_PAGES) {
    const s = PAGE_SCHEMAS[page] as { type: string; required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
    assert.equal(s.type, 'object');
    assert.equal(s.additionalProperties, false);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
    assert.equal(prompt(page).schema, s);
  }
});

const sampleJson: Record<CopyPage, unknown> = {
  home: { ...SAMPLE_COPY.home, benefits: [...SAMPLE_COPY.home.benefits, { title: 'Clear reporting', body: 'You see what happens at your property.' }] },
  area: SAMPLE_COPY.areas[0],
  fees: { ...SAMPLE_COPY.fees, includes: [...SAMPLE_COPY.fees.includes, 'Regular updates on how your property is doing'] },
  about: SAMPLE_COPY.about,
  faq: {
    headline: SAMPLE_COPY.faq.headline,
    items: [...SAMPLE_COPY.faq.items, { question: 'Is the estimate free?', answer: 'Yes.' }, { question: 'How do I start?', answer: 'Ask for an estimate.' }, { question: 'Who looks after guests?', answer: 'We do.' }],
  },
};

test('a generated sample reply parses and passes the checks, page by page and as a whole site', () => {
  const parsed = {} as Record<CopyPage, PageCopy>;
  for (const page of COPY_PAGES) {
    const r = parsePageCopy(page, JSON.stringify(sampleJson[page]));
    assert.ok(r.ok, `${page}: ${r.ok ? '' : r.error}`);
    if (r.ok) {
      parsed[page] = r.value;
      assert.deepEqual(checkPageCopy(page, r.value), [], page);
    }
  }
  const areas = listAreas(SAMPLE_SETTINGS.areas).map((a, i) => {
    const r = parsePageCopy('area', JSON.stringify(SAMPLE_COPY.areas[i]));
    assert.ok(r.ok);
    return { area: a.name, copy: (r as { value: { headline: string; body: string } }).value };
  });
  const copy = assembleCopy({ home: parsed.home as never, areas, fees: parsed.fees as never, about: parsed.about as never, faq: parsed.faq as never });
  const result = checkSite(buildSitePages({ site: SAMPLE_SITE, settings: SAMPLE_SETTINGS, copy }), { managementFeePct: SAMPLE_SETTINGS.managementFeePct });
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test('a reply with a banned claim, a placeholder or a figure is flagged', () => {
  const bad = parsePageCopy('area', JSON.stringify({ headline: 'Lets in [Area]', body: 'You will earn £3,000 - £4,000 a month with no voids.' }));
  assert.ok(bad.ok);
  if (bad.ok) {
    const rules = new Set(checkPageCopy('area', bad.value).map((p) => p.rule));
    assert.ok(rules.has('placeholder'));
    assert.ok(rules.has('banned_claim'));
  }
  const fee = parsePageCopy('fees', JSON.stringify({ ...(sampleJson.fees as object), body: 'We charge 15% of rent.' }));
  assert.ok(fee.ok);
  if (fee.ok) assert.ok(checkPageCopy('fees', fee.value).some((p) => p.rule === 'banned_claim'));
});

test('the parser refuses what the schema asked for and did not get', () => {
  assert.equal(parsePageCopy('home', 'not json').ok, false);
  assert.equal(parsePageCopy('home', null).ok, false);
  assert.equal(parsePageCopy('area', JSON.stringify({ headline: 'x' })).ok, false);
  assert.equal(parsePageCopy('area', JSON.stringify({ headline: 'x'.repeat(200), body: 'y' })).ok, false);
  assert.equal(parsePageCopy('home', JSON.stringify({ ...(sampleJson.home as object), benefits: [] })).ok, false);
  assert.equal(parsePageCopy('faq', JSON.stringify({ headline: 'Q', items: [{ question: 'a', answer: 'b' }] })).ok, false);
  // Unknown keys are dropped, not carried.
  const r = parsePageCopy('area', JSON.stringify({ headline: 'H', body: 'B', extra: 'x' }));
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(Object.keys(r.value), ['headline', 'body']);
});
