import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELIGIBILITY_REASONS, LEADDB_ONLY_REASONS } from '../../../lib/ad-packs/eligibility.ts';
import { CHECK_IDS } from '../../../lib/ad-packs/checks.ts';
import { PACK_STATUSES } from '../../../lib/ad-packs/store-types.ts';
import { harness } from '../../../lib/ad-packs/test-store.ts';
import type { GenerateOk } from '../../../lib/ad-packs/generate-core.ts';
import {
  adCopyItems,
  adViewModel,
  areaPreviewView,
  brandOfSettings,
  brandProblemText,
  problemView,
  CHECK_PLAIN_IDS,
  copyTargetExists,
  eligibilityView,
  entryCardView,
  figureCallout,
  groupCardFiles,
  adHeading,
  AD_TITLES,
  downloadGroups,
  eligibilitySentence,
  plainRefusal,
  PLAIN_CODES,
  previewPathsOf,
  stageOf,
  regenIntro,
  approvalVm,
  isVideoFileName,
  pollStep,
  pollViewOf,
  POLL_GIVE_UP_MS,
  POLL_INTERVAL_MS,
  VIDEO_MAKING_TEXT,
  VOICE_UNAVAILABLE_TEXT,
  VIDEO_FILE_LABELS,
  videoCardView,
  videoFilesOf,
  videoViewOfSlot,
  videoVm,
  voiceCards,
  voiceVm,
  VOICE_STEP_HELP,
  NO_LOGO_TEXT,
} from './view.ts';
import { VOICES } from '../../../lib/ad-packs/voices.ts';
import { GENERATE_CODES, VIDEO_ACTION_CODES, VIDEO_MESSAGES, type PackView } from '../../../lib/ad-packs/generate-core.ts';
import { readyVideo } from '../../../lib/ad-packs/test-store.ts';

const OWNER = '3f9a2c11-1111-4111-8111-111111111111';

// Anything that looks like an internal code: snake_case, a dotted id, or a SCREAMING word.
const LOOKS_LIKE_A_CODE = /[a-z]+_[a-z]+|\b[A-Z]{2,}_[A-Z_]+\b|\b[a-z]+\.[a-z]+\.[a-z]+\b/;

// ── Eligibility ──

test('every reason becomes one plain sentence and one next step; no internal code leaks', () => {
  for (const r of ELIGIBILITY_REASONS) {
    const v = eligibilityView([r]);
    assert.equal(v.message, eligibilitySentence(r));
    assert.ok(v.message.length > 20 && /[.]$/.test(v.message), r);
    assert.ok(v.next && v.next.text.length > 10, `${r} has a next step`);
    const everything = [v.title, v.message, v.next?.text ?? '', v.next?.label ?? ''].join(' ');
    assert.ok(!everything.includes(r), `${r} is not shown`);
    assert.doesNotMatch(everything, LOOKS_LIKE_A_CODE, r);
    if (v.next?.href) assert.match(v.next.href, /^\/leads\//);
  }
});

test('several reasons: the most basic one is said, with a calm title; a non-owner is told who can do it', () => {
  const v = eligibilityView(['site_not_live', 'no_domain', 'switch_off']);
  assert.equal(v.title, 'Your Facebook ads are not ready yet');
  assert.equal(v.message, eligibilitySentence('site_not_live'));
  assert.equal(eligibilityView(['not_owner']).title, 'Only the account owner can do this');
  assert.equal(eligibilityView([]).next, null);
  assert.ok(eligibilityView([]).message.length > 20);
});




// ── Copy items ──

test('copy items carry each text exactly as stored: no trimming, no changes', () => {
  const ad = {
    adName: 'SI-3F9A2C-5B-1 · Tenant notice',
    link: 'https://brightstone.co.uk/?ad=SI-3F9A2C-5B-1&utm_source=facebook&utm_medium=paid_social&utm_campaign=SI-3F9A2C&utm_content={{ad.id}}',
    texts: { primary: ['  Has two leading spaces and a line\nbreak.  '], headlines: ['One', 'Two', 'Three'], descriptions: ['A description.'] },
  };
  const c = adCopyItems(ad);
  assert.equal(c.name.text, ad.adName);
  assert.equal(c.link.text, ad.link, '{{ad.id}} is copied untouched');
  assert.equal(c.primary[0].text, ad.texts.primary[0]);
  assert.deepEqual(c.headlines.map((h) => h.text), ad.texts.headlines);
  // The names we use on screen, not Facebook's.
  assert.deepEqual([c.name.label, c.link.label, c.primary[0].label, c.headlines[0].label, c.descriptions[0].label], ['Ad name', 'Website link', 'Main text', 'Headline', 'Extra line']);
  assert.deepEqual([c.name, c.link, ...c.primary, ...c.headlines, ...c.descriptions].map((i) => i.kind), ['name', 'link', 'primary', 'headline', 'headline', 'headline', 'description']);
});

test('copyTargetExists: only a text the ad really has', () => {
  const ad = { texts: { primary: ['a'], headlines: ['a', 'b'], descriptions: [] } };
  assert.equal(copyTargetExists(ad, 'headline', 1), true);
  assert.equal(copyTargetExists(ad, 'headline', 2), false);
  assert.equal(copyTargetExists(ad, 'description', 0), false);
  assert.equal(copyTargetExists(ad, 'name', 0), true);
  assert.equal(copyTargetExists(ad, 'link', 1), false);
  assert.equal(copyTargetExists(ad, 'primary', -1), false);
  assert.equal(copyTargetExists(ad, 'primary', 0.5), false);
});

// ── Files ──

test('files are grouped by picture with plain size words; the preview is the feed (4:5) file', () => {
  const names = ['3a-card2-9x16.png', '3a-card1-1x1.png', '3a-card1-4x5.png', '3a-card1-9x16.png', '3a-card2-4x5.png', 'junk.txt'].map((name) => ({ name, width: 1080, height: 1080 }));
  const g = groupCardFiles(names);
  assert.deepEqual(g.map((c) => c.card), [1, 2]);
  assert.equal(g[0].previewName, '3a-card1-4x5.png');
  assert.deepEqual(g[0].files.map((f) => f.size), ['Square', 'Feed', 'Full screen']);
  assert.equal(g[1].files.length, 2);
  assert.deepEqual(groupCardFiles([]), []);
  assert.equal(groupCardFiles([{ name: '3a-card3-9x16.png', width: 1, height: 1 }])[0].previewName, '3a-card3-9x16.png');
});

test('downloads are grouped by size, feed first: a picture ad gives its whole set per size, the video one file per size', () => {
  const card = (n: number) => ({ card: n, previewUrl: null, files: groupCardFiles(['4x5', '9x16', '1x1'].map((z) => ({ name: `3a-card${n}-${z}.png`, width: 1, height: 1 })))[0].files });
  const pics = downloadGroups({ cards: [card(1), card(2)], video: null });
  assert.deepEqual(pics.map((g) => g.label), ['Feed', 'Full screen', 'Square']);
  assert.deepEqual(pics[0].files, ['3a-card1-4x5.png', '3a-card2-4x5.png']);
  assert.ok(pics.every((g) => g.hint.length > 10 && !LOOKS_LIKE_A_CODE.test(g.hint)));
  const ready = readyVideo(OWNER, 'pack-1', 1);
  const vid = videoVm(ready, videoViewOfSlot(ready), () => 'https://x.example.test/');
  const vids = downloadGroups({ cards: [], video: vid });
  assert.deepEqual(vids.map((g) => g.files), [['notice-4x5.mp4'], ['notice-9x16.mp4'], ['notice-1x1.mp4']]);
  // Nothing to download while the video is being made.
  assert.deepEqual(downloadGroups({ cards: [], video: videoVm({ status: 'making' }, videoViewOfSlot({ status: 'making' }), () => null) }), []);
});

test('the three ads have plain names, numbered 1 to 3, and only the feed pictures and the video files are given view links', () => {
  assert.equal(adHeading('5b'), 'Ad 1: Your tenant has given notice');
  assert.equal(adHeading('3a'), 'Ad 2: Moving abroad');
  assert.equal(adHeading('17'), 'Ad 3: The renting rules have changed');
  assert.deepEqual((['5b', '3a', '17'] as const).map((a) => AD_TITLES[a].number), [1, 2, 3]);
  const files = { images: ['4x5', '9x16', '1x1'].flatMap((z) => [1, 2].map((n) => ({ name: `3a-card${n}-${z}.png`, path: `o/p/v1/3a-card${n}-${z}.png`, width: 1, height: 1, contentType: 'image/png', bytes: 1 }))), video: null };
  assert.deepEqual(previewPathsOf(files), ['o/p/v1/3a-card1-4x5.png', 'o/p/v1/3a-card2-4x5.png']);
  const vid = readyVideo(OWNER, 'pack-1', 1);
  assert.equal(previewPathsOf({ images: [], video: vid }).length, 4);
  assert.deepEqual(previewPathsOf({ images: [], video: { status: 'making' } }), []);
});

test('the stage follows the ads and the video: making until the video is ready, then review, then approved', () => {
  assert.equal(stageOf('start', null), 'start');
  assert.equal(stageOf('working', null), 'working');
  assert.equal(stageOf('checks_failed', null), 'problem');
  for (const v of ['queued', 'making', 'failed', 'coming'] as const) assert.equal(stageOf('preview', v), 'making', v);
  assert.equal(stageOf('preview', 'ready'), 'review');
  assert.equal(stageOf('approved', 'ready'), 'approved');
  assert.equal(stageOf('approved', 'failed'), 'approved');
});

test('make new ads: the free chance is said in plain words, or why there is none', () => {
  assert.match(regenIntro(1, null), /once for free/);
  assert.match(regenIntro(2, null), /2 times for free/);
  assert.equal(regenIntro(0, 'Because.'), 'Because.');
  assert.equal(regenIntro(0, null), PLAIN_CODES.regen_used);
});


test('a generated pack becomes three ad view models: 5b with its video slot and no cards, the others with five cards of three files', async () => {
  const h = harness();
  const made = (await h.engine.generatePack({
    ownerId: OWNER,
    by: 'operator',
    input: { areaKey: 'NG7', photos: [], brand: { company: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/logo.png', brandColour: '#1F6F5C', feePct: 12, photoUrl: null }, domain: 'brightstone.co.uk' },
  })) as GenerateOk;
  const view = (await h.engine.listPackForOwner(OWNER))!;
  assert.equal(made.status, 'preview');
  const vms = view.ads.map((a) => adViewModel(a, (path) => `https://signed.example.test/${path}`));
  assert.deepEqual(vms.map((v) => v.angle), ['5b', '3a', '17']);
  const b = vms[0];
  assert.equal(b.video?.card.state, 'queued');
  assert.equal(b.video?.card.poll, true);
  assert.equal(b.cards.length, 0);
  for (const v of vms.slice(1)) {
    assert.equal(v.video, null);
    assert.equal(v.cards.length, 5);
    assert.ok(v.cards.every((c) => c.files.length === 3 && c.previewUrl?.includes('-4x5.png')));
  }
  assert.deepEqual(vms.map((v) => v.heading), ['Ad 1: Your tenant has given notice', 'Ad 2: Moving abroad', 'Ad 3: The renting rules have changed']);
  assert.ok(vms.every((v) => v.copy.primary.length > 0 && v.copy.headlines.length > 0 && v.copy.descriptions.length > 0 && v.adName.startsWith('SI-')));
  // Nothing to download until the video is ready; the picture ads download in three sizes.
  assert.deepEqual(vms[0].downloads, []);
  assert.deepEqual(vms[1].downloads.map((g) => g.files.length), [5, 5, 5]);
  // The labelled example figure is available to show.
  const fig = figureCallout(view.pack.figures);
  assert.ok(fig);
  assert.match(fig!.label, /^Example: a typical 3-bed in /);
});

// ── Checks failed ──

test('every check has a plain sentence of its own, and the problem screen never shows a code', () => {
  assert.deepEqual([...CHECK_PLAIN_IDS].sort(), [...CHECK_IDS].sort());
  const v = problemView({ failures: CHECK_IDS.map((check) => ({ check, rule: 'brand_logo', where: 'pack', detail: 'It mentions Someone Else.' })) });
  assert.equal(v.title, 'We could not finish your ads');
  assert.equal(v.lines.length, CHECK_IDS.length);
  const everything = [v.title, ...v.lines, v.contact].join(' ');
  for (const id of CHECK_IDS) if (id.includes('_')) assert.ok(!everything.includes(id), id);
  assert.doesNotMatch(everything, LOOKS_LIKE_A_CODE);
  assert.doesNotMatch(everything, /Someone Else|brand_logo/, 'the detail of a failure is not shown');
  assert.match(v.contact, /get in touch/i);
  // Repeated failures of one check say it once; none at all still says something.
  assert.equal(problemView({ failures: [{ check: 'length' }, { check: 'length' }] }).lines.length, 1);
  assert.equal(problemView(null).lines.length, 1);
  assert.equal(problemView({ failures: [{ check: 'not_a_check' }] }).lines.length, 1);
});

// ── The area and the brand ──

test('area preview: the home size we will show is explained and not a choice; a fall-back and a thin area are said plainly', () => {
  const ok = areaPreviewView({ areaKey: 'NG7', areaLabel: 'Lenton, Nottingham', fellBack: false, bedrooms: 3, samples: 14 });
  assert.equal(ok.ok, true);
  assert.equal(ok.bedrooms, 3);
  assert.match(ok.text, /typical 3-bedroom home, the most common size in Lenton, Nottingham\. We pick this for you\./);
  assert.doesNotMatch(ok.text, /report|sample/i);
  assert.match(areaPreviewView({ areaKey: 'NG', areaLabel: 'Nottingham', fellBack: true, bedrooms: 2, samples: 1 }).text, /did not have enough information.*wider area, Nottingham/);
  const thin = areaPreviewView({ error: 'not_enough_data' });
  assert.equal(thin.ok, false);
  assert.equal(thin.bedrooms, null);
  assert.equal(thin.text, PLAIN_CODES.not_enough_data);
  assert.doesNotMatch(thin.text, /not_enough_data/);
});

test('brand: read from the website’s settings; a logo that is not https is no logo; company and colour are the only blockers', () => {
  const base = { companyName: ' Brightstone Stays ', logoUrl: 'https://cdn.example.test/l.png', brandColour: '#1F6F5C', managementFeePct: 12, areas: [' Nottingham ', ''], photoUrl: ' ' };
  const ok = brandOfSettings(base);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.brand, { company: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/l.png', brandColour: '#1f6f5c', feePct: 12, areas: ['Nottingham'], photoUrl: null });
  assert.equal(brandOfSettings({ ...base, logoUrl: 'http://cdn.example.test/l.png' }).brand.logoUrl, null);
  assert.equal(brandOfSettings({ ...base, logoUrl: null }).problems.length, 0, 'a missing logo is the operator’s choice (type only)');
  assert.deepEqual(brandOfSettings({ ...base, companyName: '' }).problems, ['company']);
  assert.deepEqual(brandOfSettings({ ...base, brandColour: 'blue' }).problems, ['colour']);
  assert.equal(brandOfSettings({ ...base, managementFeePct: null }).brand.feePct, null);
  for (const p of ['company', 'colour'] as const) assert.doesNotMatch(brandProblemText(p), LOOKS_LIKE_A_CODE);
});

test('the figure callout reads only the two sentences; nothing, or nothing labelled, is null', () => {
  assert.deepEqual(figureCallout([{ label: 'Example: a typical 3-bed in X, from 14 reports. Every property is different.', sentence: 'Example: … about £2,350 a month.', amount: 2350 }]), { label: 'Example: a typical 3-bed in X, from 14 reports. Every property is different.', sentence: 'Example: … about £2,350 a month.' });
  assert.equal(figureCallout([]), null);
  assert.equal(figureCallout(null), null);
  assert.equal(figureCallout([{ sentence: 'no label' }]), null);
  assert.equal(figureCallout(['x']), null);
});

// ── The entry card ──

test('the entry card says something plain for every pack status, with no code', () => {
  for (const status of [null, ...PACK_STATUSES]) {
    const v = entryCardView(status);
    assert.ok(v.title && v.body && v.cta, String(status));
    assert.doesNotMatch(`${v.title} ${v.body} ${v.cta}`, LOOKS_LIKE_A_CODE, String(status));
  }
  assert.equal(entryCardView(null).title, 'Your Facebook ads');
  assert.equal(entryCardView(null).cta, 'Make my ads');
  assert.equal(entryCardView('preview').cta, 'Look at my ads');
  assert.equal(entryCardView('approved').title, 'Your ads are ready to use');
});


// ── The voice step and the video (38b) ──

test('the voice step: three cards from the voice list, each with its free sample clip and a few plain words', () => {
  const cards = voiceCards();
  assert.deepEqual(cards.map((c) => c.key), ['jane', 'olivia', 'oliver']);
  for (const c of cards) {
    assert.ok(c.label && c.description.length > 10 && c.description.length < 40, 'short enough for one line on a phone');
    assert.match(c.previewUrl, /^https:\/\//, 'the sample plays from a secure address');
    assert.equal(c.previewUrl, VOICES.find((v) => v.key === c.key)!.previewUrl);
  }
  assert.equal(VOICE_STEP_HELP, 'Tap the play button to hear each voice.');
  assert.equal(NO_LOGO_TEXT, 'Your website has no logo, so we’ll show your company name instead.');
});

const pending = { status: 'queued', code: null, poll: true, canRetry: false, message: null } as const;

test('the video card: making, ready, and each failure has one plain sentence and the right action', () => {
  const making = videoCardView(pending);
  assert.equal(making.poll, true);
  assert.equal(making.action, 'none');
  assert.equal(making.message, VIDEO_MAKING_TEXT);
  assert.equal(VIDEO_MAKING_TEXT, 'Your video is being made. This takes about 5 to 10 minutes. You can close this page: we’ll email you when it’s ready.');
  assert.equal(videoCardView({ ...pending, status: 'making' }).state, 'making');

  const ready = videoCardView({ status: 'ready', code: null, poll: false, canRetry: false, message: null });
  assert.deepEqual([ready.poll, ready.message, ready.action], [false, null, 'none']);

  const voice = videoCardView({ status: 'failed', code: 'voice_unavailable', poll: false, canRetry: false, message: VIDEO_MESSAGES.voice_unavailable });
  assert.equal(voice.action, 'change_voice');
  assert.equal(voice.message, VOICE_UNAVAILABLE_TEXT);

  const retry = videoCardView({ status: 'failed', code: 'sandbox_failed', poll: false, canRetry: true, message: VIDEO_MESSAGES.video_failed });
  assert.equal(retry.action, 'retry');
  assert.match(retry.message ?? '', /Please try again/);

  const stuck = videoCardView({ status: 'failed', code: 'bad_brief', poll: false, canRetry: false, message: VIDEO_MESSAGES.video_failed });
  assert.equal(stuck.action, 'contact');
  assert.doesNotMatch(stuck.message ?? '', /try again/i, 'there is no button to press');

  assert.equal(videoCardView({ status: 'coming', code: null, poll: false, canRetry: false, message: null }).action, 'contact');
  // Whatever the code, nothing internal is shown and nothing says "coming soon" or "later release".
  for (const code of ['sandbox_failed', 'monthly_cap', 'voice_quota', 'timeout', 'voice_unavailable', null]) {
    for (const canRetry of [true, false]) {
      const v = videoCardView({ status: 'failed', code, poll: false, canRetry, message: null });
      const everything = `${v.heading} ${v.message}`;
      assert.doesNotMatch(everything, LOOKS_LIKE_A_CODE, `${code}: ${everything}`);
      assert.doesNotMatch(everything, /coming soon|later release|arrives/i);
    }
  }
});

test('the video slot of an ad stands in for the live state when there is none', () => {
  assert.equal(videoViewOfSlot(null).status, 'coming');
  assert.equal(videoViewOfSlot({ status: 'coming' }).status, 'coming');
  assert.deepEqual(videoViewOfSlot({ status: 'queued' }), { status: 'queued', code: null, poll: true, canRetry: false, message: null });
  assert.equal(videoViewOfSlot({ status: 'making' }).poll, true);
  assert.equal(videoViewOfSlot({ status: 'failed', code: 'voice_unavailable' }).code, 'voice_unavailable');
  assert.equal(videoViewOfSlot(readyVideo(OWNER, 'p', 1)).poll, false);
});

test('the video files: three sizes in order with their plain labels, the poster, and only for a ready video', () => {
  const ready = readyVideo(OWNER, 'pack-1', 1);
  const shuffled = { ...ready, videos: [...ready.videos].reverse() };
  const out = videoFilesOf(shuffled);
  assert.deepEqual(out.files.map((f) => f.label), ['Full screen', 'Feed', 'Square']);
  assert.deepEqual(out.files.map((f) => f.ratio), ['9:16', '4:5', '1:1']);
  assert.equal(out.poster, 'notice-poster.png');
  assert.equal(out.seconds, 38);
  assert.deepEqual(videoFilesOf({ status: 'queued' }), { files: [], poster: null, seconds: null });
  assert.deepEqual(videoFilesOf(null), { files: [], poster: null, seconds: null });
  // A name that is not one of the three is not offered; inherited object keys are not names.
  const odd = videoFilesOf({ ...ready, videos: [...ready.videos, { ...ready.videos[0], name: 'voice.mp3' }, { ...ready.videos[0], name: 'toString' }] });
  assert.equal(odd.files.length, 3);
  assert.ok(isVideoFileName('notice-1x1.mp4') && !isVideoFileName('toString') && !isVideoFileName('notice-poster.png') && !isVideoFileName(3));
  assert.deepEqual(Object.keys(VIDEO_FILE_LABELS), ['notice-9x16.mp4', 'notice-4x5.mp4', 'notice-1x1.mp4']);
});

test('videoVm: view links only for a ready video, by file name', () => {
  const ready = readyVideo(OWNER, 'pack-1', 1);
  const vm = videoVm(ready, videoViewOfSlot(ready), (p) => `https://signed.example.test/${p}`);
  assert.equal(vm.card.state, 'ready');
  assert.deepEqual(Object.keys(vm.urls).sort(), ['notice-1x1.mp4', 'notice-4x5.mp4', 'notice-9x16.mp4', 'notice-poster.png']);
  assert.equal(vm.urls['notice-9x16.mp4'], `https://signed.example.test/${OWNER}/pack-1/v1/notice-9x16.mp4`);
  const waiting = videoVm({ status: 'queued' }, videoViewOfSlot({ status: 'queued' }), () => 'https://x.example.test/');
  assert.deepEqual([waiting.files, waiting.urls], [[], {}]);
  // A signer that cannot sign leaves the link out.
  assert.deepEqual(videoVm(ready, videoViewOfSlot(ready), () => null).urls, {});
});

test('every refusal code has a plain sentence of its own, and the sentence for the code wins over the generator’s words', () => {
  const codes = [...VIDEO_ACTION_CODES, 'cost_cap', 'monthly_cap', 'spend_unknown', ...GENERATE_CODES, 'video_pending', 'video_failed'];
  for (const code of codes) {
    const text = PLAIN_CODES[code];
    assert.ok(text && /[.]$/.test(text) && text.length > 20, code);
    assert.doesNotMatch(text, LOOKS_LIKE_A_CODE, code);
    assert.doesNotMatch(text, /\b(?:pack|version|regenerat\w*|checks?|render\w*|codes?|allowance|hash)\b/i, code);
  }
  assert.equal(plainRefusal('same_voice', 'A short but real sentence.'), PLAIN_CODES.same_voice);
  assert.equal(plainRefusal('nope', 'A short but real sentence.'), 'A short but real sentence.');
  assert.equal(plainRefusal('nope', 'Your pack is not ready.'), 'Something went wrong. Please try again.');
  assert.equal(plainRefusal('nope', undefined), 'Something went wrong. Please try again.');
  assert.equal(plainRefusal(undefined, 'Error: x at /var/task/a.js:1:2 and more words'), 'Something went wrong. Please try again.');
});

/** A PackView with only the parts the video screen reads. */
function packView(over: { video: PackView['video']; approval?: PackView['approval']; voice?: Partial<PackView['voice']> }): PackView {
  return {
    pack: { version: 3 } as PackView['pack'],
    ads: [],
    showAds: true,
    olderCodes: [],
    freeRegensLeft: 1,
    render: null,
    video: over.video,
    voice: { key: 'jane', changesLeft: 1, canChange: true, free: false, blocked: null, ...over.voice },
    approval: over.approval ?? { ok: true },
  };
}

test('approve is off, with a plain reason, while the video is being made, failed or missing, and on when it is ready', () => {
  const v = (status: PackView['video']['status'], code: string | null = null, canRetry = false): PackView['video'] => ({ status, code, message: null, poll: status === 'queued' || status === 'making', canRetry });
  assert.deepEqual(approvalVm(packView({ video: v('ready') })), { ok: true });
  const waiting = approvalVm(packView({ video: v('making'), approval: { ok: false, code: 'video_pending', message: VIDEO_MESSAGES.video_pending } }));
  assert.deepEqual(waiting, { ok: false, message: 'This button works as soon as your video is ready.' });
  const failed = approvalVm(packView({ video: v('failed', 'bad_brief'), approval: { ok: false, code: 'video_failed', message: VIDEO_MESSAGES.video_failed } }));
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.ok ? '' : failed.message, /try again/i, 'there is no retry button for this one');
  const missing = approvalVm(packView({ video: v('coming'), approval: { ok: false, code: 'video_pending', message: VIDEO_MESSAGES.video_pending } }));
  assert.match(missing.ok ? '' : missing.message, /Your video is not ready yet/);
  const checks = approvalVm(packView({ video: v('ready'), approval: { ok: false, code: 'not_preview', message: 'Only a pack that is ready to look at can be approved.' } }));
  assert.deepEqual(checks, { ok: false, message: PLAIN_CODES.not_preview });
});

test('the voice step says how many changes are left, and that a free change is free', () => {
  const base = { key: 'jane', changesLeft: 1, canChange: true, free: false, blocked: null } as const;
  assert.equal(voiceVm(base).note, 'You can change the voice once before you move on.');
  assert.equal(voiceVm({ ...base, changesLeft: 3 }).note, 'You can change the voice 3 times before you move on.');
  assert.equal(voiceVm({ ...base, changesLeft: 0, canChange: false, blocked: { code: 'voice_limit_used', message: VIDEO_MESSAGES.voice_limit_used } }).note, 'You have already used your voice change.');
  assert.equal(voiceVm({ ...base, changesLeft: 0, free: true }).note, 'The first voice could not be used, so this change is free.');
  const blocked = voiceVm({ ...base, canChange: false, blocked: { code: 'video_running', message: VIDEO_MESSAGES.video_running } });
  assert.equal(blocked.blocked, PLAIN_CODES.video_running);
  assert.equal(voiceVm(base).currentLabel, 'Jane');
  assert.equal(voiceVm({ ...base, key: null }).currentLabel, null);
});

test('polling stops when the video settles or the pack moves on, waits otherwise, and gives up after fifteen minutes', () => {
  assert.equal(POLL_INTERVAL_MS, 8000);
  assert.equal(POLL_GIVE_UP_MS, 15 * 60 * 1000);
  assert.equal(pollStep({ startedMs: 0, nowMs: 8000, poll: true }), 'wait');
  assert.equal(pollStep({ startedMs: 0, nowMs: 8000, poll: false }), 'settled');
  assert.equal(pollStep({ startedMs: 0, nowMs: 8000, poll: true, versionChanged: true }), 'settled');
  assert.equal(pollStep({ startedMs: 0, nowMs: POLL_GIVE_UP_MS - 1, poll: true }), 'wait');
  assert.equal(pollStep({ startedMs: 0, nowMs: POLL_GIVE_UP_MS, poll: true }), 'give_up');
  // A video that settled at the very end is a reload, not "taking longer".
  assert.equal(pollStep({ startedMs: 0, nowMs: POLL_GIVE_UP_MS + 5000, poll: false }), 'settled');
});

test('a poll answer holds the version, the video card, the approve state and the voice step, and no ids, paths or codes', () => {
  const view = packView({ video: { status: 'failed', code: 'sandbox_failed', message: VIDEO_MESSAGES.video_failed, poll: false, canRetry: true }, approval: { ok: false, code: 'video_failed', message: VIDEO_MESSAGES.video_failed } });
  const out = pollViewOf(view);
  assert.deepEqual(Object.keys(out).sort(), ['approval', 'version', 'video', 'voice']);
  assert.equal(out.version, 3);
  assert.equal(out.video.action, 'retry');
  assert.doesNotMatch(JSON.stringify(out), /sandbox_failed|video_failed|[a-z]+_[a-z]+/);
});

test('the lead database reasons are plain sentences with a next step, no code leaks (Batch 55)', () => {
  for (const r of LEADDB_ONLY_REASONS) {
    const v = eligibilityView([r]);
    assert.equal(v.message, eligibilitySentence(r));
    assert.ok(v.message.length > 20 && /[.]$/.test(v.message), r);
    assert.ok(v.next && v.next.text.length > 10, `${r} has a next step`);
    const everything = [v.title, v.message, v.next?.text ?? '', v.next?.label ?? ''].join(' ');
    assert.ok(!everything.includes(r), `${r} is not shown`);
    assert.doesNotMatch(everything, LOOKS_LIKE_A_CODE, r);
    assert.doesNotMatch(everything, /!/, r);
    if (v.next?.href) assert.match(v.next.href, /^\/leads\//);
  }
  assert.equal(new Set(LEADDB_ONLY_REASONS.map((r) => eligibilitySentence(r))).size, LEADDB_ONLY_REASONS.length, 'each reads differently');
  assert.equal(eligibilityView(['no_card', 'not_allowed']).message, eligibilitySentence('no_card'), 'the most basic is said');
});

test('Batch 55 step 5 (A7): each lead database ad says who it is for; the hint says where to add a logo, only without one, never a link', async () => {
  const { conceptLine, profileHint, adViewModel } = await import('./view.ts');
  assert.equal(conceptLine('5b'), 'For landlords whose tenant is leaving');
  assert.match(conceptLine('3a'), /moving abroad/);
  assert.match(conceptLine('17'), /renting rules/);
  assert.equal(profileHint({ logoUrl: 'https://x.test/l.png' }), null);
  const h = profileHint({ logoUrl: null })!;
  assert.equal(h.href, undefined, 'no link away from the ads screen');
  assert.equal(h.label, undefined);
  assert.match(h.text, /logo/);
  assert.match(h.text, /More options/);
  assert.doesNotMatch(h.text, /calculator|website|settings|\bpage\b|areas/i);
  const ad = { id: 'a', angle: '17' as const, adName: 'x', link: 'https://x.test/', texts: { primary: [], headlines: [], descriptions: [] }, files: { images: [], video: { status: 'queued' as const } } };
  const ld = adViewModel(ad, () => null, null, { route: 'leaddb' });
  assert.equal(ld.concept, conceptLine('17'));
  assert.ok(ld.video, 'the loupe is a video on the lead database route');
  const academy = adViewModel({ ...ad, files: { images: [], video: null } }, () => null, null);
  assert.ok(!('concept' in academy));
  assert.equal(academy.video, null);
});

// ── Batch 55 step 5 (Phase 3): the coverage picker's lists ──

test('coverage picker: the customer’s own areas first, chosen places left out, never more than ten', async () => {
  const { addCoverageKey, coverageAddOptions, coverageCountText, coverageStart } = await import('./view.ts');
  const options = ['LS', 'YO', 'HG', 'NG'].map((k) => ({ areaKey: k, label: k }));
  const split = coverageAddOptions(options, ['HG', 'ZZ', 'LS'], ['LS']);
  assert.deepEqual(split.yours.map((o) => o.areaKey), ['HG']);
  assert.deepEqual(split.rest.map((o) => o.areaKey), ['YO', 'NG']);
  assert.deepEqual(addCoverageKey(['LS'], 'LS'), ['LS']);
  assert.deepEqual(addCoverageKey(['LS'], 'YO'), ['LS', 'YO']);
  const ten = Array.from({ length: 10 }, (_, i) => `K${i}`);
  assert.deepEqual(addCoverageKey(ten, 'X1'), ten);
  assert.equal(coverageCountText(1), '1 of 10 place chosen.');
  assert.equal(coverageCountText(3), '3 of 10 places chosen.');
  assert.deepEqual(coverageStart({ mode: 'uk', keys: [], suggested: ['HG', 'ZZ'], options }), { mode: 'uk', keys: [], preset: ['HG'] });
  assert.deepEqual(coverageStart({ mode: 'areas', keys: ['YO', 'ZZ', 'YO'], suggested: [], options }), { mode: 'areas', keys: ['YO'], preset: [] });
});

test('brand problems: the lead database route says the brand card’s own field messages, with no link; the Academy wording is unchanged', async () => {
  const v = await import('./view.ts');
  assert.equal(brandProblemText('company', 'leaddb'), 'Add your company name.');
  assert.equal(brandProblemText('colour', 'leaddb'), 'Pick a brand colour.');
  assert.equal(brandProblemText('company', 'leaddb'), v.BRAND_NAME_MISSING);
  assert.equal(brandProblemText('colour', 'leaddb'), v.BRAND_COLOUR_MISSING);
  for (const p of ['company', 'colour'] as const) {
    assert.doesNotMatch(brandProblemText(p, 'leaddb'), /get in touch|calculator|website|settings|\bpage\b/i);
    assert.equal(brandProblemText(p), brandProblemText(p, 'academy'));
    assert.match(brandProblemText(p), /get in touch/);
  }
  // The Academy sentences are pinned word for word.
  assert.equal(brandProblemText('company'), 'Your website has no company name yet, so we cannot put it on your ads. Please get in touch and we will sort it out.');
  assert.equal(brandProblemText('colour'), 'Your website has no brand colour yet, so we cannot colour your ads. Please get in touch and we will sort it out.');
  assert.ok(!('BRAND_FIRST_LINK' in v) && !('CALCULATOR_SETTINGS_HREF' in v), 'no link to the calculator page is left');
});

test('the brand card (lead database route) never says website, calculator, settings or page', async () => {
  const v = await import('./view.ts');
  const said = [v.BRAND_CARD_TITLE, v.BRAND_CARD_HELP, v.BRAND_NAME_LABEL, v.BRAND_NAME_MISSING, v.BRAND_NAME_TOO_LONG, v.BRAND_NAME_REFUSED, v.BRAND_COLOUR_MISSING, v.BRAND_LOGO_LABEL, v.BRAND_LOGO_NONE, v.BRAND_LOGO_ADD, v.BRAND_LOGO_CHANGE, v.BRAND_LOGO_ADDING, v.BRAND_LOGO_SAVED, v.BRAND_LOGO_HELP, v.BRAND_LOGO_TOO_BIG, v.BRAND_LOGO_FAILED, v.BRAND_SAVE_FAILED];
  for (const s of said) {
    assert.ok(s.length > 0);
    assert.doesNotMatch(s, /website|calculator|settings|\bpages?\b/i, s);
    assert.doesNotMatch(s, LOOKS_LIKE_A_CODE, s);
  }
  assert.equal(v.BRAND_LOGO_MAX_BYTES, 900_000);
});
