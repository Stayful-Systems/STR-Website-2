import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPageFields, keyOf, pageFieldsOf, pageLabel } from './edit-fields.ts';
import { SAMPLE_COPY } from './sample-site.ts';

test('every page of the sample copy has editable fields, and applying its own values changes nothing', () => {
  const refs = [{ page: 'home' }, { page: 'area', area: 'Leeds' }, { page: 'fees' }, { page: 'about' }, { page: 'faq' }] as const;
  for (const ref of refs) {
    const fields = pageFieldsOf(SAMPLE_COPY, ref);
    assert.ok(fields.length >= 2, keyOf(ref));
    const values = Object.fromEntries(fields.map((x) => [x.name, x.value]));
    assert.deepEqual(applyPageFields(SAMPLE_COPY, ref, values), SAMPLE_COPY, keyOf(ref));
  }
});

test('editing one page changes only that page, and never mutates the input', () => {
  const before = structuredClone(SAMPLE_COPY);
  const next = applyPageFields(SAMPLE_COPY, { page: 'area', area: 'harrogate' }, { headline: 'Lettings in Harrogate', body: 'Our own words.' });
  assert.deepEqual(SAMPLE_COPY, before);
  assert.equal(next.areas.find((a) => a.area === 'Harrogate')?.headline, 'Lettings in Harrogate');
  assert.deepEqual(next.areas.find((a) => a.area === 'Leeds'), SAMPLE_COPY.areas[0]);
  assert.deepEqual(next.fees, SAMPLE_COPY.fees);
  assert.deepEqual(next.about, SAMPLE_COPY.about);
});

test('fees includes are one per line, blanks dropped; faq and benefits edit by position', () => {
  const next = applyPageFields(SAMPLE_COPY, { page: 'fees' }, { includes: 'Guest messaging\n\n  Cleaning  \n' });
  assert.deepEqual(next.fees.includes, ['Guest messaging', 'Cleaning']);
  const faq = applyPageFields(SAMPLE_COPY, { page: 'faq' }, { 'faq.1.answer': 'No promises.' });
  assert.equal(faq.faq.items[1].answer, 'No promises.');
  assert.equal(faq.faq.items[0].answer, SAMPLE_COPY.faq.items[0].answer);
  const home = applyPageFields(SAMPLE_COPY, { page: 'home' }, { 'benefit.0.title': 'Calm' });
  assert.equal(home.home.benefits[0].title, 'Calm');
});

test('a new area with no block yet has empty fields; applying to a missing area changes nothing', () => {
  const fields = pageFieldsOf(SAMPLE_COPY, { page: 'area', area: 'York' });
  assert.deepEqual(fields.map((x) => x.value), ['', '']);
  assert.deepEqual(applyPageFields(SAMPLE_COPY, { page: 'area', area: 'York' }, { headline: 'x' }), SAMPLE_COPY);
});

test('page labels read as words', () => {
  assert.equal(pageLabel({ page: 'faq' }), 'FAQ');
  assert.equal(pageLabel({ page: 'about' }), 'about');
  assert.equal(pageLabel({ page: 'area', area: 'york' }, 'York'), 'York');
  assert.equal(pageLabel({ page: 'area', area: 'york' }), 'york');
});
