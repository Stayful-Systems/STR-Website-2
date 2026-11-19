import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaSlug, buildSitePages, feeLabel, leadFormFor, listAreas, pageAt, pageFields, paragraphsOf, MAX_AREAS, PAGE_KEYS } from './page-model.ts';
import { SAMPLE_COPY, SAMPLE_SETTINGS, SAMPLE_SITE } from './sample-site.ts';
import { siteHref } from './urls.ts';
import { consentText, EMPTY_BRAND, readableOn } from '../funnels/brand.ts';

const build = () => buildSitePages({ site: SAMPLE_SITE, settings: SAMPLE_SETTINGS, copy: SAMPLE_COPY });

test('page model: home, one page per area, fees, about, faq, privacy', () => {
  const pages = build();
  assert.deepEqual(
    pages.map((p) => p.path),
    ['', 'areas/leeds', 'areas/harrogate', 'fees', 'about', 'faq', 'privacy'],
  );
  assert.deepEqual([...new Set(pages.map((p) => p.key))].sort(), [...PAGE_KEYS].sort());
  assert.equal(pageAt(pages, '/fees/')?.key, 'fees');
  assert.equal(pageAt(pages, 'areas/leeds')?.area?.name, 'Leeds');
  assert.equal(pageAt(pages, 'nope'), null);
});

test('page model: every link is built with siteHref', () => {
  for (const p of build()) {
    assert.equal(p.href, siteHref(SAMPLE_SITE, p.path));
    for (const l of [...p.nav, ...p.areaLinks, ...p.footer]) assert.match(l.href, /^\/s\/northern-lets(\/|$)/);
    if (p.form) assert.equal(p.form.privacyHref, siteHref(SAMPLE_SITE, 'privacy'));
  }
  const home = build()[0];
  assert.equal(home.href, '/s/northern-lets');
  assert.deepEqual(home.areaLinks.map((l) => l.href), ['/s/northern-lets/areas/leeds', '/s/northern-lets/areas/harrogate']);
  assert.equal(home.nav[1].href, '/s/northern-lets/fees');
});

test('page model: the lead form is on every page but privacy, with the funnel consent text', () => {
  const pages = build();
  for (const p of pages) assert.equal(p.form === null, p.key === 'privacy', p.path);
  const form = pages[0].form!;
  assert.equal(form.action, '/api/s/northern-lets/lead');
  assert.deepEqual(form.fields.map((f) => f.name), ['name', 'email', 'phone']);
  assert.equal(form.consentText, consentText({ ...EMPTY_BRAND, companyName: 'Northern Lets' }));
  // The privacy page shows the very same wording.
  const privacy = pageAt(pages, 'privacy')!;
  assert.ok(privacy.sections.find((s) => s.id === 'consent')!.paragraphs.includes(form.consentText));
  assert.match(privacy.sections[0].paragraphs[0], /Northern Lets is the data controller/);
  assert.match(privacy.sections[0].paragraphs[0], /processes them on its behalf/);
});

test('page model: the fee comes from the settings, not the copy', () => {
  const fees = pageAt(build(), 'fees')!;
  assert.deepEqual(fees.sections[0].paragraphs, ['Our management fee is 15%.']);
  assert.equal(feeLabel(12.5), '12.5%');
  assert.equal(feeLabel(null), null);
  assert.equal(feeLabel(0), null);
  const none = buildSitePages({ site: SAMPLE_SITE, settings: { ...SAMPLE_SETTINGS, managementFeePct: null }, copy: SAMPLE_COPY });
  assert.deepEqual(pageAt(none, 'fees')!.sections[0].paragraphs, []);
});

test('page model: identity carries a valid colour with its readable text colour, and a dialable phone', () => {
  const id = build()[0].site;
  assert.equal(id.primary, '#0a96a0');
  assert.equal(id.onPrimary, readableOn('#0a96a0'));
  assert.equal(id.phoneTel, '+441134960123');
  const bad = buildSitePages({ site: SAMPLE_SITE, settings: { ...SAMPLE_SETTINGS, brandColour: 'teal', logoUrl: 'http://x/y.svg' }, copy: SAMPLE_COPY })[0].site;
  assert.equal(bad.primary, null);
  assert.equal(bad.onPrimary, null);
  assert.equal(bad.logoUrl, null);
});

test('page model: about shows the member\'s own words when given', () => {
  const pages = buildSitePages({ site: SAMPLE_SITE, settings: { ...SAMPLE_SETTINGS, aboutText: 'I started in 2019.\n\nI love Leeds.' }, copy: SAMPLE_COPY });
  const about = pageAt(pages, 'about')!;
  assert.deepEqual(about.sections.find((s) => s.id === 'owner')!.paragraphs, ['I started in 2019.', 'I love Leeds.']);
});

test('page model: areas get unique clean slugs, blanks dropped, capped', () => {
  assert.equal(areaSlug('  St. Ives & Zennor!  '), 'st-ives-zennor');
  assert.equal(areaSlug('Málaga'), 'malaga');
  assert.equal(areaSlug('!!!'), '');
  assert.deepEqual(listAreas(['Leeds', 'leeds', '', '  ', 'York']).map((a) => a.slug), ['leeds', 'leeds-2', 'york']);
  assert.equal(listAreas(Array.from({ length: 30 }, (_, i) => `Town ${i}`)).length, MAX_AREAS);
  // The slug is a plain path segment: it cannot carry a host or a path out of the site.
  assert.ok(listAreas(['https://evil.example/x', '../..']).every((a) => /^[a-z0-9-]+$/.test(a.slug)));
});

test('page model: a missing copy block gives empty fields, not a crash', () => {
  const pages = buildSitePages({ site: SAMPLE_SITE, settings: SAMPLE_SETTINGS, copy: {} as never });
  assert.equal(pages.length, 7);
  assert.equal(pages[0].heading, '');
});

test('page model: pageFields lists the visible text with stable names', () => {
  const fields = pageFields(pageAt(build(), 'faq')!);
  assert.ok(fields.some((f) => f.field === 'faq.1.answer' && /stays yours/.test(f.text)));
  assert.ok(fields.some((f) => f.field === 'form.consent'));
  assert.deepEqual(paragraphsOf('a\n\n  b   c \n\n\n'), ['a', 'b c']);
  assert.equal(leadFormFor({ slug: 'a b' }, 'X').action, '/api/s/a%20b/lead');
});
