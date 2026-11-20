import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEBSITE_EDIT_REWRITES_PER_MONTH,
  changedFields,
  filesInUse,
  filesToDelete,
  pageRefKey,
  pagesToRewrite,
  parsePageRefKey,
  rewritesLeft,
  takeRewrite,
  ukMonth,
  type EditSide,
} from './edit-rules.ts';
import { SAMPLE_COPY, SAMPLE_SETTINGS } from './sample-site.ts';
import type { SiteCopy, SiteSettings } from './page-model.ts';

const side = (s: Partial<SiteSettings> = {}, copy: SiteCopy | null = SAMPLE_COPY): EditSide => ({ settings: { ...SAMPLE_SETTINGS, ...s }, copy });
const keys = (p: ReturnType<typeof pagesToRewrite>) => p.rewrite.map(pageRefKey);

test('changedFields lists exactly what differs, in a fixed order', () => {
  assert.deepEqual(changedFields(SAMPLE_SETTINGS, SAMPLE_SETTINGS), []);
  assert.deepEqual(changedFields(SAMPLE_SETTINGS, { ...SAMPLE_SETTINGS, contactPhone: '0113 496 0999', managementFeePct: 12 }), ['managementFeePct', 'contactPhone']);
  assert.deepEqual(changedFields(SAMPLE_SETTINGS, { ...SAMPLE_SETTINGS, areas: ['Leeds', 'Harrogate', 'York'] }), ['areas']);
  assert.deepEqual(changedFields(SAMPLE_SETTINGS, { ...SAMPLE_SETTINGS, aboutText: null, photoUrl: null }), [], 'null equals null');
});

test('a fee change rewrites nothing', () => {
  const p = pagesToRewrite(side(), side({ managementFeePct: 12 }));
  assert.deepEqual(p, { rewrite: [], drop: [] });
});

test('phone, email, logo, colour and photo rewrite nothing', () => {
  for (const change of [
    { contactPhone: '0113 496 0999' },
    { contactEmail: 'new@northernlets.co.uk' },
    { logoUrl: 'https://example.com/other.png' },
    { logoUrl: null },
    { brandColour: '#112233' },
    { photoUrl: 'https://example.com/me.jpg' },
  ] as Partial<SiteSettings>[]) {
    assert.deepEqual(pagesToRewrite(side(), side(change)), { rewrite: [], drop: [] }, JSON.stringify(change));
  }
});

test('an added area rewrites only its own page', () => {
  const p = pagesToRewrite(side(), side({ areas: ['Leeds', 'Harrogate', 'York'] }));
  assert.deepEqual(keys(p), ['area:york']);
  assert.deepEqual(p.drop, []);
  assert.deepEqual(p.rewrite[0], { page: 'area', area: 'York' });
});

test('a removed area drops its page and rewrites nothing when no other page names it', () => {
  const p = pagesToRewrite(side(), side({ areas: ['Harrogate'] }));
  assert.deepEqual(p, { rewrite: [], drop: ['Leeds'] });
});

test('a page that names a removed area is rewritten, and the dropped area page is not', () => {
  const copy: SiteCopy = { ...SAMPLE_COPY, home: { ...SAMPLE_COPY.home, intro: 'We manage short lets in Leeds and Harrogate for owners.' } };
  const p = pagesToRewrite(side({}, copy), side({ areas: ['Harrogate'] }, copy));
  assert.deepEqual(keys(p), ['home']);
  assert.deepEqual(p.drop, ['Leeds']);
});

test('a page that names the old company name is rewritten; one that does not is left alone', () => {
  const p = pagesToRewrite(side(), side({ companyName: 'Harbour Management' }));
  // The sample's About page is the only one that says "Northern Lets".
  assert.deepEqual(keys(p), ['about']);
  assert.deepEqual(p.drop, []);
});

test('the old company name is matched as a word, in any case', () => {
  const copy: SiteCopy = { ...SAMPLE_COPY, fees: { ...SAMPLE_COPY.fees, body: 'northern lets keeps one simple fee.' }, faq: { ...SAMPLE_COPY.faq, headline: 'Northern Letsmore' } };
  const p = pagesToRewrite(side({}, copy), side({ companyName: 'Harbour' }, copy));
  assert.deepEqual(keys(p).sort(), ['about', 'fees']);
});

test('a changed about text rewrites the about page (once, even if the company changed too)', () => {
  assert.deepEqual(keys(pagesToRewrite(side(), side({ aboutText: 'We started in 2015.' }))), ['about']);
  assert.deepEqual(keys(pagesToRewrite(side(), side({ aboutText: 'We started in 2015.', companyName: 'Harbour' }))), ['about']);
  assert.deepEqual(pagesToRewrite(side({ aboutText: 'Same' }), side({ aboutText: ' Same ' })), { rewrite: [], drop: [] });
});

test('adding one area and removing another at once: the new page is written, the old one dropped, in a stable order', () => {
  const p = pagesToRewrite(side(), side({ areas: ['Harrogate', 'York', 'Ripon'] }));
  assert.deepEqual(keys(p), ['area:ripon', 'area:york']);
  assert.deepEqual(p.drop, ['Leeds']);
});

test('area names compare without regard to case, so only a real rename counts', () => {
  assert.deepEqual(pagesToRewrite(side(), side({ areas: ['leeds', 'HARROGATE'] })), { rewrite: [], drop: [] });
});

test('with no copy to scan, only the added area and the about text are asked for', () => {
  const p = pagesToRewrite(side({}, null), side({ companyName: 'Harbour', areas: ['Leeds', 'York'] }, null));
  assert.deepEqual(keys(p), ['area:york']);
});

test('page keys round trip', () => {
  for (const k of ['home', 'fees', 'about', 'faq', 'area:york']) assert.equal(pageRefKey(parsePageRefKey(k)!), k);
  assert.equal(parsePageRefKey('privacy'), null);
  assert.equal(parsePageRefKey('area:'), null);
});

// ── Files ──

const withFiles = (logoUrl: string | null, photoUrl: string | null = null) => ({ settings: { logoUrl, photoUrl } });

test('a file is in use while the live site, the draft or any kept version refers to it', () => {
  const inUse = filesInUse(withFiles('https://x/live.png'), withFiles('https://x/draft.png', 'https://x/me.jpg'), [withFiles('https://x/v1.png'), withFiles(null), { settings: null }]);
  assert.deepEqual([...inUse].sort(), ['https://x/draft.png', 'https://x/live.png', 'https://x/me.jpg', 'https://x/v1.png']);
  assert.equal(filesInUse(null, null, []).size, 0);
});

test('replacing a logo deletes nothing while a kept version still shows the old one', () => {
  const v1 = withFiles('https://x/old.png');
  const before = filesInUse(withFiles('https://x/old.png'), withFiles('https://x/new.png'), [v1]);
  const after = filesInUse(withFiles('https://x/new.png'), null, [v1, withFiles('https://x/new.png')]);
  assert.deepEqual(filesToDelete(before, after), []);
});

test('a file is deleted only once the last version that showed it is pruned', () => {
  const before = filesInUse(withFiles('https://x/new.png'), null, [withFiles('https://x/old.png'), withFiles('https://x/new.png')]);
  const after = filesInUse(withFiles('https://x/new.png'), null, [withFiles('https://x/new.png')]);
  assert.deepEqual(filesToDelete(before, after), ['https://x/old.png']);
});

test('a file uploaded into a draft and then discarded is deleted', () => {
  const before = filesInUse(withFiles('https://x/live.png'), withFiles('https://x/draft.png'), []);
  const after = filesInUse(withFiles('https://x/live.png'), null, []);
  assert.deepEqual(filesToDelete(before, after), ['https://x/draft.png']);
});

// ── The monthly allowance ──

test('the allowance is 10 a month, separate from setup', () => {
  assert.equal(WEBSITE_EDIT_REWRITES_PER_MONTH, 10);
});

test('the month is the Europe/London calendar month', () => {
  assert.equal(ukMonth(new Date('2026-11-20T12:00:00Z')), '2026-11');
  // In winter London is on UTC, so the month turns at 00:00 UTC.
  assert.equal(ukMonth(new Date('2026-11-30T23:59:00Z')), '2026-11');
  assert.equal(ukMonth(new Date('2026-12-01T00:00:00Z')), '2026-12');
  // British Summer Time: 23:30 UTC on 30 June is 00:30 on 1 July in London.
  assert.equal(ukMonth(new Date('2026-06-30T23:30:00Z')), '2026-07');
});

test('the 11th rewrite in a month is refused, and next month starts again at 10', () => {
  const nov = new Date('2026-11-20T10:00:00Z');
  let used = 0;
  let month: string | null = null;
  for (let i = 1; i <= 10; i++) {
    const next = takeRewrite(used, month, nov);
    assert.ok(next, `rewrite ${i} is allowed`);
    ({ used, month } = next);
  }
  assert.deepEqual({ used, month }, { used: 10, month: '2026-11' });
  assert.equal(rewritesLeft(used, month, nov), 0);
  assert.equal(takeRewrite(used, month, nov), null, 'the 11th is refused');
  const dec = new Date('2026-12-02T10:00:00Z');
  assert.equal(rewritesLeft(used, month, dec), 10);
  assert.deepEqual(takeRewrite(used, month, dec), { month: '2026-12', used: 1 });
});

test('a fresh site (no month yet) has the full allowance', () => {
  assert.equal(rewritesLeft(0, null, new Date('2026-11-20T10:00:00Z')), 10);
  assert.equal(rewritesLeft(7, '2026-11', new Date('2026-11-20T10:00:00Z')), 3);
  assert.equal(rewritesLeft(99, '2026-11', new Date('2026-11-20T10:00:00Z')), 0);
});
