import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANGLES, operatorCode, packCode, type Angle } from './codes.ts';
import { adLink, adName } from './links.ts';
import { buildFigure } from './figures.ts';
import { renderCards, renderScript, renderTexts } from './angles.ts';
import { AD_IMAGE_SIZES, CHECK_IDS, contrastRatio, MAX_VIDEO_SECONDS, mergeVideoChecks, pickTextColour, runChecks, VIDEO_SIZES, videoChecks, type CheckAd, type CheckInput, type CheckVideo } from './checks.ts';

const OWNER = '3f9a2c11-7b4e-4d2a-9c10-aa55bb66cc77';
const OP = operatorCode(OWNER);
const DOMAIN = 'brightstone.co.uk';
const AGG = { bedrooms: 3, sample_count: 14, avg_gross_revenue: 48_200, avg_net_revenue: 31_000, avg_occupancy: 71.4 };
// Built from parts so a repo-wide search for the source brand finds no copy of it here.
const SRC = 'Stay' + 'ful';
const SRC_SITE = 'stay' + 'ful.co.uk';

function pack(over: { feePct?: number | null; company?: string; figure?: boolean } = {}): CheckInput {
  const feePct = over.feePct === undefined ? 12 : over.feePct;
  const company = over.company ?? 'Brightstone Stays';
  const figure = over.figure === false ? null : buildFigure({ area_label: 'Cambridge', agg: AGG, feePct, netIncludesFee: false });
  const brand = { company, area: 'Cambridge', bedrooms: 3, feePct };
  const ads: CheckAd[] = ANGLES.map((angle: Angle, i) => {
    const code = packCode(OP, angle, 1);
    const texts = renderTexts({ angle, brand, figure });
    return {
      angle,
      code,
      adName: adName(code, angle),
      link: adLink({ domain: DOMAIN, code, operatorCode: OP }),
      texts,
      ...(angle === '5b' ? { script: renderScript({ brand, figure }).text } : { cardsText: renderCards({ angle, brand, figure }).map((c) => [c.headline, ...c.body, c.cta, c.big ?? ''].filter(Boolean).join('\n')) }),
      ...(i === 1 ? { files: [{ name: '3a-1x1.png', width: 1080, height: 1080 }, { name: '3a-4x5.png', width: 1080, height: 1350 }, { name: '3a-9x16.png', width: 1080, height: 1920 }] } : {}),
    };
  });
  return {
    brand: { company, logoUrl: 'https://cdn.example.com/logo.png', brandColour: '#1a5fb4', feePct, areaLabel: 'Cambridge', areaKey: 'CB1' },
    ads,
    figures: figure ? [{ areaKey: 'CB1', label: figure.label, sentence: figure.sentence }] : [],
    operatorCode: OP,
    domain: DOMAIN,
  };
}

/** The lead database route: links go to /s/<slug> on this app's own host, not to an own domain. */
const APP_HOST = SRC_SITE;
const SLUG = 'brightstone-calc';
function leadDbPack(): CheckInput {
  const base = pack();
  const c = structuredClone(base);
  c.domain = APP_HOST;
  c.sitePath = SLUG;
  for (const a of c.ads) a.link = adLink({ domain: APP_HOST, sitePath: SLUG, code: a.code, operatorCode: OP });
  return c;
}

const rules = (i: CheckInput) => runChecks(i).failures.map((f) => f.rule);
const withText = (i: CheckInput, patch: (ad: CheckAd) => void, angle: Angle = '3a'): CheckInput => {
  const c = structuredClone(i);
  patch(c.ads.find((a) => a.angle === angle)!);
  return c;
};

test('a pack built from the real templates passes every check', () => {
  for (const feePct of [12, null, 15]) {
    for (const figure of [true, false]) {
      const r = runChecks(pack({ feePct, figure }));
      assert.deepEqual(r.failures, [], JSON.stringify(r.failures));
      assert.equal(r.ok, true);
      assert.deepEqual(
        r.results.map((x) => x.check),
        [...CHECK_IDS],
      );
      assert.ok(r.results.every((x) => x.ok));
    }
  }
});

test('brand: the company name must be in each ad, the logo present or type-only, the colour a real hex', () => {
  const base = pack();
  const strip = (t: string) => t.replaceAll('Brightstone Stays', 'us');
  const unbranded = withText(base, (a) => {
    a.texts.primary = a.texts.primary.map(strip);
    a.texts.headlines = a.texts.headlines.map(strip);
    a.texts.descriptions = a.texts.descriptions.map(strip);
    a.cardsText = a.cardsText?.map(strip);
  });
  assert.ok(rules(unbranded).includes('brand_company'));
  // The cards alone can carry the name.
  const onCards = withText(unbranded, (a) => (a.cardsText = ['Brightstone Stays']));
  assert.ok(!rules(onCards).includes('brand_company'));
  assert.ok(rules(pack({ company: '' })).includes('brand_company'));
  const noLogo = structuredClone(base);
  noLogo.brand.logoUrl = null;
  assert.ok(rules(noLogo).includes('brand_logo'));
  noLogo.brand.typeOnly = true;
  assert.ok(!rules(noLogo).includes('brand_logo'), 'type-only is an explicit allowance');
  const http = structuredClone(base);
  http.brand.logoUrl = 'http://cdn.example.com/logo.png';
  assert.ok(rules(http).includes('brand_logo'));
  for (const bad of ['blue', '#12', '#12345g', '1a5fb4', null]) {
    const c = structuredClone(base);
    c.brand.brandColour = bad as string | null;
    assert.ok(rules(c).includes('brand_colour'), String(bad));
  }
});

test('contrast helper: WCAG ratios and the text colour the renderer will use', () => {
  assert.equal(contrastRatio('#000000', '#ffffff')?.toFixed(2), '21.00');
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  assert.equal(contrastRatio('nope', '#ffffff'), null);
  assert.equal(pickTextColour('#000000'), '#ffffff');
  assert.equal(pickTextColour('#ffffff'), '#111111');
  assert.equal(pickTextColour('#ffd60a'), '#111111');
  assert.equal(pickTextColour('#1a5fb4'), '#ffffff');
  assert.equal(pickTextColour('garbage'), '#ffffff');
  // Whatever the colour, the picked text colour reaches 3:1 (the best of white and near-black always does).
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
    const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    assert.ok((contrastRatio(hex, pickTextColour(hex)) ?? 0) >= 3, hex);
  }
});

test('no source brand: the word, the site, every example figure and the fee line are rejected', () => {
  const base = pack();
  const inPrimary = (s: string) => withText(base, (a) => (a.texts.primary[0] = `${a.texts.primary[0]} ${s}`));
  assert.ok(rules(inPrimary(`Powered by ${SRC}.`)).includes('source_word'));
  assert.ok(rules(inPrimary(SRC.toUpperCase())).includes('source_word'));
  assert.ok(rules(inPrimary(`See ${SRC_SITE}`)).includes('source_word'));
  assert.ok(rules(withText(base, (a) => (a.texts.headlines[0] = SRC))).includes('source_word'));
  assert.ok(rules(withText(base, (a) => (a.script = `We are ${SRC}.`), '5b')).includes('source_word'));
  assert.ok(rules(withText(base, (a) => (a.cardsText = [`${SRC} cards`]))).includes('source_word'));
  assert.ok(rules(pack({ company: `${SRC} Partners` })).includes('source_word'));
  for (const fig of ['2,399', '2399', '1,349', '1349', '3,097', '3097', '7,681', '7681', '939']) {
    const r = rules(inPrimary(`About £${fig} a month.`));
    assert.ok(r.includes('source_figure'), fig);
  }
  assert.ok(!rules(inPrimary('About £12,399 a month.')).includes('source_figure'), 'a longer number is not the example');
  assert.ok(!rules(inPrimary('About £1,939 a month.')).includes('source_figure'));
  assert.ok(rules(inPrimary('Our fee is 15% + VAT.')).includes('source_fee_line'));
  assert.ok(rules(inPrimary('Our fee is plus VAT.')).includes('source_fee_line'));
  assert.ok(rules(inPrimary('15 per cent plus VAT')).includes('source_fee_line'));
  assert.ok(rules(withText(base, (a) => (a.script = 'Our fee is fifteen percent.'), '5b')).includes('source_fee_line'));
});

test('the operator’s own 15% is accepted when it is their fee, with no VAT line', () => {
  const own = pack({ feePct: 15 });
  assert.ok(runChecks(own).ok);
  assert.match(own.ads[0].texts.primary.join(' ') + own.ads[1].texts.primary.join(' ') + own.ads[2].texts.primary.join(' '), /15%/);
  const withVat = withText(own, (a) => (a.texts.primary[0] = `${a.texts.primary[0]} 15% + VAT`));
  assert.ok(rules(withVat).includes('source_fee_line'), 'VAT is rejected even at their own 15%');
  // 15% when the operator's fee is different, or unset, is the source brand's fee.
  const other = pack({ feePct: 12 });
  assert.ok(rules(withText(other, (a) => (a.texts.primary[0] = `${a.texts.primary[0]} Fee: 15%.`))).includes('source_fee_line'));
  const none = pack({ feePct: null });
  assert.ok(rules(withText(none, (a) => (a.texts.primary[0] = `${a.texts.primary[0]} Fee: 15%.`))).includes('source_fee_line'));
  // Any other percentage that is not their fee.
  assert.ok(rules(withText(other, (a) => (a.texts.primary[0] = `${a.texts.primary[0]} 71% occupied.`))).includes('fee_not_yours'));
});

test('figures: an unlabelled £ figure, two different figures, and a missing figure are rejected', () => {
  const base = pack();
  assert.ok(rules(withText(base, (a) => (a.texts.primary[0] = 'Landlords like you are getting about £2,350 a month. You stay the owner.'))).includes('figure_unlabelled'));
  assert.ok(rules(withText(base, (a) => (a.cardsText = ['£2,350 a month']))).includes('figure_unlabelled'));
  assert.ok(rules(withText(base, (a) => (a.script = 'It came to £2,350 a month.'), '5b')).includes('figure_unlabelled'));
  const two = withText(base, (a) => (a.texts.descriptions[0] = 'Example: a typical 3-bed in Cambridge, from 14 reports. Every property is different. About £900 a month.'));
  assert.ok(rules(two).includes('figure_multiple'));
  const noFigure = structuredClone(base);
  noFigure.figures = [];
  assert.ok(rules(noFigure).includes('figure_missing'));
  assert.ok(!rules(pack({ figure: false })).includes('figure_missing'), 'no figure, no £');
});

test('figures: a figure from a foreign area_key is rejected', () => {
  const c = pack();
  c.figures = [{ areaKey: 'CB1' }, { areaKey: 'NG7' }];
  const f = runChecks(c).failures.filter((x) => x.rule === 'figure_area');
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /NG7/);
  c.figures = [{ areaKey: 'cb1' }];
  assert.ok(rules(c).includes('figure_area'), 'keys are compared exactly: the pack stores the key it used');
});

test('lengths: red fails, amber passes with a warning', () => {
  const base = pack();
  const long = withText(base, (a) => (a.texts.headlines[0] = 'A headline that is far longer than forty characters allows'));
  assert.ok(rules(long).includes('length'));
  const tooLongPrimary = withText(base, (a) => (a.texts.primary[0] = `${'We look after your home. '.repeat(14)}You stay the owner.`));
  assert.ok(rules(tooLongPrimary).includes('length'));
  const amber = withText(base, (a) => (a.texts.headlines[0] = 'Is your tenant moving out soon'));
  const r = runChecks(amber);
  assert.ok(!r.failures.some((f) => f.rule === 'length'));
  assert.ok(r.warnings.some((w) => w.check === 'length' && /headline/.test(w.where)));
  assert.equal(r.ok, true, 'a warning does not fail the pack');
  assert.ok(rules(withText(base, (a) => (a.texts.descriptions = []))).includes('text_missing'));
  assert.ok(rules(withText(base, (a) => (a.texts.primary[0] = ''))).includes('length'));
});

test('banned claims, ranges, "you will earn" and guarantees are rejected everywhere', () => {
  const base = pack();
  const add = (s: string, angle: Angle = '3a') => withText(base, (a) => (a.texts.primary[1] = `${a.texts.primary[1]} ${s}`), angle);
  assert.ok(rules(add('You will earn a fortune.')).includes('you_will_earn'));
  assert.ok(rules(add("You'll earn more with us.")).includes('you_will_earn'));
  assert.ok(rules(add('Guaranteed income every month.')).includes('guarantee'));
  assert.ok(rules(add('We guarantee your bookings.')).includes('guarantee'));
  assert.ok(rules(add('We cannot guarantee anything.')).includes('guarantee'), 'any guarantee word is out of an ad');
  assert.ok(rules(add('No voids, ever.')).includes('banned_claim'));
  assert.ok(rules(add('Earn up to £3,000.')).length > 0);
  for (const range of ['£2,000-£3,000 a month', '£2,000 to £3,000', 'between £2,000 and £3,000', 'from £2,000 to £3,000', '£2k-3k', 'up to £3,000 a month']) {
    assert.ok(rules(add(range)).includes('income_range'), range);
  }
  assert.ok(rules(withText(base, (a) => (a.texts.headlines[0] = 'You will earn more'))).includes('you_will_earn'));
  assert.ok(rules(withText(base, (a) => (a.script = 'You will earn a lot.'), '5b')).includes('you_will_earn'));
  assert.ok(rules(withText(base, (a) => (a.cardsText = ['Guaranteed income']))).includes('guarantee'));
});

test('links: ?ad=, utm_content={{ad.id}} literally, the domain and the operator’s code', () => {
  const base = pack();
  const link = (angle: Angle) => base.ads.find((a) => a.angle === angle)!.link;
  const setLink = (fn: (l: string) => string) => withText(base, (a) => (a.link = fn(a.link)));
  assert.ok(rules(setLink((l) => l.replace(/\?ad=[^&]+&/, '?'))).includes('link_ad_code'));
  assert.ok(rules(setLink((l) => l.replace(/ad=SI-[^&]+/, 'ad=SI-AAAAAA-3A-1'))).includes('link_ad_code'));
  assert.ok(rules(setLink((l) => l.replace('utm_content={{ad.id}}', 'utm_content=123456'))).includes('link_placeholder'));
  assert.ok(rules(setLink((l) => l.replace('utm_content={{ad.id}}', 'utm_content=%7B%7Bad.id%7D%7D'))).includes('link_placeholder'));
  assert.ok(rules(setLink((l) => l.replace(/&utm_content=.*$/, ''))).includes('link_placeholder'));
  assert.ok(rules(setLink((l) => l.replace(DOMAIN, 'other.co.uk'))).includes('link_domain'));
  assert.ok(rules(setLink((l) => l.replace('https://', 'http://'))).includes('link_invalid'));
  assert.ok(rules(setLink(() => 'not a link')).includes('link_invalid'));
  assert.ok(rules(setLink((l) => l.replace('utm_source=facebook', 'utm_source=meta'))).includes('link_shape'));
  const foreign = structuredClone(base);
  foreign.operatorCode = 'AAAAAA';
  assert.ok(rules(foreign).includes('link_operator'));
  const dup = withText(base, (a) => {
    a.code = base.ads.find((x) => x.angle === '17')!.code;
  });
  assert.ok(rules(dup).includes('link_code'));
  assert.ok(rules(withText(base, (a) => (a.adName = 'Moving abroad'))).includes('ad_name'));
  assert.ok(rules(withText(base, (a) => (a.code = 'SI-ZZZ'))).includes('link_code'));
  const noDomain = structuredClone(base);
  noDomain.domain = '';
  assert.ok(rules(noDomain).includes('link_domain'));
  assert.match(link('5b'), /utm_content=\{\{ad\.id\}\}$/);
});

test('files: only 1080x1080, 1080x1350 and 1080x1920 pass', () => {
  assert.deepEqual(
    AD_IMAGE_SIZES.map((s) => `${s.width}x${s.height}`),
    ['1080x1080', '1080x1350', '1080x1920'],
  );
  const base = pack();
  for (const [w, h] of [[1080, 1081], [1079, 1080], [1200, 628], [1080, 1080.5], [0, 0], [1920, 1080]]) {
    const r = runChecks(withText(base, (a) => (a.files = [{ name: 'x.png', width: w, height: h }])));
    assert.ok(r.failures.some((f) => f.rule === 'file_size' && f.where.includes('x.png')), `${w}x${h}`);
  }
  assert.ok(runChecks(base).ok);
});

test('every failure says where and what, in words', () => {
  const c = withText(pack(), (a) => (a.texts.primary[0] = `${SRC} will earn you £2,399-£3,000.`));
  const r = runChecks(c);
  assert.equal(r.ok, false);
  for (const f of r.failures) {
    assert.ok(f.where.length > 0 && f.detail.length > 0 && CHECK_IDS.includes(f.check), JSON.stringify(f));
  }
  assert.equal(r.results.find((x) => x.check === 'source_brand')?.ok, false);
  assert.equal(r.results.find((x) => x.check === 'files')?.ok, true);
});

// ── 38b: the video check ──

const GOOD_VIDEOS: CheckVideo[] = [
  { name: 'notice-9x16.mp4', width: 1080, height: 1920, durationSeconds: 38.03, hasAudio: true, captionCount: 17 },
  { name: 'notice-4x5.mp4', width: 1080, height: 1350, durationSeconds: 38.03, hasAudio: true, captionCount: 17 },
  { name: 'notice-1x1.mp4', width: 1080, height: 1080, durationSeconds: 38.03, hasAudio: true, captionCount: 17 },
];
const withVideos = (videos: CheckVideo[] | undefined): CheckInput => ({ ...pack(), videos });
const videoRules = (videos: CheckVideo[] | undefined) => runChecks(withVideos(videos)).failures.filter((f) => f.check === 'video').map((f) => f.rule);
const changed = (i: number, patch: Partial<CheckVideo>): CheckVideo[] => GOOD_VIDEOS.map((v, k) => (k === i ? { ...v, ...patch } : v));

test('video: no `videos` input means no video check (generation time); the three good videos pass', () => {
  assert.deepEqual(videoRules(undefined), []);
  assert.deepEqual(videoRules(GOOD_VIDEOS), []);
  assert.equal(runChecks(withVideos(GOOD_VIDEOS)).ok, true);
  assert.deepEqual(Object.keys(VIDEO_SIZES), ['notice-9x16.mp4', 'notice-4x5.mp4', 'notice-1x1.mp4']);
});

test('video: sizes must be exactly 1080x1920, 1080x1350 and 1080x1080 by name', () => {
  assert.deepEqual(videoRules(changed(0, { height: 1919 })), ['video_size']);
  assert.deepEqual(videoRules(changed(1, { width: 1079 })), ['video_size']);
  assert.deepEqual(videoRules(changed(2, { height: 1350 })), ['video_size'], 'a 4:5 file named 1x1 is wrong');
  assert.deepEqual(videoRules(changed(0, { name: 'notice-9x16.mov' })).sort(), ['video_missing', 'video_name']);
});

test('video: a length over 0 and up to 60 seconds; an audio track; captions on screen', () => {
  assert.deepEqual(videoRules(changed(0, { durationSeconds: 0 })), ['video_length']);
  assert.deepEqual(videoRules(changed(0, { durationSeconds: Number.NaN })), ['video_length']);
  assert.deepEqual(videoRules(changed(0, { durationSeconds: MAX_VIDEO_SECONDS })), []);
  assert.deepEqual(videoRules(changed(0, { durationSeconds: MAX_VIDEO_SECONDS + 0.5 })), ['video_length']);
  assert.deepEqual(videoRules(changed(1, { hasAudio: false })), ['video_audio']);
  assert.deepEqual(videoRules(changed(2, { captionCount: 0 })), ['video_captions']);
  assert.deepEqual(videoRules(changed(2, { captionCount: 1 })), []);
});

test('video: all three files must be there when `videos` is given, even as an empty list', () => {
  assert.deepEqual(videoRules(GOOD_VIDEOS.slice(0, 2)), ['video_missing']);
  assert.deepEqual(videoRules([]), ['video_missing', 'video_missing', 'video_missing']);
});

test('video: every failure is plain words with the file it is about, and the result carries a video row', () => {
  const r = runChecks(withVideos(changed(0, { hasAudio: false, captionCount: 0 })));
  assert.equal(r.ok, false);
  const fs = r.failures.filter((f) => f.check === 'video');
  assert.equal(fs.length, 2);
  for (const f of fs) {
    assert.equal(f.where, 'ad 5b notice-9x16.mp4');
    assert.ok(f.detail.length > 10 && !/video_/.test(f.detail));
  }
  assert.deepEqual(r.results.find((x) => x.check === 'video'), { check: 'video', label: 'The video is made properly', ok: false, failures: 2, warnings: 0, ran: true });
});

test('mergeVideoChecks: replaces earlier video failures, keeps every other failure, recomputes ok and results', () => {
  const textFail = runChecks(withText(pack(), (a) => { a.texts.headlines = ['This is guaranteed income for you every month']; }));
  assert.equal(textFail.ok, false);
  const merged = mergeVideoChecks(textFail, changed(0, { hasAudio: false }));
  assert.deepEqual(merged.failures.filter((f) => f.check !== 'video'), textFail.failures);
  assert.deepEqual(merged.failures.filter((f) => f.check === 'video').map((f) => f.rule), ['video_audio']);
  assert.equal(merged.ok, false);
  // Doing it again with good videos drops the video failure but not the text one.
  const fixed = mergeVideoChecks(merged, GOOD_VIDEOS);
  assert.deepEqual(fixed.failures, textFail.failures);
  assert.equal(fixed.results.find((x) => x.check === 'video')?.ok, true);
  // From a good pack, good videos stay ok; from nothing it starts clean.
  assert.equal(mergeVideoChecks(runChecks(pack()), GOOD_VIDEOS).ok, true);
  assert.equal(mergeVideoChecks(null, GOOD_VIDEOS).ok, true);
  assert.equal(mergeVideoChecks(null, GOOD_VIDEOS).results.length, CHECK_IDS.length);
  assert.deepEqual(videoChecks(GOOD_VIDEOS), { failures: [], warnings: [] });
});

test('the video result says it RAN only when the video check really ran (approve fails closed on this)', () => {
  const notRun = runChecks(pack());
  assert.deepEqual(notRun.results.find((x) => x.check === 'video'), { check: 'video', label: 'The video is made properly', ok: true, failures: 0, warnings: 0 });
  assert.ok(notRun.results.every((x) => x.ran === undefined));
  const ran = runChecks({ ...pack(), videos: GOOD_VIDEOS });
  assert.equal(ran.results.find((x) => x.check === 'video')?.ran, true);
  assert.ok(ran.results.filter((x) => x.check !== 'video').every((x) => x.ran === undefined));
  assert.equal(mergeVideoChecks(notRun, GOOD_VIDEOS).results.find((x) => x.check === 'video')?.ran, true);
  assert.equal(mergeVideoChecks(null, []).results.find((x) => x.check === 'video')?.ran, true, 'an empty list is a run that fails (missing files)');
});

test('links, lead database route: /s/<slug> on this app’s host passes, the app’s host is not “the source brand”', () => {
  const p = leadDbPack();
  assert.match(p.ads[0].link, new RegExp(`^https://${APP_HOST.replace(/\./g, '\\.')}/s/${SLUG}\\?ad=`));
  const r = runChecks(p);
  assert.deepEqual(r.failures, [], JSON.stringify(r.failures));
  assert.equal(r.ok, true);
});

test('links, lead database route: a bare-host link, a wrong slug, a wrong host or a tweaked shape fails', () => {
  const p = leadDbPack();
  const setLink = (fn: (l: string, code: string) => string) => withText(p, (a) => (a.link = fn(a.link, a.code)));
  // A link in the Academy shape (no /s/<slug>) on a pack that says it is a calculator pack.
  assert.ok(rules(setLink((_l, code) => adLink({ domain: APP_HOST, code, operatorCode: OP }))).includes('link_shape'));
  assert.ok(rules(setLink((l) => l.replace(`/s/${SLUG}`, '/s/someone-else'))).includes('link_shape'));
  assert.ok(rules(setLink((l) => l.replace(`/s/${SLUG}`, ''))).includes('link_shape'));
  assert.ok(rules(setLink((l) => l.replace(APP_HOST, 'other.co.uk'))).includes('link_domain'));
  assert.ok(rules(setLink((l) => l.replace('utm_source=facebook', 'utm_source=meta'))).includes('link_shape'));
  assert.ok(rules(setLink((l) => l.replace('utm_content={{ad.id}}', 'utm_content=123'))).includes('link_placeholder'));
  assert.ok(rules(setLink((l) => l.replace(/\?ad=[^&]+&/, '?'))).includes('link_ad_code'));
  assert.ok(rules(setLink((l) => l.replace('https://', 'http://'))).includes('link_invalid'));
  // The source name is still refused anywhere else in the link (the slug, a query value).
  assert.ok(rules(setLink((l) => l.replace('utm_campaign=SI-', `utm_campaign=${'stay' + 'ful'}-SI-`))).includes('source_word'));
});

test('links, Academy route: an Academy pack still refuses a /s/<slug> link (no sitePath given)', () => {
  const p = pack();
  const bad = withText(p, (a) => (a.link = adLink({ domain: DOMAIN, sitePath: SLUG, code: a.code, operatorCode: OP })));
  assert.ok(rules(bad).includes('link_shape'));
  assert.deepEqual(runChecks(p).failures, []);
});
